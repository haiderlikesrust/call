// Every tunable lives here. Values come from .env; nothing secret is ever sent to the browser.
// Values are checked by settings.ts before the server starts, so a bad one stops it with a clear message.
const env = process.env;

/** Not a number: the default for now. settings.ts reports it and stops the server before it is used. */
const num = (k: string, d: number): number => {
  const raw = env[k]?.trim();
  if (!raw) return d;
  const n = Number(raw);
  return Number.isFinite(n) ? n : d;
};
const str = (k: string, d = ''): string => env[k]?.trim() || d;
const list = (k: string): string[] => str(k).split(',').map((s) => s.trim()).filter(Boolean);

export { PUMP_DECIMALS, PUMP_MINT } from './constants.ts';

export const rules = {
  /** Share of every fee intake that funds rewards. The remainder goes to the burn pot. */
  rewardBps: num('REWARD_BPS', 8000),
  /** Largest slice of the reward pot one callout can take (score = 1). */
  maxPotShareBps: num('MAX_POT_SHARE_BPS', 250),
  /** Score every qualifying callout starts from. 0.2 x 2.5% = 0.5% of the pot ($5 per $1,000). */
  baseScore: num('BASE_SCORE', 0.2),
  /** Score a full bag adds. pump.fun followers add the rest (1 - base - bag), so each pays on its own. */
  bagWeight: num('BAG_WEIGHT', 0.5),
  /** Each rewarded callout in a row where the wallet kept its bag grows the bag part by this much, compounding. */
  holdStreakRate: num('HOLD_STREAK_RATE', 0.1),
  /** The streak can multiply the bag part by at most this. */
  holdStreakCap: num('HOLD_STREAK_CAP', 3),
  /** Supply share at which the holding factor is maxed. 200 bps = 2%; more still counts as full. */
  holdFullBps: num('HOLD_FULL_BPS', 200),
  /** Below 1 flattens the holding curve. */
  holdExponent: num('HOLD_EXPONENT', 0.75),
  /** Minimum holding in basis points of supply. 10 bps = 0.1% = 1M tokens of 1B. */
  minHoldBps: num('MIN_HOLD_BPS', 10),
  /** pump.fun followers at which the follower factor is maxed. It starts from 0 at minFollowers. */
  followersFull: num('FOLLOWERS_FULL', 10_000),
  minFollowers: num('MIN_FOLLOWERS', 10),
  /** 0 = new accounts can earn. Uses pump.fun's account date from the holder feed; gmgn-only callouts have none. */
  minAccountAgeDays: num('MIN_ACCOUNT_AGE_DAYS', 0),
  /** A bag must sit still this long after the callout before it is paid. */
  holdMinutes: num('HOLD_MINUTES', 10),
  /** Minutes between rewarded callouts from one wallet or pump.fun account. */
  cooldownMinutes: num('COOLDOWN_MINUTES', 10),
  /** Smallest transfer worth sending, in whole $PUMP. Below it the callout stays queued. */
  minPayout: num('MIN_PAYOUT_PUMP', 100),
  /** The reward pot must hold at least this much before anyone is paid, in whole $PUMP. */
  potFloor: num('POT_FLOOR_PUMP', 5_000),
  /** Queued callouts gain weight per hour waited, up to the cap. */
  agingPerHour: num('QUEUE_AGING_PER_HOUR', 0.05),
  agingCap: num('QUEUE_AGING_CAP', 2),
  queueExpiryDays: num('QUEUE_EXPIRY_DAYS', 7),
};
export type Rules = typeof rules;

export const config = {
  coinMint: str('COIN_MINT'),
  coinSymbol: str('COIN_SYMBOL', 'CALLOUT'),
  siteName: str('SITE_NAME', 'Callout'),
  xUrl: str('X_URL', 'https://x.com/calloutonpmp'),
  port: num('PORT', 8787),
  host: str('HOST', '127.0.0.1'),
  dbPath: str('DB_PATH', 'data/callout.db'),

  /** How often callouts are read: pump.fun's holder feed, plus gmgn as a backup. No keys needed. */
  pollMs: Math.max(3000, num('POLL_MS', num('GMGN_POLL_MS', 10_000))),
  gmgnBase: str('GMGN_BASE', 'https://gmgn.ai'),
  /** pump.fun's site API: the callout (dev, account, squad) and the author (followers, pump user, banned). */
  pumpFrontendBase: str('PUMP_FRONTEND_BASE', 'https://frontend-api-v3.pump.fun'),
  /** Callouts made before this instant never count. ISO date; defaults to first boot. */
  rewardsStart: str('REWARDS_START'),

  rpcUrl: str('RPC_URL', 'https://api.mainnet-beta.solana.com'),
  treasurySecret: str('TREASURY_SECRET_KEY'),
  /** Optional, dry-run only: watch a wallet's pot without holding its key. */
  treasuryPubkey: str('TREASURY_PUBKEY'),
  /** Real transfers happen only with LIVE_PAYOUTS=true and a treasury key. */
  live: str('LIVE_PAYOUTS') === 'true',
  /** buyback: swap the burn pot into the coin and burn it. direct: burn $PUMP itself. */
  burnMode: (str('BURN_MODE') === 'direct' ? 'direct' : 'buyback') as 'buyback' | 'direct',
  minBurn: num('MIN_BURN_PUMP', 250),
  burnSlippageBps: num('BURN_SLIPPAGE_BPS', 300),
  jupiterBase: str('JUPITER_BASE', 'https://api.jup.ag/swap/v1'),
  jupiterKey: str('JUPITER_API_KEY'),
  claimEveryMs: num('CLAIM_EVERY_MS', 60_000),
  priorityMicroLamports: num('PRIORITY_MICROLAMPORTS', 50_000),
  minSolReserve: num('MIN_SOL_RESERVE', 0.02),
  excludeWallets: new Set(list('EXCLUDE_WALLETS')),
};

/**
 * demo: invented data, for local work or DEMO=true. Never the default in production.
 * prelaunch: deployed before the coin exists. The real site, empty.
 */
export type Mode = 'demo' | 'prelaunch' | 'dry-run' | 'live';
const ready = !!config.coinMint;
export const mode: Mode = str('DEMO') === 'true' ? 'demo'
  : ready ? (config.live && config.treasurySecret ? 'live' : 'dry-run')
  : env.NODE_ENV === 'production' ? 'prelaunch' : 'demo';
