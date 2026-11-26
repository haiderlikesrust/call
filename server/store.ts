// SQLite ledger. Ids from the pump.fun API are stored hashed so the ledger survives the
// 24h purge of API data (Developer API Terms 8.7) without keeping the data itself.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Pots } from './rewards.ts';

export type Status = 'maturing' | 'ready' | 'sending' | 'paid' | 'rejected' | 'expired';
export interface Callout {
  id: string; callout_id: string | null; wallet: string; user_hash: string;
  created_at: number; seen_at: number; status: Status; reason: string | null;
  username: string | null; avatar: string | null; thesis: string | null; likes: number | null;
  followers: number | null; api_at: number | null;
  min_balance: string; supply: string; score: number; ready_at: number | null;
  amount: string | null; burn: string | null; payout_id: number | null; paid_at: number | null; attempts: number;
}
export interface Payout { id: number; sig: string; last_valid: number; status: string; total: string; at: number }
export interface Burn {
  id: number; at: number; kind: 'buyback' | 'direct'; status: 'swapping' | 'swapped' | 'burning' | 'done' | 'failed';
  pump_in: string; coin_out: string | null; swap_sig: string | null; burn_sig: string | null; last_valid: number;
}

export const hash = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 32);

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    // During an update two servers share this file: one writes, the other only reads. Wait, do not fail.
    this.db = new DatabaseSync(path, { timeout: 5000 });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS callouts (
        id TEXT PRIMARY KEY, callout_id TEXT, wallet TEXT NOT NULL, user_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL, seen_at INTEGER NOT NULL, status TEXT NOT NULL, reason TEXT,
        username TEXT, avatar TEXT, thesis TEXT, likes INTEGER, followers INTEGER, api_at INTEGER,
        min_balance TEXT NOT NULL, supply TEXT NOT NULL, score REAL NOT NULL DEFAULT 0, ready_at INTEGER,
        amount TEXT, burn TEXT, payout_id INTEGER, paid_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS ix_status ON callouts(status, ready_at);
      CREATE INDEX IF NOT EXISTS ix_wallet ON callouts(wallet, seen_at);
      CREATE INDEX IF NOT EXISTS ix_user ON callouts(user_hash, seen_at);
      CREATE TABLE IF NOT EXISTS payouts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, sig TEXT NOT NULL, last_valid INTEGER NOT NULL,
        status TEXT NOT NULL, total TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS burns (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
        pump_in TEXT NOT NULL, coin_out TEXT, swap_sig TEXT, burn_sig TEXT, last_valid INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS intakes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, amount TEXT NOT NULL,
        to_reward TEXT NOT NULL, to_burn TEXT NOT NULL);
    `);
  }

  get(k: string): string | null {
    return (this.db.prepare('SELECT v FROM meta WHERE k = ?').get(k) as { v: string } | undefined)?.v ?? null;
  }
  set(k: string, v: string): void {
    this.db.prepare('INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);
  }
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** burn = everything set aside for burning; due = the part paid callouts have released. */
  pots(): Pots & { due: bigint } {
    return { reward: BigInt(this.get('pot_reward') ?? '0'), burn: BigInt(this.get('pot_burn') ?? '0'), due: BigInt(this.get('burn_due') ?? '0') };
  }
  setPots(p: Pots & { due: bigint }): void {
    if (p.reward < 0n || p.burn < 0n || p.due < 0n) throw new Error('negative pot');
    this.set('pot_reward', p.reward.toString());
    this.set('pot_burn', p.burn.toString());
    this.set('burn_due', (p.due > p.burn ? p.burn : p.due).toString());
  }

  callout(id: string): Callout | undefined {
    return this.db.prepare('SELECT * FROM callouts WHERE id = ?').get(id) as unknown as Callout | undefined;
  }
  byStatus(status: Status, limit = 1000): Callout[] {
    return this.db.prepare('SELECT * FROM callouts WHERE status = ? ORDER BY COALESCE(ready_at, seen_at), id LIMIT ?').all(status, limit) as unknown as Callout[];
  }
  byPayout(payoutId: number): Callout[] {
    return this.db.prepare('SELECT * FROM callouts WHERE payout_id = ?').all(payoutId) as unknown as Callout[];
  }
  insert(c: Pick<Callout, 'id' | 'callout_id' | 'wallet' | 'user_hash' | 'created_at' | 'seen_at' | 'status' | 'reason' | 'username' | 'avatar' | 'thesis' | 'likes' | 'followers' | 'api_at' | 'min_balance' | 'supply' | 'score'>): void {
    this.db.prepare(`INSERT OR IGNORE INTO callouts
      (id, callout_id, wallet, user_hash, created_at, seen_at, status, reason, username, avatar, thesis, likes, followers, api_at, min_balance, supply, score)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(c.id, c.callout_id, c.wallet, c.user_hash, c.created_at, c.seen_at, c.status, c.reason, c.username, c.avatar, c.thesis, c.likes, c.followers, c.api_at, c.min_balance, c.supply, c.score);
  }
  patch(id: string, p: Partial<Callout>): void {
    const keys = Object.keys(p) as (keyof Callout)[];
    if (!keys.length) return;
    this.db.prepare(`UPDATE callouts SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...keys.map((k) => p[k] ?? null), id);
  }
  /** Latest rewarded-or-in-progress callout for this wallet or this pump.fun user. */
  lastRewardedAt(wallet: string, userHash: string): number | null {
    const row = this.db.prepare(`SELECT MAX(seen_at) AS t FROM callouts
      WHERE (wallet = ? OR user_hash = ?) AND status IN ('maturing', 'ready', 'sending', 'paid')`).get(wallet, userHash) as { t: number | null };
    return row.t;
  }
  /**
   * Rewarded callouts in a row, newest first, where this wallet kept its bag: each one held at least
   * as much as the one before it, and `low` (the bag now) is at least the last one. A callout that was
   * dropped because the holder sold ends the run.
   */
  holdStreak(wallet: string, low: bigint, before: number): number {
    const rows = this.db.prepare(`SELECT status, reason, min_balance FROM callouts
      WHERE wallet = ? AND seen_at < ? AND (status = 'paid' OR (status = 'rejected' AND reason = 'sold'))
      ORDER BY seen_at DESC LIMIT 60`).all(wallet, before) as { status: string; reason: string | null; min_balance: string }[];
    let need = low, n = 0;
    for (const row of rows) {
      const held = BigInt(row.min_balance);
      if (row.status !== 'paid' || held > need) break;
      n++;
      need = held;
    }
    return n;
  }
  /** Already has a callout waiting to mature or be paid. */
  hasOpen(wallet: string, userHash: string): boolean {
    return this.db.prepare(`SELECT 1 FROM callouts
      WHERE (wallet = ? OR user_hash = ?) AND status IN ('maturing', 'ready', 'sending') LIMIT 1`).get(wallet, userHash) !== undefined;
  }

  addPayout(sig: string, lastValid: number, total: bigint, at: number): number {
    return Number(this.db.prepare("INSERT INTO payouts(sig, last_valid, status, total, at) VALUES(?, ?, 'sending', ?, ?)").run(sig, lastValid, total.toString(), at).lastInsertRowid);
  }
  setPayout(id: number, status: string): void {
    this.db.prepare('UPDATE payouts SET status = ? WHERE id = ?').run(status, id);
  }
  pendingPayouts(): Payout[] {
    return this.db.prepare("SELECT * FROM payouts WHERE status = 'sending'").all() as unknown as Payout[];
  }
  addBurn(b: Pick<Burn, 'at' | 'kind' | 'status' | 'pump_in'> & Partial<Burn>): number {
    return Number(this.db.prepare('INSERT INTO burns(at, kind, status, pump_in, coin_out, swap_sig, burn_sig, last_valid) VALUES(?, ?, ?, ?, ?, ?, ?, ?)')
      .run(b.at, b.kind, b.status, b.pump_in, b.coin_out ?? null, b.swap_sig ?? null, b.burn_sig ?? null, b.last_valid ?? 0).lastInsertRowid);
  }
  patchBurn(id: number, p: Partial<Burn>): void {
    const keys = Object.keys(p) as (keyof Burn)[];
    this.db.prepare(`UPDATE burns SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => p[k] ?? null), id);
  }
  openBurns(): Burn[] {
    return this.db.prepare("SELECT * FROM burns WHERE status IN ('swapping', 'swapped', 'burning') ORDER BY id").all() as unknown as Burn[];
  }
  addIntake(at: number, amount: bigint, toReward: bigint, toBurn: bigint): void {
    this.db.prepare('INSERT INTO intakes(at, amount, to_reward, to_burn) VALUES(?, ?, ?, ?)').run(at, amount.toString(), toReward.toString(), toBurn.toString());
  }

  /** First live boot: callouts collected while payouts were off do not turn into real payments. */
  dropRehearsal(): void {
    this.db.exec("UPDATE callouts SET status = 'expired', reason = 'rehearsal' WHERE status IN ('maturing', 'ready')");
  }

  /** Drop everything that came from the pump.fun API and is older than 24h. */
  purge(now: number): void {
    this.db.prepare(`UPDATE callouts SET username = NULL, avatar = NULL, thesis = NULL, likes = NULL, followers = NULL,
      callout_id = CASE WHEN status IN ('maturing', 'ready', 'sending') THEN callout_id ELSE NULL END, api_at = NULL
      WHERE api_at IS NOT NULL AND api_at < ?`).run(now - 23.5 * 3_600_000);
  }
}
