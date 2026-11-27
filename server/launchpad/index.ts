// The launchpad, which is the whole site: coins launched here, each run by its own payout engine over its own ledger
// file. They share the launchpad wallet, one gentle set of pump.fun rate limits, and take turns.
//
// One of them can be the platform coin (PLATFORM_MINT). It is launched here like any other, keeps all of its own
// fees, and is also paid the platform share of every other coin's fees.
import { existsSync, mkdirSync } from 'node:fs';
import { Connection, type Keypair } from '@solana/web3.js';
import { LAMPORTS, config, launchpad, rewardBpsOf, rules as baseRules, split as baseSplit, type Mode, type Rules, type Split } from '../config.ts';
import { keypair } from '../chain.ts';
import { DemoChain, DemoSource, DemoWorld } from '../demo.ts';
import { Engine } from '../engine.ts';
import { Lane, LiveSource, type Lanes } from '../pumpApi.ts';
import { UNIT } from '../rewards.ts';
import { Store } from '../store.ts';
import { snapshot } from '../view.ts';
import { LaunchError, Launcher, validate } from './build.ts';
import { LaunchChain } from './chain.ts';
import { Registry, type Coin } from './registry.ts';
import { DEMO_COINS } from './demoCoins.ts';

const MIN_POLL_MS = 10_000;
/** Every this many reads of a coin, read deeper in case a callout slotted in below one already recorded. */
const SWEEP_EVERY = 30;

interface Running {
  coin: Coin; store: Store; engine: Engine; polled: number; reads: number; claimed: number;
  /** Demo only: the invented world behind this coin, and the SOL its invented fees came to. */
  world?: DemoWorld; demoSol?: number;
}

/** A coin's split. The platform coin keeps the platform share for itself, in its own reward-to-burn ratio. */
export function splitFor(isPlatform: boolean, s: Split = baseSplit): Split {
  if (!isPlatform) return { ...s };
  // Exact, not rounded: the engine's basis points come from these. The site rounds them for display.
  const kept = s.reward + s.burn;
  const reward = kept > 0 ? (s.reward / kept) * 100 : 100;
  return { reward, burn: 100 - reward, platform: 0 };
}

/** The rules as the engine sees them: the platform share has already left by the time fees reach a coin's pots. */
export function coinRules(s: Split, base: Rules = baseRules): Rules {
  return { ...base, rewardBps: rewardBpsOf(s) };
}

export class Launchpad {
  readonly registry: Registry;
  readonly key: Keypair | null;
  readonly mode: Mode;
  private readonly launcher: Launcher | null;
  private readonly conn: Connection | null;
  private readonly running = new Map<string, Running>();
  private readonly lanes: Lanes = { positions: new Lane(50), gmgn: new Lane(1), callout: new Lane(40), overview: new Lane(25) };
  private turn = 0;
  private listCache: { at: number; v: ReturnType<Launchpad['buildList']> } | null = null;
  stopping = false;
  /** Finish the current step everywhere, start no new one. */
  stop(): void {
    this.stopping = true;
    for (const r of this.running.values()) r.engine.stopping = true;
  }

  constructor(mode: Mode) {
    this.mode = mode;
    const demo = mode === 'demo';
    if (!demo) mkdirSync(`${launchpad.dir}/coins`, { recursive: true });
    this.registry = new Registry(demo ? ':memory:' : launchpad.dir);
    this.key = !demo && launchpad.secret ? keypair(launchpad.secret) : null;
    this.conn = demo ? null : new Connection(config.rpcUrl, 'confirmed');
    this.launcher = this.key && this.conn ? new Launcher(this.key, this.registry, this.conn) : null;
    if (demo) this.seedDemo();
  }

  /** Launches are open with a launchpad wallet, outside the demo. */
  get canLaunch(): boolean { return this.launcher !== null; }
  isPlatform(mint: string): boolean { return !!launchpad.platformMint && mint === launchpad.platformMint; }
  get platformMint(): string | null { return launchpad.platformMint || (this.mode === 'demo' ? DEMO_COINS[0]!.mint : null); }

