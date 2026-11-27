// Checks the environment before anything uses it, so a bad value stops the server with a message that names
// it, instead of a stack trace from deep inside Solana's libraries. Secret values are never printed.
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

export interface Findings { errors: string[]; warnings: string[] }

const NUMBERS = [
  'PORT', 'MAX_POT_SHARE_BPS', 'BASE_SCORE', 'BAG_WEIGHT', 'HOLD_STREAK_RATE', 'HOLD_STREAK_CAP', 'HOLD_FULL_BPS', 'HOLD_EXPONENT',
  'MIN_HOLD_BPS', 'FOLLOWERS_FULL', 'MIN_FOLLOWERS', 'MIN_ACCOUNT_AGE_DAYS', 'HOLD_MINUTES', 'COOLDOWN_MINUTES', 'MIN_PAYOUT_USDC',
  'POT_FLOOR_USDC', 'QUEUE_AGING_PER_HOUR', 'QUEUE_AGING_CAP', 'QUEUE_EXPIRY_DAYS', 'MIN_BURN_USDC', 'BURN_SLIPPAGE_BPS',
  'SWAP_SLIPPAGE_BPS', 'CLAIM_EVERY_MS', 'PRIORITY_MICROLAMPORTS', 'MIN_SOL_RESERVE',
  'LAUNCH_FEE_SOL', 'CALLER_PCT', 'BURN_PCT', 'PLATFORM_PCT', 'MIN_CLAIM_SOL', 'MIN_SWAP_SOL', 'MAX_DEV_BUY_SOL',
] as const;
const URLS = ['RPC_URL', 'PUMP_FRONTEND_BASE', 'GMGN_BASE', 'JUPITER_BASE', 'SITE_URL', 'PUMP_IPFS_URL', 'X_URL'] as const;
const CHOICES: Record<string, readonly string[]> = { LIVE_PAYOUTS: ['true', 'false'], DEMO: ['true', 'false'], TRUST_PROXY: ['true', 'false'] };
const OTHER = ['LAUNCHPAD_SECRET_KEY', 'PLATFORM_MINT', 'EXCLUDE_WALLETS', 'HIDE_COINS', 'JUPITER_API_KEY', 'SITE_NAME', 'DATA_DIR', 'HOST'] as const;
/** Settings from the Callout setup this site replaced. Nothing reads them any more. */
const RETIRED: Record<string, string> = {
  COIN_MINT: 'PLATFORM_MINT (the platform coin, launched through the launchpad)',
  TREASURY_SECRET_KEY: 'LAUNCHPAD_SECRET_KEY', TREASURY_PUBKEY: 'LAUNCHPAD_SECRET_KEY',
  ENABLE_LAUNCHPAD: 'nothing: the launchpad is the whole site', LAUNCHPAD_FEE_SOL: 'LAUNCH_FEE_SOL',
  LAUNCHPAD_REWARD_PCT: 'CALLER_PCT', LAUNCHPAD_BURN_PCT: 'BURN_PCT', LAUNCHPAD_TREASURY_PCT: 'PLATFORM_PCT',
  LAUNCHPAD_TREASURY_WALLET: 'nothing: the platform share is paid to PLATFORM_MINT\'s callers',
  MIN_PAYOUT_PUMP: 'MIN_PAYOUT_USDC', POT_FLOOR_PUMP: 'POT_FLOOR_USDC', MIN_BURN_PUMP: 'MIN_BURN_USDC', BURN_MODE: 'nothing: burns are always a buyback',
  REWARD_BPS: 'CALLER_PCT and BURN_PCT', DB_PATH: 'DATA_DIR',
};

