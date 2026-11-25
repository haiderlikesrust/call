// Builds the public snapshot. Only what the site shows; never keys, never raw API payloads.
import { config, rules, PUMP_MINT, type Mode } from './config.ts';
import type { Engine } from './engine.ts';
import { aging, drain, rewardFor } from './rewards.ts';
import type { Callout } from './store.ts';

const N = (v: string | bigint | null): number => Number(v ?? 0) / 1e6;

function publicCallout(c: Callout, sig: string | null, est: number | null) {
  const supply = BigInt(c.supply);
  return {
    id: c.id, wallet: c.wallet, username: c.username, avatar: c.avatar, thesis: c.thesis, followers: c.followers,
    createdAt: c.created_at, seenAt: c.seen_at, readyAt: c.ready_at, paidAt: c.paid_at, status: c.status, reason: c.reason,
    holdPct: supply > 0n ? Number((BigInt(c.min_balance) * 1_000_000n) / supply) / 10_000 : 0,
    score: c.score, amount: c.amount ? N(c.amount) : null, burn: c.burn ? N(c.burn) : null, estimate: est, sig,
  };
}
export type PublicCallout = ReturnType<typeof publicCallout>;

export function snapshot(e: Engine, mode: Mode, startedAt: number, build: string) {
  const db = e.store.db;
  const pots = e.store.pots();
  const now = e.now();
  const one = <T>(sql: string, ...a: (string | number)[]) => db.prepare(sql).get(...a) as T;
  const sigs = new Map((db.prepare('SELECT id, sig FROM payouts ORDER BY id DESC LIMIT 500').all() as { id: number; sig: string }[]).map((p) => [p.id, p.sig]));
  const est = (c: Callout) => (c.status === 'ready' || c.status === 'maturing'
    ? N(rewardFor(pots.reward, c.score, c.ready_at ? aging((now - c.ready_at) / 3_600_000, rules) : 1, rules)) : null);
  const pub = (c: Callout) => publicCallout(c, c.status === 'paid' && c.payout_id ? sigs.get(c.payout_id) ?? null : null, est(c));

  const queue = e.store.byStatus('ready', 200);
  const payable = new Set(drain(queue.map((c) => ({ id: c.id, score: c.score, readyAt: c.ready_at ?? c.seen_at })), { reward: pots.reward, burn: pots.burn - pots.due }, now, rules).payments.map((p) => p.id));
  const feed = db.prepare('SELECT * FROM callouts ORDER BY seen_at DESC, id LIMIT 30').all() as unknown as Callout[];
  const board = db.prepare(`SELECT wallet, MAX(username) AS username, MAX(avatar) AS avatar, MAX(followers) AS followers,
      COUNT(*) AS n, SUM(CAST(amount AS REAL)) / 1e6 AS total FROM callouts WHERE status = 'paid' GROUP BY wallet ORDER BY total DESC LIMIT 10`).all() as {
    wallet: string; username: string | null; avatar: string | null; followers: number | null; n: number; total: number }[];
  const burns = db.prepare("SELECT * FROM burns WHERE status = 'done' ORDER BY id DESC LIMIT 8").all() as { id: number; at: number; pump_in: string; coin_out: string | null; burn_sig: string }[];
  const stat = one<{ n: number; paid: number; total: number | null }>("SELECT COUNT(*) AS n, SUM(status = 'paid') AS paid, SUM(CASE WHEN status = 'paid' THEN CAST(amount AS REAL) END) / 1e6 AS total FROM callouts");
  const burned = one<{ pump: number | null; coin: number | null }>("SELECT SUM(CAST(pump_in AS REAL)) / 1e6 AS pump, SUM(CAST(coin_out AS REAL)) / 1e6 AS coin FROM burns WHERE status = 'done'");
  const income = one<{ t: number | null }>('SELECT SUM(CAST(amount AS REAL)) / 1e6 AS t FROM intakes WHERE CAST(amount AS REAL) > 0').t ?? 0;

  return {
    at: now, mode, startedAt, build,
    coin: { mint: config.coinMint, symbol: config.coinSymbol, pumpMint: PUMP_MINT, xUrl: config.xUrl, burnMode: config.burnMode },
    pots: { reward: N(pots.reward), burn: N(pots.burn), due: N(pots.due) },
    stats: { callouts: stat.n, paidCallouts: stat.paid ?? 0, paidOut: stat.total ?? 0, burnedPump: burned.pump ?? 0, burnedCoin: burned.coin ?? 0, income, queue: queue.length, pollMs: config.pollMs },
    feed: feed.map(pub),
    queue: queue.slice(0, 40).map((c) => ({ ...pub(c), payableNow: payable.has(c.id) })),
    board: board.map((b) => ({ ...b })),
    burns: burns.map((b) => ({ id: b.id, at: b.at, pump: N(b.pump_in), coin: b.coin_out ? N(b.coin_out) : null, sig: b.burn_sig })),
    rules,
    health: { source: e.source.health.ok, note: e.source.health.note, problems: [...e.problems.keys()] },
  };
}
export type Snapshot = ReturnType<typeof snapshot>;