  /** Opens an engine for every live coin not open yet. Standby servers call it too, to show coins launched meanwhile. */
  private sync(): void {
    for (const coin of this.registry.coins('live')) if (!this.running.has(coin.mint)) this.open(coin);
  }
  private open(coin: Coin): Running {
    const platform = coin.mint === this.platformMint;
    const s = splitFor(platform);
    const demo = this.mode === 'demo';
    const world = demo ? new DemoWorld() : undefined;
    const store = new Store(demo ? ':memory:' : `${launchpad.dir}/coins/${coin.mint}.db`);
    const source = world ? new DemoSource(world) : new LiveSource({ mint: coin.mint, lanes: this.lanes, gmgn: false, everyMs: MIN_POLL_MS });
    const chain = world ? new DemoChain(world) : new LaunchChain({
      mint: coin.mint, signer: this.key, live: config.live, conn: this.conn!, registry: this.registry, store,
      platformPct: baseSplit.platform, isPlatform: () => this.isPlatform(coin.mint),
      minClaimSol: launchpad.minClaimSol, minSwapSol: launchpad.minSwapSol,
    });
    const lp = this.key?.publicKey.toBase58();
    // The launcher is this coin's dev (pump.fun sees the launchpad as its creator), so they cannot earn from it.
    const exclude = new Set([...config.excludeWallets, coin.launcher, ...(lp ? [lp] : [])]);
    const rules = coinRules(s);
    // The demo plays the same movie faster: 8s to mature instead of 2 minutes.
    if (demo) Object.assign(rules, { holdMinutes: 8 / 60, cooldownMinutes: 0.5 });
    const engine = new Engine({ store, source, chain, rules, mode: this.mode, burnMode: 'buyback', minBurn: config.minBurn, exclude, start: () => (demo ? 0 : coin.created_at) });
    engine.setMaxListeners(0);
    const r: Running = { coin, store, engine, polled: 0, reads: 0, claimed: 0, world, demoSol: 0 };
    this.running.set(coin.mint, r);
    if (this.mode === 'live' && !store.get('live_since')) {
      store.dropRehearsal();
      store.set('live_since', String(Date.now()));
    }
    return r;
  }

  // ---------------------------------------------------------------- worker

  /** Starts the launchpad's loops. Called once this server owns the worker. */
  start(loop: (ms: () => number, fn: () => Promise<unknown>) => void): void {
    if (this.mode === 'demo') return this.runDemo(loop);
    this.sync();
    if (this.launcher) void this.launcher.lookupTable().catch((e) => console.error('[launchpad] lookup table:', e instanceof Error ? e.message : e));
    loop(() => 10_000, () => this.checkLaunches());
    // One coin at a time, round robin; the shared limits pace them.
    loop(() => 1_000, () => this.pollNext());
    loop(() => 20_000, () => this.each((r) => r.engine.mature()));
    loop(() => 15_000, () => this.each((r) => {
      const claim = Date.now() - r.claimed > config.claimEveryMs;
      if (claim) r.claimed = Date.now();
      return r.engine.payCycle({ claim });
    }));
    loop(() => 600_000, async () => {
      for (const r of this.running.values()) r.store.purge(Date.now());
      this.registry.dropStale(Date.now() - 86_400_000);
    });
  }
  private async each(fn: (r: Running) => Promise<unknown>): Promise<void> {
    for (const r of [...this.running.values()]) {
      if (this.stopping) return;
      await fn(r).catch((e) => console.error(`[${r.coin.symbol}]`, e instanceof Error ? e.message : e));
    }
  }
  private async pollNext(): Promise<void> {
    const list = [...this.running.values()];
    if (!list.length) return;
    const r = list[this.turn++ % list.length]!;
    if (Date.now() - r.polled < MIN_POLL_MS) return;
    r.polled = Date.now();
    r.reads++;
    await r.engine.poll(r.reads % SWEEP_EVERY === 0 ? { pages: 3, sweep: true } : {});
  }
  /** Launches waiting to land: open the ones that did, drop the ones whose transaction can no longer land. */
  async checkLaunches(): Promise<void> {
    if (!this.launcher) return;
    for (const c of this.registry.coins('pending')) await this.check(c).catch((e) => console.error('[launchpad] check:', e instanceof Error ? e.message : e));
  }
  private async check(c: Coin): Promise<Coin['status']> {
    if (await this.launcher!.landed(c.mint)) {
      this.registry.setStatus(c.mint, 'live', Date.now());
      console.log(`[launchpad] ${c.symbol} launched: ${c.mint}`);
      this.sync();
      return 'live';
    }
    if (await this.launcher!.expired(c.last_valid)) {
      this.registry.setStatus(c.mint, 'failed');
      return 'failed';
    }
    return 'pending';
  }

