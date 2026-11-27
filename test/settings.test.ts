import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { checkSettings } from '../server/settings.ts';

const MINT = '4VDjNNkemze5ZX5MWTzphtw6AtQdrJL2XqqPkt19pump';
const key = Keypair.generate();
const SECRET = bs58.encode(key.secretKey);
const PUB = key.publicKey.toBase58();
const has = (list: string[], bit: string) => list.some((m) => m.includes(bit));

test('a correct setup passes', () => {
  const f = checkSettings({ PLATFORM_MINT: MINT, RPC_URL: 'https://mainnet.helius-rpc.com/?api-key=abc', LAUNCHPAD_SECRET_KEY: SECRET, LIVE_PAYOUTS: 'false', MIN_HOLD_BPS: '10' });
  assert.deepEqual(f, { errors: [], warnings: [] });
  assert.deepEqual(checkSettings({ LAUNCHPAD_SECRET_KEY: JSON.stringify([...key.secretKey]), PLATFORM_MINT: MINT, LIVE_PAYOUTS: 'true' }), { errors: [], warnings: [] });
  assert.deepEqual(checkSettings({}), { errors: [], warnings: [] }, 'nothing set: demo, or a closed launchpad');
});

test('an RPC URL without https:// is named, without printing its API key', () => {
  const f = checkSettings({ RPC_URL: 'mainnet.helius-rpc.com/?api-key=SECRETSECRET' });
  assert.ok(has(f.errors, 'RPC_URL must be a full URL'));
  assert.ok(!f.errors.join(' ').includes('SECRETSECRET'));
});

test('a mint with quotes, a typo or a wrong length is named', () => {
  assert.ok(has(checkSettings({ PLATFORM_MINT: `"${MINT}"` }).errors, 'quotes'));
  assert.ok(has(checkSettings({ PLATFORM_MINT: MINT.slice(0, -3) + '0OI' }).errors, 'not a Solana address'));
  assert.ok(has(checkSettings({ PLATFORM_MINT: SECRET }).errors, 'PRIVATE key'));
});

test('keys in the wrong place are caught, and no part of a private key is printed', () => {
  const f = checkSettings({ LAUNCHPAD_SECRET_KEY: PUB });
  assert.ok(has(f.errors, 'looks like a public address'));
  const g = checkSettings({ LAUNCHPAD_SECRET_KEY: SECRET.slice(0, -4) });
  assert.ok(has(g.errors, 'not a valid key'));
  assert.ok(!g.errors.join(' ').includes(SECRET.slice(0, 10)));
  assert.ok(has(checkSettings({ LAUNCHPAD_SECRET_KEY: SECRET, PLATFORM_MINT: PUB }).errors, 'PLATFORM_MINT is the launchpad wallet'));
});

test('numbers and names that cannot be read are named', () => {
  assert.ok(has(checkSettings({ MIN_PAYOUT_USDC: 'ten' }).errors, 'MIN_PAYOUT_USDC must be a plain number'));
  assert.ok(has(checkSettings({ LAUNCH_FEE_SOL: '-1' }).errors, 'cannot be negative'));
  assert.ok(has(checkSettings({ 'export PLATFORM_MINT': MINT }).errors, 'extra spaces or "export"'));
  assert.ok(has(checkSettings({ CALLER_PCT: '70' }).errors, 'add up to 100: they add up to 110'));
});

test('values that would quietly do the wrong thing are warned about', () => {
  assert.ok(has(checkSettings({ LIVE_PAYOUTS: 'yes' }).warnings, 'Anything but exactly "true"'));
  assert.ok(has(checkSettings({ LIVE_PAYOUTS: 'true' }).warnings, 'does nothing without LAUNCHPAD_SECRET_KEY'));
  assert.ok(has(checkSettings({ LAUNCHPAD_SECRET_KEY: SECRET }).warnings, 'PLATFORM_MINT is not set'));
  assert.ok(has(checkSettings({ COIN_MINT: MINT, TREASURY_SECRET_KEY: SECRET }).warnings, 'from the old Callout setup'));
});
