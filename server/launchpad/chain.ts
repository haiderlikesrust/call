// One launched coin's view of the shared launchpad wallet. The payout engine reads a treasury balance and spends
// from it; here that balance is this coin's own USDC: what its swaps made, less what its payouts and buybacks
// have spent. Every coin pays from the same wallet without ever touching another coin's money.
//
// Money moves in two steps, each written down before it is sent:
//   1. claim: the coin's creator fees (SOL) move from its pump.fun fee-sharing vault into the wallet. The
//      platform share of what arrived belongs to the platform coin from then on.
//   2. swap: once the coin is owed enough SOL, Jupiter swaps it to USDC. The USDC it made is the coin's.
// The engine then splits that USDC between callers and the buyback, exactly as it always has.
import { OnlinePumpSdk } from '@pump-fun/pump-sdk';
import { LAMPORTS, SOL_MINT, USDC_MINT, config } from '../config.ts';
import { SolanaChain, type ChainOpts, type Outcome } from '../chain.ts';
import type { Store } from '../store.ts';
import type { Registry } from './registry.ts';

/** What this coin's own payouts and buybacks have taken out of the shared wallet. Mirrors when the engine moves its pots. */
export function spent(store: Store): bigint {
  let n = 0n;
  for (const p of store.db.prepare("SELECT total FROM payouts WHERE status = 'confirmed'").all() as { total: string }[]) n += BigInt(p.total);
  const burns = store.db.prepare(`SELECT pump_in FROM burns WHERE (kind = 'buyback' AND status IN ('swapped', 'burning', 'done'))
    OR (kind = 'direct' AND status = 'done')`).all() as { pump_in: string }[];
  for (const b of burns) n += BigInt(b.pump_in);
  return n;
}

/** The platform share of a claim, in lamports. The platform coin keeps all of its own. */
export function platformShare(net: bigint, platformPct: number, isPlatform: boolean): bigint {
  if (net <= 0n || isPlatform || !(platformPct > 0)) return 0n;
  return (net * BigInt(Math.round(platformPct * 100))) / 10_000n;
}

export interface LaunchChainOpts extends ChainOpts {
  registry: Registry;
  store: Store;
  /** Percent of every claim that goes to the platform coin. */
  platformPct: number;
  /** Whether this coin is the platform coin: it keeps its own claims whole and is credited everyone's share. */
  isPlatform: () => boolean;
  minClaimSol: number;
  minSwapSol: number;
  now?: () => number;
}

export class LaunchChain extends SolanaChain {
  private readonly lp: LaunchChainOpts;

  constructor(o: LaunchChainOpts) {
    super(o);
    this.lp = o;
  }

  /** This coin's USDC in the shared wallet. Never more than its swaps brought in. */
  override async treasuryBalance(): Promise<bigint> {
    const left = this.lp.registry.usdcIn(this.coin.toBase58()) - spent(this.lp.store);
    return left > 0n ? left : 0n;
  }

  /** The wallet's own SOL (what coins are not owed) must cover network fees and new token accounts. */
  override async solOk(): Promise<boolean> {
    if (!this.treasury) return false;
    const free = BigInt(await this.conn.getBalance(this.treasury)) - this.lp.registry.solHeldForCoins();
    return free >= BigInt(Math.round(config.minSolReserve * LAMPORTS));
  }

  /** Collects this coin's fees, then swaps what it is owed to USDC. Each step waits until the one before has settled. */
  override async claim(): Promise<string | null> {
    if (!(await this.settleOpen())) return null;
    const claimed = await this.collect();
    if (claimed === 'pending') return null;
    return this.convert();
  }

  private get mint(): string { return this.coin.toBase58(); }
  private now(): number { return (this.lp.now ?? Date.now)(); }

