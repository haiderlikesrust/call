// Checks the environment before anything uses it, so a bad value stops the server with a message that names
// it, instead of a stack trace from deep inside Solana's libraries. Secret values are never printed.
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

export interface Findings { errors: string[]; warnings: string[] }

const NUMBERS = [
  'PORT', 'POLL_MS', 'GMGN_POLL_MS', 'REWARD_BPS', 'MAX_POT_SHARE_BPS', 'BASE_SCORE', 'BAG_WEIGHT', 'HOLD_STREAK_RATE', 'HOLD_STREAK_CAP',
  'HOLD_FULL_BPS', 'HOLD_EXPONENT', 'MIN_HOLD_BPS', 'FOLLOWERS_FULL', 'MIN_FOLLOWERS', 'MIN_ACCOUNT_AGE_DAYS', 'HOLD_MINUTES',
  'COOLDOWN_MINUTES', 'MIN_PAYOUT_PUMP', 'POT_FLOOR_PUMP', 'QUEUE_AGING_PER_HOUR', 'QUEUE_AGING_CAP', 'QUEUE_EXPIRY_DAYS',
  'MIN_BURN_PUMP', 'BURN_SLIPPAGE_BPS', 'CLAIM_EVERY_MS', 'PRIORITY_MICROLAMPORTS', 'MIN_SOL_RESERVE',
] as const;
const URLS = ['RPC_URL', 'PUMP_FRONTEND_BASE', 'GMGN_BASE', 'JUPITER_BASE'] as const;
const CHOICES: Record<string, readonly string[]> = { LIVE_PAYOUTS: ['true', 'false'], DEMO: ['true', 'false'], TRUST_PROXY: ['true', 'false'], BURN_MODE: ['buyback', 'direct'] };

/** Enough of a public value to recognise it, never the whole thing. */
const peek = (v: string) => (v.length <= 12 ? `"${v}"` : `"${v.slice(0, 6)}…${v.slice(-4)}" (${v.length} characters)`);
const quoted = (v: string) => /^(["'`]).*\1$/s.test(v);
const bytes = (v: string): number => { try { return bs58.decode(v).length; } catch { return -1; } };

function address(k: string, v: string, out: Findings): void {
  if (quoted(v)) return void out.errors.push(`${k} has quotes around it. Remove them: ${k}=${v.slice(1, -1).trim().slice(0, 6)}…`);
  if (bytes(v) === 32) return;
  if (bytes(v) === 64) return void out.errors.push(`${k} looks like a PRIVATE key. It needs the wallet's public address. Remove the key from ${k} now.`);
  out.errors.push(`${k} is not a Solana address: got ${peek(v)}. Paste it exactly, no spaces or extra characters (32 to 44 characters).`);
}

export function checkSettings(env: Record<string, string | undefined>): Findings {
  const out: Findings = { errors: [], warnings: [] };
  const get = (k: string) => env[k]?.trim() ?? '';

  // "COIN_MINT =x" or "export COIN_MINT=x" in a pasted .env arrive under a name nothing reads.
  const known = new Set<string>([...NUMBERS, ...URLS, ...Object.keys(CHOICES), 'COIN_MINT', 'COIN_SYMBOL', 'TREASURY_PUBKEY', 'TREASURY_SECRET_KEY', 'REWARDS_START', 'EXCLUDE_WALLETS', 'JUPITER_API_KEY']);
  for (const k of Object.keys(env)) {
    const bare = k.replace(/^export\s+/, '').trim();
    if (bare !== k && known.has(bare)) out.errors.push(`"${k}" is not read: the name has extra spaces or "export". Write it as ${bare}=… with nothing around the name.`);
  }

  for (const k of NUMBERS) {
    const v = get(k);
    if (v && !Number.isFinite(Number(v))) out.errors.push(`${k} must be a plain number: got ${peek(v)}.`);
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

  const mint = get('COIN_MINT');
  if (mint) address('COIN_MINT', mint, out);
  const pub = get('TREASURY_PUBKEY');
  if (pub) address('TREASURY_PUBKEY', pub, out);
  const secret = get('TREASURY_SECRET_KEY');
  if (secret) {
    // Never echo any part of the key.
    let key: Keypair | null = null;
    if (quoted(secret)) out.errors.push('TREASURY_SECRET_KEY has quotes around it. Remove them.');
    else if (secret.startsWith('[')) {
      try {
        const arr = JSON.parse(secret);
        if (Array.isArray(arr) && arr.length === 64 && arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) key = Keypair.fromSecretKey(Uint8Array.from(arr));
      } catch { /* reported below */ }
      if (!key) out.errors.push('TREASURY_SECRET_KEY is not a valid key: a JSON key must be an array of exactly 64 numbers from 0 to 255.');
    } else if (bytes(secret) === 32) out.errors.push('TREASURY_SECRET_KEY looks like a public address, not a private key. For a rehearsal, leave it empty and set TREASURY_PUBKEY instead.');
    else if (bytes(secret) !== 64) out.errors.push('TREASURY_SECRET_KEY is not a valid key: use the wallet\'s base58 private key or its 64-number JSON array.');
    else {
      try { key = Keypair.fromSecretKey(bs58.decode(secret)); } catch { out.errors.push('TREASURY_SECRET_KEY is not a valid key: the 64 bytes do not form a Solana keypair.'); }
    }
    if (key && pub && bytes(pub) === 32 && key.publicKey.toBase58() !== pub) {
      out.warnings.push('TREASURY_SECRET_KEY and TREASURY_PUBKEY are different wallets. The secret key is used; remove TREASURY_PUBKEY.');
    }
  }
  if (get('LIVE_PAYOUTS') === 'true' && !secret) out.warnings.push('LIVE_PAYOUTS=true does nothing without TREASURY_SECRET_KEY: this runs as a rehearsal.');
  const start = get('REWARDS_START');
  if (start && !Number.isFinite(Date.parse(start))) out.errors.push(`REWARDS_START must be a date like 2026-12-01T00:00:00Z: got ${peek(start)}.`);
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
