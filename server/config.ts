// Every tunable lives here. Values come from .env; nothing secret is ever sent to the browser.
const env = process.env;

const num = (k: string, d: number): number => {
  const raw = env[k];
  if (raw === undefined || raw === '') return d;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${k} must be a number, got "${raw}"`);
  return n;
};
const str = (k: string, d = ''): string => env[k]?.trim() || d;
const list = (k: string): string[] => str(k).split(',').map((s) => s.trim()).filter(Boolean);

export { PUMP_DECIMALS, PUMP_MINT } from './constants.ts';

export const rules = {
  /** Share of every fee intake that funds rewards. The remainder goes to the burn pot. */
  rewardBps: num('REWARD_BPS', 8000),
  /** Largest slice of the reward pot one callout can take (score = 1). */
  maxPotShareBps: num('MAX_POT_SHARE_BPS', 250),
  /** Supply share at which the holding factor is maxed. 100 bps = 1%. */
  holdFullBps: num('HOLD_FULL_BPS', 100),
  /** Below 1 flattens the holding curve. Keep >= 0.7 or bag splitting starts to pay. */
  holdExponent: num('HOLD_EXPONENT', 0.75),
  /** Minimum holding in basis points of supply. 1 bp of 1B = 100k tokens. */
  minHoldBps: num('MIN_HOLD_BPS', 1),
  /** Followers at which the follower factor is maxed. */
  followersFull: num('FOLLOWERS_FULL', 100_000),
  /** Follower factor of an account at zero followers. */
  followFloor: num('FOLLOW_FLOOR', 0.1),
  minFollowers: num('MIN_FOLLOWERS', 10),
  /** 0 = new accounts can earn. */
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

  pumpApiKey: str('PUMP_API_KEY'),
  pumpApiBase: str('PUMP_API_BASE', 'https://api.pump.fun/v1'),
  /** 2500 ms fits the default 50k/day key. Use 1000 only on the 1M/day tier. */
  pollMs: num('POLL_MS', 2500),
  dailyBudget: num('PUMP_DAILY_BUDGET', 50_000),
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
 * prelaunch: deployed before the API key and coin exist. The real site, empty.
 */
export type Mode = 'demo' | 'prelaunch' | 'dry-run' | 'live';
const ready = !!config.pumpApiKey && !!config.coinMint;
export const mode: Mode = str('DEMO') === 'true' ? 'demo'
  : ready ? (config.live && config.treasurySecret ? 'live' : 'dry-run')
  : env.NODE_ENV === 'production' ? 'prelaunch' : 'demo';