  /** Resolves claims and swaps left in flight (a restart mid-send). False while any is still undecided. */
  private async settleOpen(): Promise<boolean> {
    let clear = true;
    for (const c of this.lp.registry.openClaims(this.mint)) {
      const out = await this.resolve(c.sig, c.last_valid);
      if (out === 'pending') clear = false;
      else await this.settleClaim(c.id, c.sig, out);
    }
    for (const s of this.lp.registry.openSwaps(this.mint)) {
      const out = await this.resolve(s.sig, s.last_valid);
      if (out === 'pending') clear = false;
      else await this.settleSwap(s.id, s.sig, out);
    }
    return clear;
  }

  /**
   * Moves this coin's creator fees into the wallet. Each coin has its own pump.fun fee-sharing vault paying the
   * launchpad wallet, so one coin's claim moves only that coin's fees. What arrived is measured from the confirmed
   * transaction itself, network fee included, so the coin is never credited more than really came in.
   */
  private async collect(): Promise<Outcome | null> {
    const me = this.me();
    const online = new OnlinePumpSdk(this.conn as never);
    const min = await online.getMinimumDistributableFee(this.coin, me.publicKey, { payer: me.publicKey });
    if (!min.canDistribute) return null;
    if (BigInt(min.distributableFees.toString()) < BigInt(Math.round(this.lp.minClaimSol * LAMPORTS))) return null; // not worth the network fee yet
    const { instructions } = await online.buildDistributeCreatorFeesInstructions(this.coin, { payer: me.publicKey });
    const { tx, lastValid } = await this.build(instructions, 400_000);
    const sim = await this.conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
    if (sim.value.err) throw new Error(`claim would fail: ${JSON.stringify(sim.value.err)}`);
    let id = 0;
    let signature = '';
    const out = await this.send(tx, lastValid, (sig, lv) => {
      signature = sig;
      id = this.lp.registry.addClaim(this.mint, sig, lv, this.now());
    });
    if (out !== 'pending') await this.settleClaim(id, signature, out);
    return out;
  }
  private async settleClaim(id: number, sig: string, out: Exclude<Outcome, 'pending'>): Promise<void> {
    if (out !== 'confirmed') return this.lp.registry.settleClaim(id, out, null);
    const net = (await this.deltas(sig, SOL_MINT)).lamports; // throws until indexed; the claim stays open until then
    this.lp.registry.settleClaim(id, 'confirmed', net, platformShare(net, this.lp.platformPct, this.lp.isPlatform()));
  }

  /** Swaps the SOL this coin is owed to USDC through Jupiter, once there is enough of it. */
  private async convert(): Promise<string | null> {
    const owed = this.lp.registry.solOwed(this.mint, this.lp.isPlatform());
    if (owed < BigInt(Math.round(this.lp.minSwapSol * LAMPORTS))) return null;
    const me = this.me();
    const have = BigInt(await this.conn.getBalance(me.publicKey));
    if (have < owed) throw new Error(`the launchpad wallet holds ${Number(have) / LAMPORTS} SOL, less than the ${Number(owed) / LAMPORTS} SOL this coin is owed`);
    const { tx, lastValid, minOut } = await this.jupiter(SOL_MINT, USDC_MINT, owed, config.swapSlippageBps);
    await this.assertSwap(tx, { spend: null, maxSpend: 0n, out: this.usdcAta(me.publicKey), minOut, maxSol: owed + BigInt(Math.round(0.01 * LAMPORTS)) });
    let id = 0;
    let signature = '';
    const out = await this.send(tx, lastValid, (sig, lv) => {
      signature = sig;
      id = this.lp.registry.addSwap(this.mint, sig, lv, owed, this.now());
    });
    if (out === 'pending') return null;
    await this.settleSwap(id, signature, out);
    return out === 'confirmed' ? signature : null;
  }
  private async settleSwap(id: number, sig: string, out: Exclude<Outcome, 'pending'>): Promise<void> {
    if (out !== 'confirmed') return this.lp.registry.settleSwap(id, out);
    const d = await this.deltas(sig, USDC_MINT); // throws until indexed; the swap stays open (and its SOL spoken for)
    this.lp.registry.settleSwap(id, 'confirmed', { solIn: d.lamports < 0n ? -d.lamports : 0n, usdcOut: d.tokens > 0n ? d.tokens : 0n });
  }
}
