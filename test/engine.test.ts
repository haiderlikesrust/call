import test from 'node:test';
import assert from 'node:assert/strict';
import { rules as base } from '../server/config.ts';
import type { Chain, OnSigned, Outcome } from '../server/chain.ts';
import { Engine } from '../server/engine.ts';
import { parseRow, type Row, type Source } from '../server/pumpApi.ts';
import { Store, hash } from '../server/store.ts';
import { toUnits } from '../server/rewards.ts';

const SUPPLY = 1_000_000_000n * 1_000_000n;
const MIN = 60_000;

function rig() {
  let now = 1_800_000_000_000;
  const bags = new Map<string, bigint>();
  const w = {
    treasury: 0n, out: 'confirmed' as Outcome, paid: new Map<string, bigint>(), sends: 0, deleted: new Set<string>(),
    followers: new Map<string, number>(), rows: [] as Row[], resolveOut: 'pending' as Outcome, burned: 0n, bad: new Set<string>(),
  };
  const apply: (() => void)[] = [];
  const source: Source = {
    health: { ok: true, note: '', remaining: null },
    page: async (n) => ({ rows: w.rows.slice(n * 50, n * 50 + 50), hasMore: w.rows.length > (n + 1) * 50 }),
    exists: async (id) => !w.deleted.has(id),
    followers: async (a) => w.followers.get(a) ?? 1000,
  };
  const chain: Chain = {
    canSign: true,
    treasuryBalance: async () => w.treasury, supply: async () => SUPPLY,
    holding: async (a) => { if (w.bad.has(a)) throw new Error('rpc'); return bags.get(a) ?? 0n; },
    solOk: async () => true, claim: async () => null,
    pay: async (items, onSigned: OnSigned) => {
      w.sends++;
      onSigned(`sig${w.sends}`, 1);
      const land = () => { for (const i of items) { w.paid.set(i.wallet, (w.paid.get(i.wallet) ?? 0n) + i.amount); w.treasury -= i.amount; } };
      if (w.out === 'confirmed') land(); else apply.push(land);
      return w.out;
    },
    resolve: async () => w.resolveOut,
    buyback: async (p, s) => { s('swap', 1); w.treasury -= p; return 'confirmed'; },
    bought: async () => 777n,
    burn: async (_m, a, s) => { s('burn', 1); w.burned += a; return 'confirmed'; },
  };
  const store = new Store(':memory:');
  const make = () => new Engine({ store, source, chain, rules: { ...base }, mode: 'live', burnMode: 'buyback', minBurn: 250, exclude: new Set(['DEV']), start: () => 0, now: () => now });
  const row = (wallet: string, x: Partial<Row> = {}): Row => ({
    calloutId: `c-${wallet}-${now}`, wallet, userId: `u-${wallet}`, username: wallet, avatar: null, thesis: 'x', likes: 0, followers: 1000,
    accountCreatedAt: now - 1e10, createdAt: now - 1000, isDev: false, isGroup: false, isPumpUser: true, lowQuality: false, ...x,
  });
  const call = (wallet: string, bag = SUPPLY / 200n, x: Partial<Row> = {}) => { bags.set(wallet, bag); const r = row(wallet, x); w.rows.unshift(r); return hash(r.calloutId); };
  return { w, bags, store, make, call, tick: (ms: number) => { now += ms; }, apply };
}

test('happy path: callout matures, pays once, burns, and the ledger matches the wallet', async () => {
  const r = rig(); const e = r.make();
  r.w.treasury = toUnits(1_000_000);
  const id = r.call('A');
  await e.poll();
  assert.equal(r.store.callout(id)!.status, 'maturing');
  await e.mature(); await e.payCycle();
  assert.equal(r.w.paid.size, 0, 'not before the hold period');
  r.tick(11 * MIN);
  await e.mature(); await e.payCycle();
  assert.equal(r.store.callout(id)!.status, 'paid');
  assert.ok(r.w.paid.get('A')! > 0n);
  assert.equal(r.w.burned, 777n);
  const p = r.store.pots();
  assert.equal(p.reward + p.burn, r.w.treasury);
  await e.poll(); await e.mature(); await e.payCycle();
  assert.equal(r.w.sends, 1);
});