  // ---------------------------------------------------------------- demo

  private seedDemo(): void {
    const now = Date.now();
    DEMO_COINS.forEach((c, i) => this.registry.addCoin({ ...c, image: '', uri: '', created_at: now - c.ageHours * 3_600_000, last_valid: 0, dev_buy: '0', launcher: `demo-launcher-${i}` }, 'live'));
    this.sync();
  }
  /** Invented callouts and fees on every demo coin, driving the real engines with the real reward maths. */
  private runDemo(loop: (ms: () => number, fn: () => Promise<unknown>) => void): void {
    const list = [...this.running.values()];
    list.forEach((r, i) => {
      const w = r.world!;
      const platform = r.coin.mint === this.platformMint;
      const scale = platform ? 3 : 1 / (1 + i * 0.35);
      for (let k = 10; k > 0; k--) w.callout(Date.now() - k * 9000);
      w.treasury = BigInt(Math.round((platform ? 9_000 : 600 + Math.random() * 2_400) * scale)) * UNIT;
      r.demoSol = Number(w.treasury) / Number(UNIT) / 190;
      loop(() => (2600 + Math.random() * 6000) / Math.max(0.4, scale), async () => w.callout());
      loop(() => 6000 + Math.random() * 3000, async () => {
        const usdc = (20 + Math.random() * 240) * scale;
        w.treasury += BigInt(Math.round(usdc)) * UNIT;
        r.demoSol! += usdc / 190;
      });
      loop(() => 1200, () => r.engine.poll());
      loop(() => 1500, () => r.engine.mature());
      loop(() => 4000, () => r.engine.payCycle());
    });
  }

  // ---------------------------------------------------------------- launching

  async prepare(body: Record<string, unknown>) {
    if (!this.launcher) throw new LaunchError(this.mode === 'demo' ? 'Launches are off in the demo.' : 'Launches are not open yet.');
    const input = validate(body);
    const out = await this.launcher.prepare(input);
    this.registry.addCoin({
      mint: out.mint, name: input.name, symbol: input.symbol.toUpperCase(), description: input.description, image: out.image, uri: out.uri,
      website: input.website || null, twitter: input.twitter || null, telegram: input.telegram || null,
      launcher: input.launcher, created_at: Date.now(), last_valid: out.lastValid, dev_buy: String(input.devBuy),
    });
    this.listCache = null;
    return { mint: out.mint, tx: out.tx };
  }
  /** The launcher's browser reports a sent launch. The chain decides; this only checks sooner. */
  async submitted(mint: string): Promise<{ status: Coin['status'] }> {
    const c = this.registry.coin(mint);
    if (!c) throw new LaunchError('Unknown launch.');
    if (c.status !== 'pending' || !this.launcher) return { status: c.status };
    const status = await this.check(c);
    this.listCache = null;
    return { status };
  }

  // ---------------------------------------------------------------- views

  /** SOL in fees this coin has brought in, and the platform share it sent on. */
  private sol(r: Running): { fees: number; toPlatform: number; fromOthers: number } {
    const platform = r.coin.mint === this.platformMint;
    if (r.world) {
      const fees = r.demoSol ?? 0;
      const others = [...this.running.values()].filter((x) => x !== r).reduce((n, x) => n + (x.demoSol ?? 0), 0);
      return { fees, toPlatform: platform ? 0 : (fees * baseSplit.platform) / 100, fromOthers: platform ? (others * baseSplit.platform) / 100 : 0 };
    }
    const toSol = (v: bigint) => Number(v) / LAMPORTS;
    return {
      fees: toSol(this.registry.feesSol(r.coin.mint)),
      toPlatform: toSol(this.registry.forwarded(r.coin.mint)),
      fromOthers: platform && this.isPlatform(r.coin.mint) ? toSol(this.registry.forwarded() - this.registry.forwarded(r.coin.mint)) : 0,
    };
  }

