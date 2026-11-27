import test from 'node:test';
import assert from 'node:assert/strict';
import { rules as base } from '../server/config.ts';
import type { Chain, OnSigned, Outcome } from '../server/chain.ts';
import { Engine } from '../server/engine.ts';
import { eventKey, parseDetail, parseListed, parseOverview, parsePosition, parsePositionEvents, toRow, type Row, type Source } from '../server/pumpApi.ts';
import { Store, hash } from '../server/store.ts';
import { toUnits } from '../server/rewards.ts';

const SUPPLY = 1_000_000_000n * 1_000_000n;
const MIN = 60_000;

function rig() {
  let now = 1_800_000_000_000;
  const bags = new Map<string, bigint>();
  const w = {
    treasury: 0n, out: 'confirmed' as Outcome, paid: new Map<string, bigint>(), sends: 0, deleted: new Set<string>(),
    followers: new Map<string, number>(), rows: [] as Row[], resolveOut: 'pending' as Outcome, burned: 0n, bad: new Set<string>(), profiled: [] as string[], down: false, holdersAt: null as number | null, snap: null as Map<string, bigint> | null, reads: 0,
    gmgnDown: false, noProfile: new Set<string>(), readOrder: [] as string[],
  };
  const apply: (() => void)[] = [];
  const listed = (x: Row) => ({ calloutId: x.calloutId, wallet: x.wallet, createdAt: x.createdAt, thesis: x.thesis, likes: x.likes, username: x.username, avatar: x.avatar, followers: x.followers, ...(x.key ? { key: x.key } : {}) });
  const source: Source = {
    health: { ok: true, note: '', remaining: null },
    everyMs: 10_000,
    // pump.fun's feed lists current holders' callouts only, newest first, with the author's profile.
    positions: async (page) => {
      if (w.down) throw new Error('pump.fun 403 Client not allowed');
      const held = w.rows.filter((x) => (bags.get(x.wallet) ?? 0n) > 0n && !w.deleted.has(x.calloutId));
      const items = held.slice(page * 50, page * 50 + 50).map((x) => ({
        listed: listed(x), row: w.noProfile.has(x.wallet) ? null : { ...x, followers: w.followers.get(x.wallet) ?? x.followers },
      }));
      return { items, hasMore: held.length > (page + 1) * 50 };
    },
    callouts: async () => (w.gmgnDown ? null : w.rows.map(listed)),
    account: async (l) => {
      w.profiled.push(l.wallet);
      if (w.down) throw new Error('pump.fun 403 Client not allowed');
      const x = w.rows.find((y) => y.calloutId === l.calloutId);
      if (!x || w.deleted.has(x.calloutId)) return null;
      return { calloutId: x.calloutId, wallet: x.wallet, userId: x.userId, isDev: x.isDev, isGroup: x.isGroup, username: x.username, avatar: x.avatar, followers: w.followers.get(x.wallet) ?? x.followers, isPumpUser: x.isPumpUser, banned: x.lowQuality };
    },
    exists: async (id) => !w.deleted.has(id),
    followers: async (a) => w.followers.get(a) ?? 1000,
  };
  const chain: Chain = {
    canSign: true,
    treasuryBalance: async () => w.treasury, supply: async () => SUPPLY,
    holding: async (a) => { w.reads++; w.readOrder.push(a); if (w.bad.has(a)) throw new Error('rpc'); return bags.get(a) ?? 0n; },
    holders: async () => ({ at: w.holdersAt ?? now, balances: w.snap ?? new Map([...bags].filter(([, b]) => b > 0n)) }),
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
  /**
   * An update on the wallet's existing callout, as pump.fun shows calling the coin out again. It rides on the old
   * callout's place in the feed, which is ordered by when callouts were first posted.
   */
  const update = (wallet: string, n: number) => {
    const at = w.rows.findIndex((x) => x.wallet === wallet && !x.key);
    const orig = w.rows[at]!;
    const u: Row = { ...orig, key: `${orig.calloutId}/u${n}`, createdAt: now - 1000, thesis: `update ${n}` };
    w.rows.splice(at + 1, 0, u);
    return hash(u.key!);
  };
  return { w, bags, store, make, call, update, tick: (ms: number) => { now += ms; }, apply };
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
  const a = r.call('A');
  const c = r.call('C');
  await e.poll();
  r.w.deleted.add(r.store.callout(a)!.callout_id!);
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

test('calling out again with an update on pump.fun pays again after the cooldown', async () => {
  const r = rig(); const e = r.make();
  r.w.treasury = toUnits(1_000_000);
  const first = r.call('A');
  await e.poll();

  // A minute later, inside the cooldown and while the first is still holding: recorded and turned away.
  r.tick(1 * MIN);
  const early = r.update('A', 1);
  await e.poll();
  assert.equal(r.store.callout(early)!.reason, 'cooldown');
  assert.equal(r.store.callout(first)!.status, 'maturing', 'the first callout is untouched');
  r.tick(10 * MIN); await e.mature(); await e.payCycle();
  assert.equal(r.store.callout(first)!.status, 'paid');

  // Past the cooldown: the next update is a new callout and is paid.
  r.tick(1 * MIN);
  const again = r.update('A', 2);
  await e.poll();
  assert.equal(r.store.callout(again)!.status, 'maturing');
  r.tick(11 * MIN); await e.mature(); await e.payCycle();
  assert.equal(r.store.callout(again)!.status, 'paid');
  assert.equal(r.w.sends, 2, 'the first callout and the update, each paid once');
  assert.equal(r.store.callout(again)!.callout_id, r.store.callout(first)!.callout_id, 'the update keeps its callout\'s id, for the deleted check');
  await e.poll(); await e.mature(); await e.payCycle();
  assert.equal(r.w.sends, 2, 'nothing is paid twice');
});

test('an update on an old callout deep in the feed is still found', async () => {
  const r = rig(); const e = r.make();
  for (let i = 0; i < 60; i++) r.call(`W${i}`);
  await e.poll();
  r.tick(15 * MIN);
  // W0 called out first, so its callout is on the feed's second page, behind 59 already recorded.
  const u = r.update('W0', 1);
  await e.poll();
  assert.ok(r.store.callout(u), 'read past the callouts already recorded');
});

test('a burst of callouts is read in full', async () => {
  const r = rig(); const e = r.make();
  for (let i = 0; i < 130; i++) r.call(`W${i}`);
  await e.poll();
  assert.equal(r.store.byStatus('maturing').length, 130);
});

test('qualifying holders go first, smallest bag up; small bags and excluded wallets are turned away', async () => {
  const r = rig(); const e = r.make();
  const big = r.call('BIG', SUPPLY / 20n); r.call('SMALL', SUPPLY / 1000n); r.call('MID', SUPPLY / 100n);
  const tiny = r.call('TINY', SUPPLY / 10_000n); const none = r.call('NONE', 0n); const dev = r.call('DEV');
  await e.poll();
  assert.deepEqual(r.w.readOrder, ['SMALL', 'MID', 'BIG'], 'only qualifying holders are read again, smallest first');
  assert.equal(e.watching, 3);
  assert.equal(r.store.callout(big)!.status, 'maturing');
  assert.equal(r.store.callout(tiny)!.reason, 'low-holding');
  assert.equal(r.store.callout(none)!.reason, 'not-holder');
  assert.equal(r.store.callout(dev)!.reason, 'excluded');
});

test('buying in after calling out does not count', async () => {
  const r = rig(); const e = r.make();
  const a = r.call('A', SUPPLY / 10_000n);
  await e.poll();
  r.bags.set('A', SUPPLY / 100n); await e.poll();
  assert.equal(r.store.callout(a)!.reason, 'low-holding');
});

test('pump.fun decides: its follower count, dev flag and squad flag win over gmgn', async () => {
  const r = rig(); const e = r.make();
  const a = r.call('A', SUPPLY / 200n, { followers: 0 }); r.w.followers.set('A', 1048);
  const d = r.call('D', SUPPLY / 200n, { isDev: true });
  const g = r.call('G', SUPPLY / 200n, { isGroup: true });
  await e.poll();
  assert.equal(r.store.callout(a)!.status, 'maturing');
  assert.equal(r.store.callout(a)!.followers, 1048);
  assert.equal(r.store.callout(d)!.reason, 'dev');
  assert.equal(r.store.callout(g)!.reason, 'group');
});

test('when pump.fun does not answer, the callout waits for the next read instead of being judged', async () => {
  const r = rig(); const e = r.make();
  r.w.down = true;
  const a = r.call('A', SUPPLY / 200n, { followers: 0 }); r.w.followers.set('A', 1048);
  const t = r.call('TINY', SUPPLY / 10_000n);
  await e.poll();
  assert.equal(r.store.callout(a), undefined, 'not judged on gmgn numbers');
  assert.equal(r.store.callout(t)!.reason, 'low-holding', 'small bags need no pump.fun answer');
  assert.ok(e.problems.has('callouts'));
  r.w.down = false; await e.poll();
  assert.equal(r.store.callout(a)!.status, 'maturing');
  assert.equal(e.problems.size, 0);
});

test('a callout deleted before it is read is skipped', async () => {
  const r = rig(); const e = r.make();
  const a = r.call('A'); r.w.deleted.add(r.w.rows[0]!.calloutId);
  await e.poll();
  assert.equal(r.store.callout(a), undefined);
});

test('a buy just before calling out counts even when the holder list was read before the buy', async () => {
  const r = rig(); const e = r.make();
  // The cached holder list was read 20s ago, before A bought in; A then called out 1s ago.
  r.w.holdersAt = e.now() - 20_000; r.w.snap = new Map([['A', SUPPLY / 10_000n]]);
  const a = r.call('A', SUPPLY / 200n);
  await e.poll();
  assert.equal(r.store.callout(a)!.status, 'maturing');
});

test('a holder list read after the callout is trusted for small bags, with no extra RPC read', async () => {
  const r = rig(); const e = r.make();
  const t = r.call('TINY', SUPPLY / 10_000n);
  r.w.reads = 0;
  await e.poll();
  assert.equal(r.store.callout(t)!.reason, 'low-holding');
  assert.equal(r.w.reads, 0);
});

test('a stale holder list still turns away a wallet that really is small, after reading it again', async () => {
  const r = rig(); const e = r.make();
  r.w.holdersAt = e.now() - 20_000;
  const t = r.call('TINY', SUPPLY / 10_000n);
  r.w.reads = 0;
  await e.poll();
  assert.equal(r.store.callout(t)!.reason, 'low-holding');
  assert.equal(r.w.reads, 1);
  assert.deepEqual(r.w.profiled, [], 'no pump.fun lookup for a small bag');
});

test('the pump.fun feed alone is enough when gmgn is down, with no extra lookups', async () => {
  const r = rig(); const e = r.make();
  r.w.gmgnDown = true;
  const a = r.call('A', SUPPLY / 200n, { followers: 300, accountCreatedAt: e.now() - 5 * 86_400_000 });
  await e.poll();
  const c = r.store.callout(a)!;
  assert.equal(c.status, 'maturing');
  assert.equal(c.followers, 300);
  assert.deepEqual(r.w.profiled, [], 'the feed row carries everything');
  assert.equal(e.problems.size, 0, 'gmgn being down is not a problem for the site');
});

test('a feed row without a profile is judged on the account lookup instead', async () => {
  const r = rig(); const e = r.make();
  r.w.gmgnDown = true; r.w.noProfile.add('A');
  const a = r.call('A');
  await e.poll();
  assert.deepEqual(r.w.profiled, ['A']);
  assert.equal(r.store.callout(a)!.status, 'maturing');
});

test('calling out first and buying in later is caught while gmgn is down', async () => {
  const r = rig(); const e = r.make();
  r.w.gmgnDown = true;
  await e.poll(); r.tick(10_000); await e.poll();
  const a = r.call('A', 0n); // called out holding nothing: the feed does not list it
  for (let i = 0; i < 36; i++) { r.tick(10_000); await e.poll(); }
  r.bags.set('A', SUPPLY / 200n); // bought six minutes later
  await e.poll();
  assert.equal(r.store.callout(a)!.reason, 'late');
});

test('a gap in reading the feed never makes a callout look late', async () => {
  const r = rig(); const e = r.make();
  r.w.gmgnDown = true;
  await e.poll(); r.tick(10_000); await e.poll();
  const a = r.call('A', 0n);
  r.tick(2 * MIN); await e.poll(); // the feed went unread for two minutes, so A's absence proves nothing
  r.tick(5 * MIN); r.bags.set('A', SUPPLY / 200n);
  await e.poll();
  assert.equal(r.store.callout(a)!.status, 'maturing');
});

test('with gmgn up, a non-holder is recorded the moment they call out', async () => {
  const r = rig(); const e = r.make();
  const a = r.call('A', 0n);
  await e.poll();
  assert.equal(r.store.callout(a)!.reason, 'not-holder');
  r.bags.set('A', SUPPLY / 200n); r.tick(6 * MIN); await e.poll();
  assert.equal(r.store.callout(a)!.reason, 'not-holder');
});

test('a callout older than a day is not admitted', async () => {
  const r = rig(); const e = r.make();
  const old = r.call('A', SUPPLY / 200n, { createdAt: e.now() - 25 * 60 * MIN });
  await e.poll();
  assert.equal(r.store.callout(old), undefined);
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

test('pump.fun feed rows are parsed defensively', () => {
  const mint = '4VDjNNkemze5ZX5MWTzphtw6AtQdrJL2XqqPkt19pump';
  const wallet = '7LX573px9mMa5hcksZAztAZV38BEf9bXnHz1n6nTh8NY';
  // Trimmed from a real /mint-positions answer.
  const pos = { coinMint: mint, userId: '5fe20ce6-b8a7-425f-b3b5-b352f53b6cce', userName: 'Pukulan24', profileImage: 'https://socialimages.pump.fun/a.webp', walletAddress: wallet, accountKind: 'person', amountHeld: 4354448.07, lowQuality: false,
    callout: { calloutId: '550edc00-09c5-4e39-a55c-3fbe6f0c8e3b', thesis: 'Indian-mas?', calloutTimestamp: '2026-11-26T06:11:07.779Z', likes: 1, authorIsDev: false },
    profile: { userId: '5fe20ce6-b8a7-425f-b3b5-b352f53b6cce', username: 'Pukulan24', followerCount: 172, createdAt: '2026-10-01T00:00:00.000Z', kind: 'person', isPumpUser: true } };
  const f = parsePosition(pos, mint)!;
  assert.equal(f.listed.calloutId, '550edc00-09c5-4e39-a55c-3fbe6f0c8e3b');
  assert.deepEqual([f.row!.userId, f.row!.followers, f.row!.accountCreatedAt, f.row!.createdAt, f.row!.isPumpUser, f.row!.isDev], ['5fe20ce6-b8a7-425f-b3b5-b352f53b6cce', 172, Date.parse('2026-10-01T00:00:00.000Z'), Date.parse('2026-11-26T06:11:07.779Z'), true, false]);
  assert.equal(parsePosition({ ...pos, profile: undefined }, mint)!.row, null, 'no profile: followers unknown, so no row');
  assert.equal(parsePosition({ ...pos, coinMint: 'other' }, mint), null);
  assert.equal(parsePosition({ ...pos, callout: null }, mint), null);
  assert.equal(parsePosition({ ...pos, walletAddress: '0xabc' }, mint), null);
  assert.equal(parsePosition({ ...pos, lowQuality: true }, mint)!.row!.lowQuality, true);
  assert.equal(parsePosition({ ...pos, accountKind: 'group' }, mint)!.row!.isGroup, true);
  assert.equal(parsePosition({ ...pos, callout: { ...pos.callout, authorIsDev: true } }, mint)!.row!.isDev, true);
  assert.equal(parsePosition({ ...pos, userId: null }, mint)!.row!.isPumpUser, false);

  // Updates (read with updatesLimit): each is its own event with its own time and text; replies and junk are skipped.
  const updates = [
    { id: '3e11c021-ef4d-424e-8e60-255d6200a120', content: 'Dev live!', createdAt: '2026-11-27T17:19:49.223Z', likeCount: 6, parentMessageId: null },
    { id: 'd0850a56-134b-44e7-b16e-a290dd463e60', content: 'still early', createdAt: '2026-11-27T16:46:21.246Z', likeCount: 1, parentMessageId: null },
    { id: '1e63d1ac-d30f-44f1-9941-3e9d5c091702', content: 'a reply', createdAt: '2026-11-27T16:50:00.000Z', likeCount: 0, parentMessageId: '3e11c021-ef4d-424e-8e60-255d6200a120' },
    { id: 'not-a-uuid', content: 'junk', createdAt: '2026-11-27T16:00:00.000Z' },
  ];
  const ev = parsePositionEvents({ ...pos, callout: { ...pos.callout, updates } }, mint);
  assert.equal(ev.length, 3, 'the callout and its two updates');
  assert.equal(eventKey(ev[0]!.listed), '550edc00-09c5-4e39-a55c-3fbe6f0c8e3b');
  assert.equal(ev[1]!.listed.key, '550edc00-09c5-4e39-a55c-3fbe6f0c8e3b/3e11c021-ef4d-424e-8e60-255d6200a120');
  assert.deepEqual([ev[1]!.row!.thesis, ev[1]!.row!.createdAt, ev[1]!.row!.likes, ev[1]!.row!.calloutId], ['Dev live!', Date.parse('2026-11-27T17:19:49.223Z'), 6, '550edc00-09c5-4e39-a55c-3fbe6f0c8e3b']);
  assert.equal(ev[2]!.row!.followers, 172, 'an update carries the author\'s profile like the callout');
  assert.equal(toRow(ev[1]!.listed, null).key, ev[1]!.listed.key, 'the key survives the account lookup path');
  assert.deepEqual(parsePositionEvents({ ...pos, coinMint: 'other' }, mint), []);
});

test('API responses are parsed defensively', () => {
  const mint = '4VDjNNkemze5ZX5MWTzphtw6AtQdrJL2XqqPkt19pump';
  const wallet = '9EzDyQ8z5DepYjRMLNDK8ceRTRKj71gT5fxa7WANcS4A';
  // Trimmed from real gmgn and pump.fun answers.
  const item = { platform: 'pump', callout_id: 'pumpfun:b828952f-987c-4e6b-9887-8e71f52d92bd', created_at: 1795674083079, author: { id: wallet, name: 'grokcoindev', avatar: 'javascript:alert(1)', followers: 204, wallet }, token: { chain: 'sol', address: mint }, content: { text: 'Duve is the new black bull.' }, stats: { likes: 2, replies: 0 } };
  const l = parseListed(item, mint)!;
  assert.deepEqual(l, { calloutId: 'b828952f-987c-4e6b-9887-8e71f52d92bd', wallet, createdAt: 1795674083079, thesis: 'Duve is the new black bull.', likes: 2, username: 'grokcoindev', avatar: null, followers: 204 });
  assert.equal(parseListed({ ...item, token: { address: 'other' } }, mint), null);
  assert.equal(parseListed({ ...item, platform: 'other' }, mint), null);
  assert.equal(parseListed({ ...item, author: { ...item.author, wallet: '0xabc' } }, mint), null);
  assert.equal(parseListed({ ...item, created_at: null }, mint), null);
  assert.equal(parseListed(null, mint), null);
  const detail = { callout: { calloutId: l.calloutId, userId: wallet, coinMint: mint, user_uuid: 'c8026662-0fd4-4fd5-8953-6c828554e838', authorIsDev: false, accountKind: 'person', userName: 'grokcoindev', profileImage: 'https://x/y.png' } };
  const d = parseDetail(detail, l, mint)!;
  assert.deepEqual(d, { calloutId: l.calloutId, wallet, userId: 'c8026662-0fd4-4fd5-8953-6c828554e838', isDev: false, isGroup: false, username: 'grokcoindev', avatar: 'https://x/y.png' });
  assert.equal(parseDetail({ callout: { ...detail.callout, coinMint: 'other' } }, l, mint), null, 'another coin');
  assert.equal(parseDetail({ callout: { ...detail.callout, userId: 'someoneElse' } }, l, mint), null, 'another author');
  assert.equal(parseDetail({ callout: null }, l, mint), null);
  assert.equal(parseDetail({ callout: { ...detail.callout, user_uuid: '' } }, l, mint)!.userId, wallet);
  assert.equal(parseDetail({ callout: { ...detail.callout, authorIsDev: true, accountKind: 'group' } }, l, mint)!.isDev, true);
  const ov = { address: wallet, profile: { address: wallet, is_pump_user: true, is_banned: false, username: 'grok', kind: 'person', followers: 210 }, isPumpUser: true, counts: { followers: 216 }, banned: false };
  const o = parseOverview(ov, wallet)!;
  assert.deepEqual([o.followers, o.isPumpUser, o.banned, o.isGroup], [216, true, false, false]);
  assert.equal(parseOverview({ ...ov, profile: { ...ov.profile, address: 'other' } }, wallet), null);
  assert.equal(parseOverview({ ...ov, banned: false, profile: { ...ov.profile, is_banned: true } }, wallet)!.banned, true);
  const row = toRow(l, { ...d, followers: o.followers, isPumpUser: o.isPumpUser, banned: o.banned });
  assert.deepEqual([row.userId, row.followers, row.isDev, row.isPumpUser], ['c8026662-0fd4-4fd5-8953-6c828554e838', 216, false, true]);
  const bare = toRow(l, null);
  assert.deepEqual([bare.userId, bare.followers], [wallet, 204], 'turned-away callouts show gmgn details');
});