test('empty treasury queues everyone; the refill pays them in order', async () => {
  const r = rig(); const e = r.make();
  for (const a of ['A', 'B', 'C']) { r.call(a); await e.poll(); r.tick(1000); }
  r.tick(11 * MIN);
  await e.mature(); await e.payCycle();
  assert.equal(r.store.byStatus('ready').length, 3);
  assert.equal(r.w.sends, 0);
  r.w.treasury = toUnits(500_000);
  await e.payCycle();
  assert.equal(r.store.byStatus('paid').length, 3);
});

test('selling during the hold, or while queued, forfeits the reward', async () => {
  const r = rig(); const e = r.make();
  const a = r.call('A'); const b = r.call('B');
  await e.poll();
  r.bags.set('A', 0n);
  await e.mature();
  assert.equal(r.store.callout(a)!.reason, 'sold');
  r.tick(11 * MIN); await e.mature(); await e.payCycle();
  assert.equal(r.store.callout(b)!.status, 'ready');
  r.bags.set('B', 1n); r.w.treasury = toUnits(500_000);
  await e.payCycle();
  assert.equal(r.store.callout(b)!.reason, 'sold');
  assert.equal(r.w.sends, 0);
});

test('dipping and rebuying counts the lowest bag seen', async () => {
  const r = rig(); const e = r.make();
  const a = r.call('A', SUPPLY / 100n);
  await e.poll();
  r.bags.set('A', SUPPLY / 1000n); await e.mature();
  r.bags.set('A', SUPPLY / 100n); r.tick(11 * MIN); await e.mature();
  assert.equal(r.store.callout(a)!.min_balance, (SUPPLY / 1000n).toString());
});

test('deleted callouts, spam and second accounts are refused', async () => {
  const r = rig(); const e = r.make();
  const a = r.call('A'); r.w.deleted.add(r.w.rows[0]!.calloutId);
  const c = r.call('C');
  await e.poll();
  r.tick(5); const c2 = r.call('C');
  const alt = r.call('C-alt', SUPPLY / 200n, { userId: 'u-C' });
  await e.poll();
  r.tick(11 * MIN); await e.mature();
  assert.equal(r.store.callout(a)!.reason, 'deleted');
  assert.equal(r.store.callout(c)!.status, 'ready');
  assert.equal(r.store.callout(c2)!.reason, 'cooldown');
  assert.equal(r.store.callout(alt)!.reason, 'cooldown');
});

test('the same holder keeps earning after the cooldown', async () => {
  const r = rig(); const e = r.make();
  r.w.treasury = toUnits(1_000_000);
  for (let i = 0; i < 3; i++) {
    r.call('A'); await e.poll(); r.tick(11 * MIN); await e.mature(); await e.payCycle();
  }
  assert.equal(r.store.byStatus('paid').length, 3);
  assert.equal(r.w.sends, 3);
});

test('nobody can stack tickets while the pot is dry', async () => {
  const r = rig(); const e = r.make();
  r.call('A'); await e.poll(); r.tick(11 * MIN); await e.mature(); await e.payCycle();
  const second = r.call('A'); await e.poll();
  assert.equal(r.store.callout(second)!.reason, 'in-line');
  assert.equal(r.store.byStatus('ready').length, 1);
});

test('tokens passed to another wallet, and brand new accounts, can earn', async () => {
  const r = rig(); const e = r.make();
  r.w.treasury = toUnits(1_000_000);
  r.call('A'); await e.poll(); r.tick(11 * MIN); await e.mature(); await e.payCycle();
  r.bags.set('A', 0n);
  const b = r.call('B', SUPPLY / 200n, { accountCreatedAt: e.now() - 1000 });
  await e.poll(); r.tick(11 * MIN); await e.mature(); await e.payCycle();
  assert.equal(r.store.callout(b)!.status, 'paid');
});

