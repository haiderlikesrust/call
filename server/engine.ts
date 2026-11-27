// The whole life of a callout: seen -> maturing -> ready (queued) -> sending -> paid.
import { EventEmitter } from 'node:events';
import { type Mode, type Rules } from './config.ts';
import type { Chain, Outcome } from './chain.ts';
import { type Account, type Fed, type Listed, type Row, type Source, eventKey, toRow } from './pumpApi.ts';
import { drain, eligibility, reconcile, score, toUnits } from './rewards.ts';
import { type Burn, type Callout, type Store, hash } from './store.ts';

const HOUR = 3_600_000;
const MAX_AGE = 24 * HOUR;
/** A callout the feed should have shown by now. pump.fun lists a holder's callout within seconds; 5 min is slack. */
const LATE = 5 * 60_000;
const BATCH = 5;
const MAX_ATTEMPTS = 5;

export interface EngineOpts {
  store: Store; source: Source; chain: Chain; rules: Rules; mode: Mode;
  burnMode: 'buyback' | 'direct'; minBurn: number; exclude: Set<string>; start: () => number; now?: () => number;
}

export class Engine extends EventEmitter {
  readonly store: Store;
  readonly source: Source;
  readonly chain: Chain;
  readonly rules: Rules;
  readonly mode: Mode;
  readonly now: () => number;
  /** Last problem per subsystem, shown on the site's status strip. */
  readonly problems = new Map<string, string>();
  private readonly o: EngineOpts;
  private paying = false;
  /** Set when the server is shutting down: finish the current step, start no new one. */
  stopping = false;

  constructor(o: EngineOpts) {
    super();
    this.o = o;
    this.store = o.store;
    this.source = o.source;
    this.chain = o.chain;
    this.rules = o.rules;
    this.mode = o.mode;
    this.now = o.now ?? Date.now;
  }

