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
  const f = checkSettings({ COIN_MINT: MINT, RPC_URL: 'https://mainnet.helius-rpc.com/?api-key=abc', TREASURY_PUBKEY: PUB, LIVE_PAYOUTS: 'false', MIN_HOLD_BPS: '10', REWARDS_START: '2026-12-01T00:00:00Z' });
  assert.deepEqual(f, { errors: [], warnings: [] });
  assert.deepEqual(checkSettings({ TREASURY_SECRET_KEY: SECRET, LIVE_PAYOUTS: 'true', COIN_MINT: MINT }), { errors: [], warnings: [] });
  assert.deepEqual(checkSettings({ TREASURY_SECRET_KEY: JSON.stringify([...key.secretKey]) }).errors, []);
  assert.deepEqual(checkSettings({}), { errors: [], warnings: [] }, 'nothing set: prelaunch or demo');
});

test('an RPC URL without https:// is named, without printing its API key', () => {
  const f = checkSettings({ RPC_URL: 'mainnet.helius-rpc.com/?api-key=SECRETKEY123' });
  assert.ok(has(f.errors, 'RPC_URL must be a full URL starting with https://'));
  assert.ok(!f.errors.join(' ').includes('SECRETKEY123'));
});

test('a mint with quotes, a typo or a wrong length is named', () => {
  assert.ok(has(checkSettings({ COIN_MINT: `"${MINT}"` }).errors, 'COIN_MINT has quotes around it'));
  assert.ok(has(checkSettings({ COIN_MINT: MINT.slice(0, 30) }).errors, 'COIN_MINT is not a Solana address'));
  assert.ok(has(checkSettings({ COIN_MINT: MINT.replace('V', '0') }).errors, 'COIN_MINT is not a Solana address'), 'base58 has no 0');
});

test('keys in the wrong place are caught, and no part of a private key is printed', () => {
  const f = checkSettings({ TREASURY_PUBKEY: SECRET });
  assert.ok(has(f.errors, 'TREASURY_PUBKEY looks like a PRIVATE key'));
  assert.ok(!f.errors.join(' ').includes(SECRET.slice(0, 6)));
  assert.ok(has(checkSettings({ TREASURY_SECRET_KEY: PUB }).errors, 'looks like a public address'));
  assert.ok(has(checkSettings({ TREASURY_SECRET_KEY: '[1,2,3]' }).errors, 'array of exactly 64 numbers'));
  assert.ok(has(checkSettings({ TREASURY_SECRET_KEY: 'not-a-key' }).errors, 'not a valid key'));
  const bad = checkSettings({ TREASURY_SECRET_KEY: SECRET.slice(0, -3) + 'abc' });
  assert.ok(!bad.errors.join(' ').includes(SECRET.slice(0, 6)));
});

test('numbers, dates and names that cannot be read are named', () => {
  assert.ok(has(checkSettings({ POLL_MS: '10s' }).errors, 'POLL_MS must be a plain number'));
  assert.ok(has(checkSettings({ REWARDS_START: 'tomorrow' }).errors, 'REWARDS_START must be a date'));
  assert.ok(has(checkSettings({ 'COIN_MINT ': MINT }).errors, 'the name has extra spaces'));
  assert.ok(has(checkSettings({ 'export COIN_MINT': MINT }).errors, 'Write it as COIN_MINT='));
});

test('values that would quietly do the wrong thing are warned about', () => {
  assert.ok(has(checkSettings({ LIVE_PAYOUTS: 'True' }).warnings, 'keeps payouts off'));
  assert.ok(has(checkSettings({ LIVE_PAYOUTS: 'true' }).warnings, 'does nothing without TREASURY_SECRET_KEY'));
  assert.ok(has(checkSettings({ TREASURY_SECRET_KEY: SECRET, TREASURY_PUBKEY: MINT }).warnings, 'different wallets'));
  assert.ok(has(checkSettings({ BURN_MODE: 'burn' }).warnings, 'BURN_MODE should be buyback or direct'));
});