  private stats(r: Running) {
    const st = r.store.db.prepare(`SELECT COUNT(*) AS n, SUM(status = 'paid') AS paid, SUM(CASE WHEN status = 'paid' THEN CAST(amount AS REAL) END) / 1e6 AS total,
      SUM(seen_at > ?) AS recent FROM callouts`).get(Date.now() - 3_600_000) as { n: number; paid: number | null; total: number | null; recent: number | null };
    const burned = r.store.db.prepare("SELECT SUM(CAST(coin_out AS REAL)) / 1e6 AS coin FROM burns WHERE status = 'done'").get() as { coin: number | null };
    const sol = this.sol(r);
    return {
      callouts: st.n, paidCallouts: st.paid ?? 0, paidOut: st.total ?? 0, lastHour: st.recent ?? 0,
      pot: Number(r.store.pots().reward) / 1e6, burned: burned.coin ?? 0,
      feesSol: sol.fees, toPlatformSol: sol.toPlatform, fromOthersSol: sol.fromOthers,
    };
  }

  list() {
    if (!this.listCache || Date.now() - this.listCache.at > 2_000) this.listCache = { at: Date.now(), v: this.buildList() };
    return this.listCache.v;
  }
  private buildList() {
    this.sync();
    const platform = this.platformMint;
    // Hidden coins keep running (fees, swaps, payouts owed); they are only left off the site.
    const coins = [...this.running.values()].filter((r) => !config.hiddenCoins.has(r.coin.mint)).sort((a, b) => b.coin.created_at - a.coin.created_at)
      .map((r) => ({ ...publicCoin(r.coin), platform: r.coin.mint === platform, ...this.stats(r) }));
    const sum = (k: 'paidOut' | 'paidCallouts' | 'feesSol' | 'toPlatformSol' | 'callouts') => coins.reduce((n, c) => n + c[k], 0);
    const v = {
      site: config.siteName, xUrl: config.xUrl, canLaunch: this.canLaunch, mode: this.mode, feeSol: launchpad.feeSol, maxDevBuySol: launchpad.maxDevBuySol,
      split: baseSplit, platform: coins.find((c) => c.platform) ?? null,
      totals: { coins: coins.length, paidOut: sum('paidOut'), paidCallouts: sum('paidCallouts'), callouts: sum('callouts'), feesSol: sum('feesSol'), toPlatformSol: sum('toPlatformSol') },
      coins,
    };
    return v;
  }
  view(mint: string, build: string) {
    if (config.hiddenCoins.has(mint)) return null;
    this.sync();
    const r = this.running.get(mint);
    if (!r) {
      const c = this.registry.coin(mint);
      return c && c.status === 'pending' ? { coin: publicCoin(c), pending: true as const } : null;
    }
    const platform = r.coin.mint === this.platformMint;
    return {
      coin: { ...publicCoin(r.coin), platform },
      sol: this.sol(r),
      platformSymbol: this.platformMint ? this.running.get(this.platformMint)?.coin.symbol ?? null : null,
      state: snapshot(r.engine, this.mode, r.coin.created_at, build, { coin: { mint, symbol: r.coin.symbol, xUrl: r.coin.twitter ?? '' }, split: splitFor(platform) }),
    };
  }
  /** A file under /media, when the metadata is hosted here. */
  media(file: string): string | null {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}\.(png|jpg|gif|webp|json)$/.test(file)) return null;
    const p = `${launchpad.dir}/media/${file}`;
    return existsSync(p) ? p : null;
  }
}

const publicCoin = (c: Coin) => ({
  mint: c.mint, name: c.name, symbol: c.symbol, description: c.description, image: c.image,
  website: c.website, twitter: c.twitter, telegram: c.telegram, launcher: c.launcher, createdAt: c.created_at,
});
export type LaunchpadList = ReturnType<Launchpad['list']>;
export type ListedCoin = LaunchpadList['coins'][number];
export type LaunchpadCoin = ReturnType<typeof publicCoin>;
export type LaunchpadView = NonNullable<ReturnType<Launchpad['view']>>;