  private async guard<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
    try {
      const out = await fn();
      if (this.problems.delete(name)) this.emit('change');
      return out;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (this.problems.get(name) !== msg) {
        this.problems.set(name, msg);
        console.error(`[${name}]`, msg);
        this.emit('change');
      }
      return undefined;
    }
  }

  // ---------------------------------------------------------------- intake

  /** Holders at or above the minimum bag in the last holder read. */
  watching = 0;
  /** Since when pump.fun's feed has been read with no gap longer than a minute; null after a gap. */
  private coveredSince: number | null = null;
  private lastFeed = 0;

  /**
   * One read. pump.fun's feed lists current holders' callouts, each with its latest updates. Every update is its own
   * event (see eventKey), so calling a coin out again by posting an update counts. The feed is ordered by when each
   * callout was first posted, so a new update can sit on any page: it is read to the end (up to `pages`), not just
   * until a known callout. gmgn's list is added when it answers: it holds callouts the feed lacks, including
   * non-holders, who are recorded and turned away.
   *
   * Callouts from holders with at least the minimum bag (0.1% by default) are judged first, smallest bag up, on
   * pump.fun's data: the feed's own row, or the callout and account overview for one only gmgn has. When pump.fun
   * does not answer, a callout waits for the next read (gmgn and the feed keep it listed for a day). Everyone
   * below the minimum is recorded and turned away, so buying in after calling out never counts.
   */
  async poll(opts: { pages?: number; sweep?: boolean } = {}): Promise<void> {
    const pages = opts.pages ?? 5;
    await this.guard('callouts', async () => {
      const now = this.now();
      const items = new Map<string, Fed & { fed: boolean }>();
      const keep = (l: Listed) => now - l.createdAt <= MAX_AGE && !this.store.callout(hash(eventKey(l)));
      let feedFailed: unknown = null;
      try {
        for (let n = 0; n < pages; n++) {
          const { items: page, hasMore } = await this.source.positions(n);
          for (const it of page) if (keep(it.listed)) items.set(eventKey(it.listed), { ...it, fed: true });
          if (!hasMore || page.length === 0) break;
        }
        this.coveredSince = this.coveredSince !== null && now - this.lastFeed <= 60_000 ? this.coveredSince : now;
        this.lastFeed = now;
      } catch (e) {
        feedFailed = e;
        this.coveredSince = null;
      }
      const listed = await this.source.callouts();
      for (const l of listed ?? []) if (!items.has(eventKey(l)) && keep(l)) items.set(eventKey(l), { listed: l, row: null, fed: false });
      // Neither source answered: nothing to go on this time.
      if (feedFailed && !listed) throw feedFailed;

      const supply = await this.chain.supply();
      // The holder list orders the work and spares an RPC read per non-holder. Qualifying bags are re-read on admission.
      const read = await this.guard('holder list', () => this.chain.holders());
      const all = read?.balances;
      const bag = (w: string) => all?.get(w) ?? 0n;
      const enough = (w: string, b: bigint) => !this.o.exclude.has(w) && !this.belowMin(b, supply);
      const holds = (w: string) => !all || enough(w, bag(w));
      if (all) this.watching = [...all].filter(([w, b]) => enough(w, b)).length;
      const todo = [...items.values()].sort((x, y) => {
        const a = x.listed, b = y.listed;
        return Number(holds(b.wallet)) - Number(holds(a.wallet)) || (bag(a.wallet) < bag(b.wallet) ? -1 : bag(a.wallet) > bag(b.wallet) ? 1 : 0) || a.createdAt - b.createdAt;
      });

      let failed: unknown = feedFailed;
      for (const it of todo) {
        if (this.stopping) break;
        const c = it.listed;
        // Only in the feed, and only now, although the feed was being read when it was made: the wallet was not
        // holding then (the feed lists holders only). That is calling out first and buying in after.
        const late = it.fed && this.coveredSince !== null && this.coveredSince <= c.createdAt && now - c.createdAt > LATE;
        // Below the minimum in the holder list: turned away on that balance, but only if the list was read after
        // the callout. An older list can miss a buy made just before calling out, so that wallet is read again.
        let known = all && !holds(c.wallet) ? bag(c.wallet) : undefined;
        if (known !== undefined && read!.at < c.createdAt) {
          try { known = await this.chain.holding(c.wallet); } catch (e) { failed = e; continue; }
          if (enough(c.wallet, known)) known = undefined;
        }
        let row = it.row;
        if (!row && known === undefined && !late) {
          let a: Account | null;
          try { a = await this.source.account(c); } catch (e) { failed = e; continue; }
          if (!a) continue; // gone from pump.fun: deleted before we got to it
          row = toRow(c, a);
        }
        await this.admit(row ?? toRow(c, null), known, late).catch((e) => { failed = e; });
      }
      if (failed) throw failed;
    });
  }
  /** Slow pass over more of the feed, for coins with more holders than one read covers. */
  sweep(): Promise<void> { return this.poll({ pages: 20, sweep: true }); }

  async admit(r: Row, known?: bigint, late = false): Promise<void> {
    const now = this.now();
    if (now - r.createdAt > MAX_AGE) return;
    const [balance, supply] = await Promise.all([known ?? this.chain.holding(r.wallet), this.chain.supply()]);
    const userHash = hash(r.userId);
    const reason = late ? 'late' : eligibility(
      { ...r, balance, supply },
      { start: this.o.start(), now, excluded: this.o.exclude.has(r.wallet), lastRewardedAt: this.store.lastRewardedAt(r.wallet, userHash), hasOpen: this.store.hasOpen(r.wallet, userHash) },
      this.rules,
    );
    this.store.insert({
      id: hash(eventKey(r)), callout_id: r.calloutId, wallet: r.wallet, user_hash: userHash,
      created_at: r.createdAt, seen_at: now, status: reason ? 'rejected' : 'maturing', reason,
      username: r.username || null, avatar: r.avatar, thesis: r.thesis || null, likes: r.likes, followers: r.followers, api_at: now,
      min_balance: balance.toString(), supply: supply.toString(), score: reason ? 0 : score(balance, supply, r.followers, this.rules, this.store.holdStreak(r.wallet, balance, now)),
    });
    this.emit('callout', hash(eventKey(r)));
    this.emit('change');
  }

  // ---------------------------------------------------------------- maturing

  private reject(c: Callout, reason: string): void {
    this.store.patch(c.id, { status: 'rejected', reason, score: 0 });
    this.emit('change');
  }
  private belowMin(balance: bigint, supply: bigint): boolean {
    return balance <= 0n || balance * 1_000_000n < supply * BigInt(Math.round(this.rules.minHoldBps * 100));
  }

  /** Samples every maturing bag. The lowest balance seen is the one that counts. */
  async mature(): Promise<void> {
    await this.guard('holders', async () => {
      const supply = await this.chain.supply();
      let failed: unknown = null;
      for (const c of this.store.byStatus('maturing')) if (!this.stopping) await this.matureOne(c, supply).catch((e) => { failed = e; });
      if (failed) throw failed;
    });
  }

  private async matureOne(c: Callout, supply: bigint): Promise<void> {
    const bal = await this.chain.holding(c.wallet);
    const low = bal < BigInt(c.min_balance) ? bal : BigInt(c.min_balance);
    if (this.belowMin(low, supply)) return this.reject(c, 'sold');
    if (low !== BigInt(c.min_balance)) this.store.patch(c.id, { min_balance: low.toString() });
    if (this.now() - c.seen_at < this.rules.holdMinutes * 60_000) return;
    if (c.callout_id && !(await this.source.exists(c.callout_id))) return this.reject(c, 'deleted');
    const followers = (await this.source.followers(c.wallet)) ?? c.followers ?? 0;
    if (followers < this.rules.minFollowers) return this.reject(c, 'low-followers');
    this.store.patch(c.id, {
      status: 'ready', ready_at: this.now(), followers, api_at: this.now(),
      supply: supply.toString(), score: score(low, supply, followers, this.rules, this.store.holdStreak(c.wallet, low, c.seen_at)),
    });
    this.emit('change');
  }

  // ---------------------------------------------------------------- money

  /** One pass: settle what is in flight, claim, reconcile, pay the queue, burn. Never overlaps itself. */
  async payCycle(opts: { claim?: boolean } = {}): Promise<void> {
    if (this.paying || this.stopping) return;
    this.paying = true;
    try {
      await this.guard('payouts', async () => {
        if (this.chain.canSign && !(await this.settleInFlight())) return;
        if (this.stopping) return;
        if (opts.claim && this.chain.canSign) await this.guard('fee claim', () => this.chain.claim());
        await this.reconcile();
        this.expire();
        if (!this.chain.canSign) return;
        if (this.stopping) return;
        if (!(await this.chain.solOk())) throw new Error('treasury is low on SOL for network fees');
        await this.payQueue();
        await this.guard('burn', () => this.runBurns());
      });
    } finally {
      this.paying = false;
      this.emit('change');
    }
  }

  /** Returns false while anything is still undecided, so the ledger is never read mid-flight. */
  private async settleInFlight(): Promise<boolean> {
    let clear = true;
    for (const p of this.store.pendingPayouts()) {
      const out = await this.chain.resolve(p.sig, p.last_valid);
      if (out === 'pending') clear = false;
      else this.finishPayout(p.id, out);
    }
    for (const b of this.store.openBurns()) {
      if (b.status === 'swapped') continue;
      const sig = b.status === 'swapping' ? b.swap_sig : b.burn_sig;
      if (!sig) { this.store.patchBurn(b.id, { status: b.status === 'swapping' ? 'failed' : 'swapped' }); continue; }
      const out = await this.chain.resolve(sig, b.last_valid);
      if (out === 'pending') clear = false;
      else if (b.status === 'swapping') await this.finishSwap(b, out);
      else this.finishBurn(b, out);
    }
    return clear;
  }

  private async reconcile(): Promise<void> {
    const onchain = await this.chain.treasuryBalance();
    const pots = this.store.pots();
    const r = reconcile(onchain, pots, this.rules);
    if (r.intake === 0n) return;
    this.store.tx(() => {
      this.store.setPots({ reward: r.reward, burn: r.burn, due: pots.due });
      this.store.addIntake(this.now(), r.intake, r.toReward, r.toBurn);
    });
  }

  private expire(): void {
    const cutoff = this.now() - this.rules.queueExpiryDays * 24 * HOUR;
    for (const c of this.store.byStatus('ready')) if ((c.ready_at ?? 0) < cutoff) this.store.patch(c.id, { status: 'expired', reason: 'expired' });
  }

  private plan() {
    const queue = this.store.byStatus('ready');
    const pots = this.store.pots();
    return drain(queue.map((c) => ({ id: c.id, score: c.score, readyAt: c.ready_at ?? c.seen_at })), { reward: pots.reward, burn: pots.burn - pots.due }, this.now(), this.rules);
  }

  private async payQueue(): Promise<void> {
    // Re-check holders right before paying, then plan again with the fresh scores.
    const supply = await this.chain.supply();
    const checked = new Set<string>();
    for (const p of this.plan().payments.slice(0, 40)) {
      const c = this.store.callout(p.id)!;
      const bal = await this.chain.holding(c.wallet);
      const low = bal < BigInt(c.min_balance) ? bal : BigInt(c.min_balance);
      if (this.belowMin(low, supply)) { this.reject(c, 'sold'); continue; }
      const stale = c.followers === null;
      const followers = stale ? await this.source.followers(c.wallet) : c.followers;
      if (followers === null) { this.reject(c, 'no-profile'); continue; }
      this.store.patch(c.id, {
        min_balance: low.toString(), supply: supply.toString(), score: score(low, supply, followers, this.rules, this.store.holdStreak(c.wallet, low, c.seen_at)),
        ...(stale ? { followers, api_at: this.now() } : {}),
      });
      checked.add(c.id);
    }
    const pay = this.plan().payments.filter((p) => checked.has(p.id));
    const fresh = pay.filter((p) => this.store.callout(p.id)!.attempts === 0);
    const retry = pay.filter((p) => this.store.callout(p.id)!.attempts > 0);
    const groups = [];
    for (let i = 0; i < fresh.length; i += BATCH) groups.push(fresh.slice(i, i + BATCH));
    for (const g of [...groups, ...retry.map((p) => [p])]) if (this.stopping || !(await this.sendBatch(g))) break;
  }

  private async sendBatch(g: { id: string; amount: bigint; burn: bigint }[]): Promise<boolean> {
    const items = g.map((p) => ({ ...p, wallet: this.store.callout(p.id)!.wallet }));
    let payoutId = 0;
    const out = await this.chain.pay(items, (sig, lastValid) => {
      this.store.tx(() => {
        payoutId = this.store.addPayout(sig, lastValid, items.reduce((n, i) => n + i.amount, 0n), this.now());
        for (const i of items) this.store.patch(i.id, { status: 'sending', payout_id: payoutId, amount: i.amount.toString(), burn: i.burn.toString() });
      });
      this.emit('change');
    });
    if (out === 'pending') return false;
    this.finishPayout(payoutId, out);
    return true;
  }

  private finishPayout(id: number, out: Exclude<Outcome, 'pending'>): void {
    const rows = this.store.byPayout(id);
    this.store.tx(() => {
      this.store.setPayout(id, out);
      if (out === 'confirmed') {
        const pots = this.store.pots();
        let { reward, due } = pots;
        for (const c of rows) {
          reward -= BigInt(c.amount ?? '0');
          due += BigInt(c.burn ?? '0');
          this.store.patch(c.id, { status: 'paid', paid_at: this.now() });
        }
        this.store.setPots({ reward, burn: pots.burn, due });
      } else {
        for (const c of rows) {
          const attempts = c.attempts + (out === 'failed' ? 1 : 0);
          this.store.patch(c.id, attempts >= MAX_ATTEMPTS
            ? { status: 'rejected', reason: 'payout-failed', attempts }
            : { status: 'ready', payout_id: null, amount: null, burn: null, attempts });
        }
      }
    });
    if (out === 'confirmed') this.emit('paid', rows.map((c) => c.id));
    this.emit('change');
  }

  // ---------------------------------------------------------------- burns

  private async runBurns(): Promise<void> {
    for (const b of this.store.openBurns()) if (b.status === 'swapped' && !this.stopping) await this.burnCoins(b);
    if (this.stopping || this.store.openBurns().length) return;
    const { due } = this.store.pots();
    if (due < toUnits(this.o.minBurn)) return;
    let id = 0;
    if (this.o.burnMode === 'direct') {
      const out = await this.chain.burn('quote', due, (sig, lastValid) => {
        id = this.store.addBurn({ at: this.now(), kind: 'direct', status: 'burning', pump_in: due.toString(), burn_sig: sig, last_valid: lastValid });
      });
      if (out !== 'pending') this.finishBurn(this.store.openBurns().find((b) => b.id === id)!, out);
      return;
    }
    const out = await this.chain.buyback(due, (sig, lastValid) => {
      id = this.store.addBurn({ at: this.now(), kind: 'buyback', status: 'swapping', pump_in: due.toString(), swap_sig: sig, last_valid: lastValid });
    });
    if (out === 'pending') return;
    const b = this.store.openBurns().find((x) => x.id === id)!;
    await this.finishSwap(b, out);
    const swapped = this.store.openBurns().find((x) => x.id === id && x.status === 'swapped');
    if (swapped && !this.stopping) await this.burnCoins(swapped);
  }
  private spend(pumpIn: bigint): void {
    const p = this.store.pots();
    this.store.setPots({ reward: p.reward, burn: p.burn - pumpIn, due: p.due - pumpIn });
  }
  private async finishSwap(b: Burn, out: Exclude<Outcome, 'pending'>): Promise<void> {
    if (out !== 'confirmed') { this.store.patchBurn(b.id, { status: 'failed' }); return; }
    const got = await this.chain.bought(b.swap_sig!); // throws until indexed; retried next cycle
    this.store.tx(() => {
      this.spend(BigInt(b.pump_in));
      this.store.patchBurn(b.id, { status: 'swapped', coin_out: got.toString() });
    });
  }
  private async burnCoins(b: Burn): Promise<void> {
    const out = await this.chain.burn('coin', BigInt(b.coin_out ?? '0'), (sig, lastValid) => this.store.patchBurn(b.id, { status: 'burning', burn_sig: sig, last_valid: lastValid }));
    if (out !== 'pending') this.finishBurn(b, out);
  }
  private finishBurn(b: Burn, out: Exclude<Outcome, 'pending'>): void {
    if (b.kind === 'direct') {
      this.store.tx(() => {
        if (out === 'confirmed') this.spend(BigInt(b.pump_in));
        this.store.patchBurn(b.id, { status: out === 'confirmed' ? 'done' : 'failed' });
      });
    } else {
      this.store.patchBurn(b.id, { status: out === 'confirmed' ? 'done' : 'swapped' });
    }
    if (out === 'confirmed') this.emit('burned', b.id);
    this.emit('change');
  }
}
