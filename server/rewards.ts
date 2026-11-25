// Pure reward maths. No I/O, so every rule here is unit-tested.
// Token amounts are bigint base units; only the dimensionless score is a float.
// The site's calculator imports this file too, so what it shows is what the engine pays.
import { PUMP_DECIMALS } from './constants.ts';
import type { Rules } from './config.ts';

export const UNIT = 10n ** BigInt(PUMP_DECIMALS);
export const toUnits = (whole: number): bigint => BigInt(Math.round(whole * Number(UNIT)));
const PPB = 1_000_000_000n;

/** 0..1. Share of supply on a gentle curve, capped at holdFullBps. */
export function holdFactor(balance: bigint, supply: bigint, r: Rules): number {
  if (supply <= 0n || balance <= 0n) return 0;
  const share = Number((balance * PPB) / supply) / Number(PPB);
  return Math.min(1, share / (r.holdFullBps / 10_000)) ** r.holdExponent;
}

/** followFloor..1. Logarithmic: going 100 -> 1k is worth as much as 1k -> 10k. */
export function followFactor(followers: number, r: Rules): number {
  const f = Math.max(0, Number.isFinite(followers) ? followers : 0);
  const t = Math.min(1, Math.log10(1 + f) / Math.log10(1 + r.followersFull));
  return r.followFloor + (1 - r.followFloor) * t;
}

/** 0..1. Multiplicative on purpose: a bag without reach, or reach without a bag, earns little. */
export const score = (balance: bigint, supply: bigint, followers: number, r: Rules): number =>
  holdFactor(balance, supply, r) * followFactor(followers, r);

export function aging(hoursQueued: number, r: Rules): number {
  return Math.min(r.agingCap, 1 + Math.max(0, hoursQueued) * r.agingPerHour);
}

/** reward = pot x maxPotShare x score x aging. A share of the pot, so it can never overdraw it. */
export function rewardFor(pot: bigint, s: number, age: number, r: Rules): bigint {
  if (pot <= 0n || s <= 0) return 0n;
  const ppb = BigInt(Math.floor(Math.min(1, s) * age * Number(PPB)));
  const amount = (pot * BigInt(r.maxPotShareBps) * ppb) / (10_000n * PPB);
  return amount > pot ? pot : amount;
}

export function splitIntake(amount: bigint, r: Rules): { reward: bigint; burn: bigint } {
  const reward = (amount * BigInt(r.rewardBps)) / 10_000n;
  return { reward, burn: amount - reward };
}

/** The burn a paid callout releases: the same 80:20 ratio, capped by what the burn pot holds. */
export function burnFor(reward: bigint, burnPot: bigint, r: Rules): bigint {
  if (r.rewardBps <= 0) return 0n;
  const b = (reward * BigInt(10_000 - r.rewardBps)) / BigInt(r.rewardBps);
  return b > burnPot ? burnPot : b;
}

export interface Pots { reward: bigint; burn: bigint }
export interface QueueItem { id: string; score: number; readyAt: number }
export interface Payment { id: string; amount: bigint; burn: bigint }

/**
 * Walk the queue oldest-first and decide who can be paid from the pots right now.
 * Items whose reward is still below the minimum keep their place and do not block the rest.
 */
export function drain(queue: QueueItem[], pots: Pots, now: number, r: Rules): { payments: Payment[] } & Pots {
  let { reward, burn } = pots;
  const floor = toUnits(r.potFloor);
  const min = toUnits(r.minPayout);
  const payments: Payment[] = [];
  for (const q of [...queue].sort((a, b) => a.readyAt - b.readyAt || (a.id < b.id ? -1 : 1))) {
    if (reward < floor) break;
    const amount = rewardFor(reward, q.score, aging((now - q.readyAt) / 3_600_000, r), r);
    if (amount <= 0n || amount < min) continue;
    const b = burnFor(amount, burn, r);
    reward -= amount;
    burn -= b;
    payments.push({ id: q.id, amount, burn: b });
  }
  return { payments, reward, burn };
}

/**
 * Match the ledger to the wallet. Anything above the ledger is new fee income and is split 80/20.
 * Anything below means $PUMP left the wallet by hand, so both pots shrink in proportion.
 */
export function reconcile(onchain: bigint, pots: Pots, r: Rules): Pots & { intake: bigint; toReward: bigint; toBurn: bigint } {
  const ledger = pots.reward + pots.burn;
  if (onchain >= ledger) {
    const intake = onchain - ledger;
    const s = splitIntake(intake, r);
    return { reward: pots.reward + s.reward, burn: pots.burn + s.burn, intake, toReward: s.reward, toBurn: s.burn };
  }
  const reward = (pots.reward * onchain) / ledger;
  const burn = onchain - reward;
  return { reward, burn, intake: onchain - ledger, toReward: reward - pots.reward, toBurn: burn - pots.burn };
}

export interface Candidate {
  wallet: string;
  balance: bigint;
  supply: bigint;
  followers: number;
  accountCreatedAt: number | null;
  createdAt: number;
  isDev: boolean;
  isGroup: boolean;
  isPumpUser: boolean;
  lowQuality: boolean;
}

export type Reject =
  | 'before-start' | 'excluded' | 'dev' | 'group' | 'not-pump-user' | 'low-quality'
  | 'not-holder' | 'low-holding' | 'low-followers' | 'new-account' | 'in-line' | 'cooldown';

export function eligibility(
  c: Candidate,
  ctx: { start: number; now: number; excluded: boolean; lastRewardedAt: number | null; hasOpen: boolean },
  r: Rules,
): Reject | null {
  if (c.createdAt < ctx.start) return 'before-start';
  if (ctx.excluded) return 'excluded';
  if (c.isDev) return 'dev';
  if (c.isGroup) return 'group';
  if (!c.isPumpUser) return 'not-pump-user';
  if (c.lowQuality) return 'low-quality';
  if (c.balance <= 0n) return 'not-holder';
  if (c.balance * 1_000_000n < c.supply * BigInt(Math.round(r.minHoldBps * 100))) return 'low-holding';
  if (c.followers < r.minFollowers) return 'low-followers';
  if (c.accountCreatedAt !== null && ctx.now - c.accountCreatedAt < r.minAccountAgeDays * 86_400_000) return 'new-account';
  if (ctx.lastRewardedAt !== null && ctx.now - ctx.lastRewardedAt < r.cooldownMinutes * 60_000) return 'cooldown';
  // One at a time, so a dry pot cannot be stacked with tickets from the same person.
  if (ctx.hasOpen) return 'in-line';
  return null;
}