/** Enough of a public value to recognise it, never the whole thing. */
const peek = (v: string) => (v.length <= 12 ? `"${v}"` : `"${v.slice(0, 6)}…${v.slice(-4)}" (${v.length} characters)`);
const quoted = (v: string) => /^(["'`]).*\1$/s.test(v);
const bytes = (v: string): number => { try { return bs58.decode(v).length; } catch { return -1; } };

function address(k: string, v: string, out: Findings): void {
  if (quoted(v)) return void out.errors.push(`${k} has quotes around it. Remove them: ${k}=${v.slice(1, -1).trim().slice(0, 6)}…`);
  if (bytes(v) === 32) return;
  if (bytes(v) === 64) return void out.errors.push(`${k} looks like a PRIVATE key. It needs a public address. Remove the key from ${k} now.`);
  out.errors.push(`${k} is not a Solana address: got ${peek(v)}. Paste it exactly, no spaces or extra characters (32 to 44 characters).`);
}

/** Parses a private key without ever echoing it. Null (with an error recorded) when it is not one. */
function secretKey(k: string, secret: string, out: Findings): Keypair | null {
  let key: Keypair | null = null;
  if (quoted(secret)) out.errors.push(`${k} has quotes around it. Remove them.`);
  else if (secret.startsWith('[')) {
    try {
      const arr = JSON.parse(secret);
      if (Array.isArray(arr) && arr.length === 64 && arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) key = Keypair.fromSecretKey(Uint8Array.from(arr));
    } catch { /* reported below */ }
    if (!key) out.errors.push(`${k} is not a valid key: a JSON key must be an array of exactly 64 numbers from 0 to 255.`);
  } else if (bytes(secret) === 32) out.errors.push(`${k} looks like a public address, not a private key.`);
  else if (bytes(secret) !== 64) out.errors.push(`${k} is not a valid key: use the wallet's base58 private key or its 64-number JSON array.`);
  else {
    try { key = Keypair.fromSecretKey(bs58.decode(secret)); } catch { out.errors.push(`${k} is not a valid key: the 64 bytes do not form a Solana keypair.`); }
  }
  return key;
}

export function checkSettings(env: Record<string, string | undefined>): Findings {
  const out: Findings = { errors: [], warnings: [] };
  const get = (k: string) => env[k]?.trim() ?? '';

  // "PLATFORM_MINT =x" or "export PLATFORM_MINT=x" in a pasted .env arrive under a name nothing reads.
  const known = new Set<string>([...NUMBERS, ...URLS, ...OTHER, ...Object.keys(CHOICES)]);
  for (const k of Object.keys(env)) {
    const bare = k.replace(/^export\s+/, '').trim();
    if (bare !== k && known.has(bare)) out.errors.push(`"${k}" is not read: the name has extra spaces or "export". Write it as ${bare}=… with nothing around the name.`);
  }
  for (const [k, now] of Object.entries(RETIRED)) if (get(k)) out.warnings.push(`${k} is from the old Callout setup and is no longer read. Use ${now}.`);

  for (const k of NUMBERS) {
    const v = get(k);
    if (v && !Number.isFinite(Number(v))) out.errors.push(`${k} must be a plain number: got ${peek(v)}.`);
    else if (v && Number(v) < 0) out.errors.push(`${k} cannot be negative: got ${v}.`);
  }
  for (const k of URLS) {
    const v = get(k);
    if (!v) continue;
    if (quoted(v)) { out.errors.push(`${k} has quotes around it. Remove them.`); continue; }
    let ok = false;
    try { ok = ['http:', 'https:'].includes(new URL(v).protocol); } catch { /* not a URL */ }
    // RPC URLs often carry an API key, so only the start is shown.
    if (!ok) out.errors.push(`${k} must be a full URL starting with https:// (got "${v.slice(0, 12)}…").`);
  }
  for (const [k, allowed] of Object.entries(CHOICES)) {
    const v = get(k);
    if (v && !allowed.includes(v)) {
      const what = k === 'LIVE_PAYOUTS' ? ' Anything but exactly "true" keeps payouts off.' : '';
      out.warnings.push(`${k} should be ${allowed.join(' or ')}: got ${peek(v)}.${what}`);
    }
  }

  const pct = (k: string, d: number) => (get(k) ? Number(get(k)) : d);
  const sum = pct('CALLER_PCT', 60) + pct('BURN_PCT', 10) + pct('PLATFORM_PCT', 30);
  if (Number.isFinite(sum) && Math.abs(sum - 100) > 1e-9) out.errors.push(`CALLER_PCT + BURN_PCT + PLATFORM_PCT must add up to 100: they add up to ${sum}.`);

  const platform = get('PLATFORM_MINT');
  if (platform) address('PLATFORM_MINT', platform, out);
  else if (pct('PLATFORM_PCT', 30) > 0 && get('LAUNCHPAD_SECRET_KEY')) out.warnings.push('PLATFORM_MINT is not set: the platform share of every claim is held in the launchpad wallet and goes to the platform coin\'s callers once it is set.');

  const secret = get('LAUNCHPAD_SECRET_KEY');
  const key = secret ? secretKey('LAUNCHPAD_SECRET_KEY', secret, out) : null;
  if (key && platform && key.publicKey.toBase58() === platform) out.errors.push('PLATFORM_MINT is the launchpad wallet. It should be the platform coin\'s mint address.');
  if (get('LIVE_PAYOUTS') === 'true' && !secret) out.warnings.push('LIVE_PAYOUTS=true does nothing without LAUNCHPAD_SECRET_KEY: this runs as a rehearsal with launches closed.');
  for (const w of get('EXCLUDE_WALLETS').split(',').map((s) => s.trim()).filter(Boolean)) address('EXCLUDE_WALLETS', w, out);
  for (const m of get('HIDE_COINS').split(',').map((s) => s.trim()).filter(Boolean)) address('HIDE_COINS', m, out);
  return out;
}

/** Prints what is wrong; true when the server cannot start. */
export function report(f: Findings, where: string): boolean {
  for (const w of f.warnings) console.warn(`[settings] warning: ${w}`);
  if (!f.errors.length) return false;
  console.error(`\n[settings] ${where} cannot start. Fix ${f.errors.length === 1 ? 'this setting' : `these ${f.errors.length} settings`} in the environment and deploy again:`);
  for (const e of f.errors) console.error(`  - ${e}`);
  console.error('');
  return true;
}
