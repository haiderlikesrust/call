// The launchpad's own ledger: which coins were launched here, every fee claim with the SOL it brought in, and
// every SOL-to-USDC swap. All coins share one wallet, so this (with each coin's payout ledger) is what keeps their
// money apart: a coin can only ever swap the SOL its own claims brought in, and only pay the USDC its swaps made.
//
// The platform coin is paid the platform share of every other coin's claims, so its SOL is its own claims plus
// those shares. Until a platform coin is set, the shares wait in the wallet and are counted as owed.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';

export type CoinStatus = 'pending' | 'live' | 'failed';
export interface Coin {
  mint: string; name: string; symbol: string; description: string; image: string; uri: string;
  website: string | null; twitter: string | null; telegram: string | null;
  launcher: string; created_at: number; status: CoinStatus; last_valid: number; dev_buy: string;
}
export type TxStatus = 'sending' | 'confirmed' | 'failed' | 'expired';
export interface Claim { id: number; mint: string; sig: string; last_valid: number; status: TxStatus; net: string | null; forward: string; at: number }
export interface Swap { id: number; mint: string; sig: string; last_valid: number; status: TxStatus; sol_in: string; usdc_out: string | null; at: number }

const big = (v: unknown): bigint => (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint' ? BigInt(v) : 0n);

export class Registry {
  readonly db: DatabaseSync;

  constructor(dir: string) {
    if (dir !== ':memory:') mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(dir === ':memory:' ? ':memory:' : `${dir}/registry.db`, { timeout: 5000 });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS coins (
        mint TEXT PRIMARY KEY, name TEXT NOT NULL, symbol TEXT NOT NULL, description TEXT NOT NULL, image TEXT NOT NULL, uri TEXT NOT NULL,
        website TEXT, twitter TEXT, telegram TEXT, launcher TEXT NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL,
        last_valid INTEGER NOT NULL, dev_buy TEXT NOT NULL DEFAULT '0');
      CREATE INDEX IF NOT EXISTS ix_coin_status ON coins(status, created_at);
      CREATE TABLE IF NOT EXISTS sol_claims (
        id INTEGER PRIMARY KEY AUTOINCREMENT, mint TEXT NOT NULL, sig TEXT NOT NULL, last_valid INTEGER NOT NULL, status TEXT NOT NULL,
        net TEXT, forward TEXT NOT NULL DEFAULT '0', at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS ix_claim_mint ON sol_claims(mint, status);
      CREATE TABLE IF NOT EXISTS swaps (
        id INTEGER PRIMARY KEY AUTOINCREMENT, mint TEXT NOT NULL, sig TEXT NOT NULL, last_valid INTEGER NOT NULL, status TEXT NOT NULL,
        sol_in TEXT NOT NULL, usdc_out TEXT, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS ix_swap_mint ON swaps(mint, status);
    `);
  }

  get(k: string): string | null {
    return (this.db.prepare('SELECT v FROM meta WHERE k = ?').get(k) as { v: string } | undefined)?.v ?? null;
  }
  set(k: string, v: string): void {
    this.db.prepare('INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);
  }

  // ---------------------------------------------------------------- coins

  addCoin(c: Omit<Coin, 'status'>, status: CoinStatus = 'pending'): void {
    this.db.prepare(`INSERT INTO coins(mint, name, symbol, description, image, uri, website, twitter, telegram, launcher, created_at, status, last_valid, dev_buy)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(c.mint, c.name, c.symbol, c.description, c.image, c.uri, c.website, c.twitter, c.telegram, c.launcher, c.created_at, status, c.last_valid, c.dev_buy);
  }
  coin(mint: string): Coin | undefined {
    return this.db.prepare('SELECT * FROM coins WHERE mint = ?').get(mint) as unknown as Coin | undefined;
  }
  coins(status: CoinStatus): Coin[] {
    return this.db.prepare('SELECT * FROM coins WHERE status = ? ORDER BY created_at DESC').all(status) as unknown as Coin[];
  }
  setStatus(mint: string, status: CoinStatus, at?: number): void {
    if (at === undefined) this.db.prepare('UPDATE coins SET status = ? WHERE mint = ?').run(status, mint);
    else this.db.prepare('UPDATE coins SET status = ?, created_at = ? WHERE mint = ?').run(status, at, mint);
  }
  /** A launch nobody signed leaves a pending row; drop those after a day so the table stays small. */
  dropStale(before: number): void {
    this.db.prepare("DELETE FROM coins WHERE status IN ('pending', 'failed') AND created_at < ?").run(before);
  }

  // ---------------------------------------------------------------- fee claims (SOL)

  addClaim(mint: string, sig: string, lastValid: number, at: number): number {
    return Number(this.db.prepare("INSERT INTO sol_claims(mint, sig, last_valid, status, at) VALUES (?, ?, ?, 'sending', ?)").run(mint, sig, lastValid, at).lastInsertRowid);
  }
  openClaims(mint: string): Claim[] {
    return this.db.prepare("SELECT * FROM sol_claims WHERE mint = ? AND status = 'sending' ORDER BY id").all(mint) as unknown as Claim[];
  }
  /**
   * `net` is the wallet's lamport change in the confirmed claim, network fee included. `forward` is the platform
   * share of it, which belongs to the platform coin from then on.
   */
  settleClaim(id: number, status: Exclude<TxStatus, 'sending'>, net: bigint | null, forward = 0n): void {
    this.db.prepare('UPDATE sol_claims SET status = ?, net = ?, forward = ? WHERE id = ?').run(status, net === null ? null : net.toString(), forward.toString(), id);
  }

  // ---------------------------------------------------------------- swaps (SOL to USDC)

  /** Written before broadcast: from this moment the SOL is spoken for, so it can never be swapped twice. */
  addSwap(mint: string, sig: string, lastValid: number, solIn: bigint, at: number): number {
    return Number(this.db.prepare("INSERT INTO swaps(mint, sig, last_valid, status, sol_in, at) VALUES (?, ?, ?, 'sending', ?, ?)").run(mint, sig, lastValid, solIn.toString(), at).lastInsertRowid);
  }
  openSwaps(mint: string): Swap[] {
    return this.db.prepare("SELECT * FROM swaps WHERE mint = ? AND status = 'sending' ORDER BY id").all(mint) as unknown as Swap[];
  }
  /** On confirmation, the SOL it really spent and the USDC it really made, both read from the transaction. */
  settleSwap(id: number, status: Exclude<TxStatus, 'sending'>, got?: { solIn: bigint; usdcOut: bigint }): void {
    if (got) this.db.prepare('UPDATE swaps SET status = ?, sol_in = ?, usdc_out = ? WHERE id = ?').run(status, got.solIn.toString(), got.usdcOut.toString(), id);
    else this.db.prepare('UPDATE swaps SET status = ? WHERE id = ?').run(status, id);
  }

  // ---------------------------------------------------------------- balances

  private sum(sql: string, ...a: string[]): bigint {
    return (this.db.prepare(sql).all(...a) as { v: unknown }[]).reduce((n, r) => n + big(r.v), 0n);
  }
  /** SOL this coin's own claims kept, after the platform share. A claim that cost more than it brought counts as 0. */
  private kept(mint: string): bigint {
    return this.sum("SELECT CAST(net AS INTEGER) - CAST(forward AS INTEGER) AS v FROM sol_claims WHERE mint = ? AND status = 'confirmed' AND CAST(net AS INTEGER) > 0", mint);
  }
  /** The platform share every coin's claims sent to the platform coin (or one coin's, with `mint`). */
  forwarded(mint?: string): bigint {
    return mint
      ? this.sum("SELECT forward AS v FROM sol_claims WHERE mint = ? AND status = 'confirmed' AND CAST(net AS INTEGER) > 0", mint)
      : this.sum("SELECT forward AS v FROM sol_claims WHERE status = 'confirmed' AND CAST(net AS INTEGER) > 0");
  }
  /** All SOL this coin has had: its claims, plus every platform share when it is the platform coin. */
  solIn(mint: string, platform: boolean): bigint {
    return this.kept(mint) + (platform ? this.forwarded() - this.forwarded(mint) : 0n);
  }
  /** SOL in swaps that went through or are still in flight. */
  solSwapped(mint: string): bigint {
    return this.sum("SELECT sol_in AS v FROM swaps WHERE mint = ? AND status IN ('sending', 'confirmed')", mint);
  }
  /** SOL this coin is owed and has not swapped yet. */
  solOwed(mint: string, platform: boolean): bigint {
    const v = this.solIn(mint, platform) - this.solSwapped(mint);
    return v > 0n ? v : 0n;
  }
  /** SOL the wallet holds for coins: every claim's SOL, less every swap. The wallet's own SOL is what is left over. */
  solHeldForCoins(): bigint {
    const v = this.sum("SELECT net AS v FROM sol_claims WHERE status = 'confirmed' AND CAST(net AS INTEGER) > 0")
      - this.sum("SELECT sol_in AS v FROM swaps WHERE status IN ('sending', 'confirmed')");
    return v > 0n ? v : 0n;
  }
  /** USDC this coin's swaps made. */
  usdcIn(mint: string): bigint {
    return this.sum("SELECT usdc_out AS v FROM swaps WHERE mint = ? AND status = 'confirmed'", mint);
  }
  /** SOL claimed in fees for this coin, or for every coin. */
  feesSol(mint?: string): bigint {
    return mint
      ? this.sum("SELECT net AS v FROM sol_claims WHERE mint = ? AND status = 'confirmed' AND CAST(net AS INTEGER) > 0", mint)
      : this.sum("SELECT net AS v FROM sol_claims WHERE status = 'confirmed' AND CAST(net AS INTEGER) > 0");
  }
}
