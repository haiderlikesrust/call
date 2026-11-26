import test from 'node:test';
import assert from 'node:assert/strict';
import { rules } from '../server/config.ts';
import { aging, burnFor, drain, eligibility, followFactor, holdFactor, reconcile, rewardFor, score, splitIntake, toUnits, type Candidate } from '../server/rewards.ts';

const SUPPLY = 1_000_000_000n * 1_000_000n;
const pct = (p: number) => (SUPPLY * BigInt(Math.round(p * 10_000))) / 1_000_000n;

test('80/20 split loses nothing to rounding', () => {
  for (const n of [0n, 1n, 3n, 7n, 999_999n, 123_456_789_123n]) {
    const s = splitIntake(n, rules);
    assert.equal(s.reward + s.burn, n);
  }
  assert.deepEqual(splitIntake(1_000n, rules), { reward: 800n, burn: 200n });
});

test('holding and followers both raise the reward, strictly, until their caps', () => {
  let last = -1;
  for (const p of [0.01, 0.05, 0.1, 0.5, 0.99]) { const v = holdFactor(pct(p), SUPPLY, rules); assert.ok(v > last); last = v; }
  assert.equal(holdFactor(pct(1), SUPPLY, rules), 1);
  assert.equal(holdFactor(pct(5), SUPPLY, rules), 1);
  last = -1;
  for (const f of [0, 10, 100, 1_000, 10_000]) { const v = followFactor(f, rules); assert.ok(v > last); last = v; }
  assert.equal(followFactor(10_000, rules), 1);
  assert.equal(followFactor(9_000_000, rules), 1);
  assert.equal(holdFactor(0n, SUPPLY, rules), 0);
});

test('nobody can take more than the cap, and the pot can never be overdrawn', () => {
  const pot = toUnits(1_000_000);
  assert.equal(rewardFor(pot, 1, 1, rules), toUnits(25_000));
  assert.equal(rewardFor(pot, 99, 1, rules), toUnits(25_000));
  assert.equal(rewardFor(pot, 1, aging(1e9, rules), rules), toUnits(50_000));
  assert.equal(rewardFor(0n, 1, 1, rules), 0n);
  const queue = Array.from({ length: 500 }, (_, i) => ({ id: String(i), score: 1, readyAt: 0 }));
  const d = drain(queue, { reward: pot, burn: toUnits(250_000) }, 1e12, rules);
  assert.ok(d.reward >= 0n && d.burn >= 0n);
  assert.equal(d.reward + d.payments.reduce((n, p) => n + p.amount, 0n), pot);
  assert.equal(d.burn + d.payments.reduce((n, p) => n + p.burn, 0n), toUnits(250_000));
});

test('rewards move with the reward pool: double the pool, double the reward', () => {
  const s = score(pct(0.3), SUPPLY, 2_000, rules);
  const one = rewardFor(toUnits(100_000), s, 1, rules);
  const diff = rewardFor(toUnits(200_000), s, 1, rules) - 2n * one;
  assert.ok(diff >= 0n && diff <= 1n);
  const queue = Array.from({ length: 4 }, (_, i) => ({ id: String(i), score: s, readyAt: i }));
  const paid = drain(queue, { reward: toUnits(100_000), burn: 0n }, 4, rules).payments.map((p) => p.amount);
  for (let i = 1; i < paid.length; i++) assert.ok(paid[i]! < paid[i - 1]!, 'each payout leaves a smaller pool');
});

test('every payment releases a burn in the same 80:20 ratio', () => {
  assert.equal(burnFor(800n, 10_000n, rules), 200n);
  assert.equal(burnFor(800n, 50n, rules), 50n);
  const d = drain([{ id: 'a', score: 0.5, readyAt: 0 }], { reward: toUnits(800_000), burn: toUnits(200_000) }, 0, rules);
  assert.equal(d.payments[0]!.burn * 4n, d.payments[0]!.amount);
});

test('an empty pot pays nobody; a refill pays oldest first', () => {
  const q = [{ id: 'new', score: 0.5, readyAt: 200 }, { id: 'old', score: 0.5, readyAt: 100 }];
  assert.equal(drain(q, { reward: 0n, burn: 0n }, 300, rules).payments.length, 0);
  assert.equal(drain(q, { reward: toUnits(rules.potFloor) - 1n, burn: 0n }, 300, rules).payments.length, 0);
  assert.deepEqual(drain(q, { reward: toUnits(1_000_000), burn: 0n }, 300, rules).payments.map((p) => p.id), ['old', 'new']);
});

