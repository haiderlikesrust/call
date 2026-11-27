// Every tunable lives here. Values come from .env; nothing secret is ever sent to the browser.
// Values are checked by settings.ts before the server starts, so a bad one stops it with a clear message.
//
// The whole site is a launchpad. Every coin launched here is paired with SOL on pump.fun and pays its creator fees
// to one launchpad wallet. Each fee claim is split three ways: the coin's own callers (swapped to USDC), a buyback
// and burn of the coin, and the platform coin's callers. Callers are paid in USDC.
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

export { LAMPORTS, SOL_MINT, USDC_DECIMALS, USDC_MINT } from './constants.ts';

/** How every coin's creator fees split, in percent. Checked to add up to 100. */
export const split = {
  reward: num('CALLER_PCT', 60),
  burn: num('BURN_PCT', 10),
  platform: num('PLATFORM_PCT', 30),
};
export type Split = typeof split;

/** The engine's share of a coin's USDC that goes to callers; the rest buys the coin back to burn. */
export const rewardBpsOf = (s: Pick<Split, 'reward' | 'burn'>): number => {
  const kept = s.reward + s.burn;
  return kept > 0 ? Math.round((s.reward / kept) * 10_000) : 10_000;
};

export const rules = {
  /** Share of every USDC intake that funds rewards. The remainder buys the coin back and burns it. */
  rewardBps: rewardBpsOf(split),
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
  /** 0 = new accounts can earn. Uses pump.fun's account date from the holder feed. */
  minAccountAgeDays: num('MIN_ACCOUNT_AGE_DAYS', 0),
  /** A bag must sit still this long after the callout before it is paid. */
  holdMinutes: num('HOLD_MINUTES', 2),
  /** Minutes between rewarded callouts from one wallet or pump.fun account. */
  cooldownMinutes: num('COOLDOWN_MINUTES', 10),
  /** Smallest transfer worth sending, in whole USDC. Below it the callout stays queued. */
  minPayout: num('MIN_PAYOUT_USDC', 0.5),
  /** A coin's reward pot must hold at least this much before anyone is paid, in whole USDC. */
  potFloor: num('POT_FLOOR_USDC', 25),
  /** Queued callouts gain weight per hour waited, up to the cap. */
  agingPerHour: num('QUEUE_AGING_PER_HOUR', 0.05),
  agingCap: num('QUEUE_AGING_CAP', 2),
  queueExpiryDays: num('QUEUE_EXPIRY_DAYS', 7),
};
export type Rules = typeof rules;

const dataDir = str('DATA_DIR', 'data').replace(/[\\/]+$/, '') || '.';

export const config = {
  siteName: str('SITE_NAME', 'Holler'),
  /** The site's own X account; empty hides the link. */
  xUrl: str('X_URL'),
  port: num('PORT', 8787),
  host: str('HOST', '127.0.0.1'),
  /** The coin registry, every coin's payout ledger, hosted metadata and the leader lock live here. */
  dataDir,

  gmgnBase: str('GMGN_BASE', 'https://gmgn.ai'),
  /** pump.fun's site API: the holder feed, the callout and the author (followers, pump user, banned). */
  pumpFrontendBase: str('PUMP_FRONTEND_BASE', 'https://frontend-api-v3.pump.fun'),

  rpcUrl: str('RPC_URL', 'https://api.mainnet-beta.solana.com'),
  /** Real transfers happen only with LIVE_PAYOUTS=true and a launchpad key. */
  live: str('LIVE_PAYOUTS') === 'true',
  /** A coin's burn pot is spent once it holds this much USDC. */
  minBurn: num('MIN_BURN_USDC', 5),
  burnSlippageBps: num('BURN_SLIPPAGE_BPS', 300),
  /** SOL to USDC is the deepest pair on Solana; 1% is generous. */
  swapSlippageBps: num('SWAP_SLIPPAGE_BPS', 100),
  jupiterBase: str('JUPITER_BASE', 'https://api.jup.ag/swap/v1'),
  jupiterKey: str('JUPITER_API_KEY'),
  claimEveryMs: num('CLAIM_EVERY_MS', 60_000),
  priorityMicroLamports: num('PRIORITY_MICROLAMPORTS', 50_000),
  /** SOL the launchpad wallet keeps for itself (network fees, new token accounts), on top of what coins are owed. */
  minSolReserve: num('MIN_SOL_RESERVE', 0.05),
  excludeWallets: new Set(list('EXCLUDE_WALLETS')),
};

export const launchpad = {
  /** The launchpad wallet. It co-signs each launch and receives, swaps, pays and burns every coin's fees. */
  secret: str('LAUNCHPAD_SECRET_KEY'),
  /** Paid by the launcher into the launchpad wallet, to cover network fees for that coin's payouts. */
  feeSol: num('LAUNCH_FEE_SOL', 0.05),
  /** The platform coin: launched here like any other, and paid the platform share of every coin's fees. */
  platformMint: str('PLATFORM_MINT'),
  /** Fee claims smaller than this wait, so network fees never eat them. In SOL. */
  minClaimSol: num('MIN_CLAIM_SOL', 0.02),
  /** A coin's SOL is swapped to USDC once it has at least this much. */
  minSwapSol: num('MIN_SWAP_SOL', 0.05),
  /** Largest first buy a launcher can make, in SOL. */
  maxDevBuySol: num('MAX_DEV_BUY_SOL', 50),
  dir: `${dataDir}/launchpad`,
  /** Public address of this site, for metadata hosted here when pump.fun's upload is unavailable. */
  siteUrl: str('SITE_URL', 'https://holler.lol').replace(/\/+$/, ''),
  ipfsUrl: str('PUMP_IPFS_URL', 'https://pump.fun/api/ipfs'),
};

/**
 * demo: invented coins and callouts, for local work or DEMO=true. Never the default in production.
 * dry-run: real coins and callouts, nothing sent. live: LIVE_PAYOUTS=true plus the launchpad key.
 */
export type Mode = 'demo' | 'dry-run' | 'live';
export const mode: Mode = str('DEMO') === 'true' || (!launchpad.secret && env.NODE_ENV !== 'production' && str('DEMO') !== 'false')
  ? 'demo'
  : launchpad.secret && config.live ? 'live' : 'dry-run';