test('crash mid-payout: the restart resolves the old transaction and never pays twice', async () => {
  const r = rig(); let e = r.make();
  r.w.treasury = toUnits(1_000_000);
  const a = r.call('A');
  await e.poll(); r.tick(11 * MIN); await e.mature();
  r.w.out = 'pending';
  await e.payCycle();
  assert.equal(r.store.callout(a)!.status, 'sending');
  e = r.make(); // process restarted
  await e.payCycle();
  assert.equal(r.w.sends, 1, 'still undecided, so nothing new is sent');
  r.apply[0]!(); r.w.resolveOut = 'confirmed'; r.w.out = 'confirmed';
  await e.payCycle(); await e.payCycle();
  assert.equal(r.store.callout(a)!.status, 'paid');
  assert.equal(r.w.sends, 1);
  const p = r.store.pots();
  assert.equal(p.reward + p.burn, r.w.treasury);
});

test('an expired transaction goes back to the queue and is paid on the next pass', async () => {
  const r = rig(); const e = r.make();
  r.w.treasury = toUnits(1_000_000);
  const a = r.call('A');
  await e.poll(); r.tick(11 * MIN); await e.mature();
  r.w.out = 'expired'; await e.payCycle();
  assert.equal(r.store.callout(a)!.status, 'ready');
  r.w.out = 'confirmed'; await e.payCycle();
  assert.equal(r.store.callout(a)!.status, 'paid');
});

test('one unreadable wallet does not block the others', async () => {
  const r = rig(); const e = r.make();
  const good = r.call('GOOD'); r.call('BAD'); r.w.bad.add('BAD');
  await e.poll();
  assert.equal(r.store.callout(good)!.status, 'maturing');
  assert.ok(e.problems.has('callouts'));
  r.w.bad.clear(); await e.poll();
  assert.equal(e.problems.size, 0);
});

test('a burst larger than one page is still fully read', async () => {
  const r = rig(); const e = r.make();
  for (let i = 0; i < 130; i++) r.call(`W${i}`);
  await e.poll();
  assert.equal(r.store.byStatus('maturing').length, 130);
});

test('API data is purged after 24h but the ledger survives', async () => {
  const r = rig(); const e = r.make();
  r.w.treasury = toUnits(1_000_000);
  const a = r.call('A');
  await e.poll(); r.tick(11 * MIN); await e.mature(); await e.payCycle();
  r.store.purge(e.now() + 25 * 60 * MIN);
  const c = r.store.callout(a)!;
  assert.deepEqual([c.username, c.avatar, c.thesis, c.followers, c.callout_id], [null, null, null, null, null]);
  assert.equal(c.status, 'paid');
  assert.ok(BigInt(c.amount!) > 0n);
});

test('API rows are parsed defensively', () => {
  const mint = 'So11111111111111111111111111111111111111112';
  const wallet = 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn';
  const ok = { coinMint: mint, walletAddress: wallet, userId: 'u', userName: 'n', profileImage: 'javascript:alert(1)', accountKind: 'person', profile: { followerCount: 5, createdAt: '2026-01-01T00:00:00Z' }, callout: { calloutId: 'x', calloutTimestamp: '2026-11-20T00:00:00Z', thesis: 'hi' } };
  const row = parseRow(ok, mint)!;
  assert.equal(row.avatar, null);
  assert.equal(row.followers, 5);
  assert.equal(parseRow({ ...ok, coinMint: 'other' }, mint), null);
  assert.equal(parseRow({ ...ok, callout: null }, mint), null);
  assert.equal(parseRow({ ...ok, walletAddress: '0xabc' }, mint), null);
  assert.equal(parseRow(null, mint), null);
  assert.equal(parseRow({ ...ok, callout: { ...ok.callout, calloutTimestamp: '1795000000000' } }, mint)!.createdAt, 1795000000000);
});