test('a reward under the minimum keeps its place without blocking the queue', () => {
  const q = [{ id: 'tiny', score: 0.0001, readyAt: 1 }, { id: 'big', score: 1, readyAt: 2 }];
  assert.deepEqual(drain(q, { reward: toUnits(100_000), burn: 0n }, 3, rules).payments.map((p) => p.id), ['big']);
});

test('waiting in the queue adds weight, up to a cap', () => {
  assert.equal(aging(0, rules), 1);
  assert.ok(aging(4, rules) > aging(1, rules));
  assert.equal(aging(1_000, rules), rules.agingCap);
  assert.equal(aging(-5, rules), 1);
});

test('reconcile: deposits split 80/20, withdrawals shrink both pots, totals always match the wallet', () => {
  const pots = { reward: 800n, burn: 200n };
  const up = reconcile(2_000n, pots, rules);
  assert.deepEqual([up.reward, up.burn, up.intake], [1_600n, 400n, 1_000n]);
  for (const chain of [0n, 1n, 333n, 999n, 1_000n, 1_001n, 123_457n]) {
    const r = reconcile(chain, pots, rules);
    assert.equal(r.reward + r.burn, chain);
    assert.ok(r.reward >= 0n && r.burn >= 0n);
  }
  assert.equal(reconcile(0n, { reward: 0n, burn: 0n }, rules).intake, 0n);
});

test('every qualifying callout starts from the base share, and bag and reach add to it', () => {
  const pot = toUnits(1_000_000);
  const cap = (pot * BigInt(rules.maxPotShareBps)) / 10_000n;
  const smallest = rewardFor(pot, score(pct(0.01), SUPPLY, rules.minFollowers, rules), 1, rules);
  const base = (cap * BigInt(Math.round(rules.baseScore * 1e9))) / 1_000_000_000n;
  assert.ok(smallest >= base, `${smallest} vs base ${base}`);
  assert.ok(smallest < base + cap / 50n, 'barely above the base');
  const bigger = rewardFor(pot, score(pct(0.25), SUPPLY, 500, rules), 1, rules);
  assert.ok(bigger * 2n > smallest * 3n, 'a bigger bag and following earns clearly more');
  assert.equal(rewardFor(pot, score(pct(1), SUPPLY, rules.followersFull, rules), 1, rules), cap);
  // Below the entry rules there is no base: the lookup shows what little the raw score would give.
  assert.ok(score(pct(0.001), SUPPLY, 1_000, rules) < rules.baseScore);
  assert.ok(score(pct(1), SUPPLY, rules.minFollowers - 1, rules) < rules.baseScore + 0.5);
  assert.equal(score(0n, SUPPLY, 1_000, rules), 0);
});

test('eligibility', () => {
  const now = 1e12;
  const ok: Candidate = { wallet: 'w', balance: pct(0.5), supply: SUPPLY, followers: 500, accountCreatedAt: now - 30 * 86_400_000, createdAt: now - 1000, isDev: false, isGroup: false, isPumpUser: true, lowQuality: false };
  const ctx = { start: now - 1e6, now, excluded: false, lastRewardedAt: null, hasOpen: false };
  const t = (c: Partial<Candidate>, x: Partial<typeof ctx> & { lastRewardedAt?: number | null } = {}) => eligibility({ ...ok, ...c }, { ...ctx, ...x }, rules);
  assert.equal(t({}), null);
  assert.equal(t({ balance: 0n }), 'not-holder');
  assert.equal(t({ balance: pct(0.01) - 1n }), 'low-holding');
  assert.equal(t({ balance: pct(0.01) }), null);
  assert.equal(t({ followers: rules.minFollowers - 1 }), 'low-followers');
  assert.equal(t({ accountCreatedAt: now - 1000 }), null);
  assert.equal(t({ isDev: true }), 'dev');
  assert.equal(t({ isGroup: true }), 'group');
  assert.equal(t({ isPumpUser: false }), 'not-pump-user');
  assert.equal(t({ lowQuality: true }), 'low-quality');
  assert.equal(t({ createdAt: 0 }), 'before-start');
  assert.equal(t({}, { excluded: true }), 'excluded');
  assert.equal(t({}, { lastRewardedAt: now - 9 * 60_000 } as never), 'cooldown');
  assert.equal(t({}, { lastRewardedAt: now - 10 * 60_000 } as never), null);
  assert.equal(t({}, { lastRewardedAt: now - 11 * 60_000, hasOpen: true } as never), 'in-line');
});
