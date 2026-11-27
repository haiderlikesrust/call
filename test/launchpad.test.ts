import test from 'node:test';
import assert from 'node:assert/strict';
import { Registry } from '../server/launchpad/registry.ts';
import { platformShare, spent } from '../server/launchpad/chain.ts';
import { coinRules, splitFor } from '../server/launchpad/index.ts';
import { reconcile, burnFor } from '../server/rewards.ts';
import { Store } from '../server/store.ts';

const SOL = 1_000_000_000n;
const A = 'A'.repeat(43), B = 'B'.repeat(43), P = 'P'.repeat(43);

/** A confirmed claim that brought `net` lamports, with the platform share taken as the server takes it. */
const claim = (reg: Registry, mint: string, net: bigint, isPlatform = false) =>
  reg.settleClaim(reg.addClaim(mint, `c${mint}${net}${Math.random()}`, 1, 0), 'confirmed', net, platformShare(net, 30, isPlatform));
const swap = (reg: Registry, mint: string, solIn: bigint, usdcOut: bigint | null) => {
  const id = reg.addSwap(mint, `s${mint}${solIn}${Math.random()}`, 1, solIn, 0);
  if (usdcOut !== null) reg.settleSwap(id, 'confirmed', { solIn, usdcOut });
  return id;
};

test('60/10/30: once the 30% platform share has left, the coin splits its USDC 60 to 10', () => {
  const r = coinRules(splitFor(false, { reward: 60, burn: 10, platform: 30 }));
  assert.equal(r.rewardBps, 8571);
  // 700 USDC reached the coin's pots after the platform share went to the platform coin.
  const p = reconcile(700_000_000n, { reward: 0n, burn: 0n }, r);
  assert.equal(p.reward, 599_970_000n, 'about 600 to callers');
  assert.equal(p.burn, 100_030_000n, 'about 100 to the buyback');
  assert.ok(burnFor(60_000_000n, p.burn, r) > 9_990_000n && burnFor(60_000_000n, p.burn, r) < 10_010_000n, 'a 60 USDC payout releases about 10 to burn');
});

test('the platform coin keeps all of its own fees, in the same callers-to-burn ratio', () => {
  const own = splitFor(true, { reward: 60, burn: 10, platform: 30 });
  assert.ok(Math.abs(own.reward - 600 / 7) < 1e-9 && Math.abs(own.reward + own.burn - 100) < 1e-9 && own.platform === 0);
  assert.equal(coinRules(splitFor(true, { reward: 60, burn: 10, platform: 30 })).rewardBps, 8571);
  assert.deepEqual(splitFor(true, { reward: 0, burn: 0, platform: 100 }), { reward: 100, burn: 0, platform: 0 }, 'nothing kept: no division by zero');
  assert.equal(platformShare(1_000n, 30, false), 300n);
  assert.equal(platformShare(1_000n, 30, true), 0n);
  assert.equal(platformShare(-5n, 30, false), 0n, 'a claim that cost more than it brought sends nothing on');
});

test('a coin only swaps the SOL its own claims kept, and the platform coin gets every share', () => {
  const reg = new Registry(':memory:');
  claim(reg, A, 10n * SOL);
  claim(reg, B, 2n * SOL);
  claim(reg, P, 1n * SOL, true);
  reg.settleClaim(reg.addClaim(A, 'lost', 1, 0), 'expired', null);
  reg.addClaim(A, 'inflight', 1, 0);
  reg.settleClaim(reg.addClaim(B, 'costly', 1, 0), 'confirmed', -5000n, 0n);

  assert.equal(reg.solOwed(A, false), 7n * SOL, '70% of its 10 SOL: in-flight, expired and losing claims add nothing');
  assert.equal(reg.solOwed(B, false), 1_400_000_000n);
  assert.equal(reg.solOwed(P, true), 1n * SOL + 3n * SOL + 600_000_000n, 'its own 1 SOL whole, plus 30% of A and B');
  assert.equal(reg.solOwed(P, false), 1n * SOL, 'before PLATFORM_MINT is set, the shares are held, not given to anyone');
  assert.equal(reg.solHeldForCoins(), 13n * SOL, 'every SOL claimed is owed to some coin until it is swapped');
  assert.equal(reg.forwarded(A), 3n * SOL);
  assert.equal(reg.openClaims(A).length, 1);
});

test('SOL in a swap is spoken for from the moment it is signed; USDC counts once it lands', () => {
  const reg = new Registry(':memory:');
  claim(reg, A, 10n * SOL);
  const inFlight = swap(reg, A, 3n * SOL, null);
  assert.equal(reg.solOwed(A, false), 4n * SOL, 'the in-flight swap cannot be swapped again');
  assert.equal(reg.usdcIn(A), 0n, 'no USDC until it confirms');
  reg.settleSwap(inFlight, 'expired');
  assert.equal(reg.solOwed(A, false), 7n * SOL, 'an expired swap gives its SOL back');
  swap(reg, A, 7n * SOL, 1_330_000_000n);
  assert.equal(reg.solOwed(A, false), 0n);
  assert.equal(reg.usdcIn(A), 1_330_000_000n);
  assert.equal(reg.usdcIn(B), 0n, 'another coin\'s swap is not this one\'s money');
  assert.equal(reg.solHeldForCoins(), 3n * SOL, 'what is left is the platform share, waiting for its coin');
});

test('a coin can only pay out what its own swaps made, less what it already spent', () => {
  const store = new Store(':memory:');
  assert.equal(spent(store), 0n);
  store.setPayout(store.addPayout('p1', 1, 300n, 0), 'confirmed');
  store.addPayout('p2', 1, 50n, 0); // still sending: not spent yet
  store.setPayout(store.addPayout('p3', 1, 40n, 0), 'failed');
  store.addBurn({ at: 0, kind: 'buyback', status: 'swapped', pump_in: '100' });
  store.addBurn({ at: 0, kind: 'buyback', status: 'done', pump_in: '20' });
  store.addBurn({ at: 0, kind: 'buyback', status: 'swapping', pump_in: '999' });
  store.addBurn({ at: 0, kind: 'buyback', status: 'failed', pump_in: '999' });
  assert.equal(spent(store), 420n, 'confirmed payouts and buybacks that went through, nothing in flight or failed');
});
