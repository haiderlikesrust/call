// npm run doctor: read-only preflight. Sends no transactions and prints no secrets.
import { Connection, PublicKey } from '@solana/web3.js';
import { OnlinePumpSdk, feeSharingConfigPda, isSolLikeQuoteMint } from '@pump-fun/pump-sdk';
import { LAMPORTS, SOL_MINT, USDC_MINT, config, launchpad, mode, split } from './config.ts';
import { keypair } from './chain.ts';
import { Registry } from './launchpad/registry.ts';
import { checkSettings, report } from './settings.ts';

if (report(checkSettings(process.env), 'npm run doctor')) process.exit(1);

let bad = 0;
const check = async (name: string, fn: () => Promise<string>) => {
  try { console.log(`  ok    ${name}: ${await fn()}`); } catch (e) { bad++; console.log(`  FIX   ${name}: ${e instanceof Error ? e.message : e}`); }
};
const fail = (m: string): never => { throw new Error(m); };

console.log(`mode: ${mode}`);
const conn = new Connection(config.rpcUrl, 'confirmed');
await check('RPC', async () => `slot ${await conn.getSlot()}${config.rpcUrl.includes('api.mainnet-beta') ? ' (public RPC: fine for testing, use a paid one live)' : ''}`);

const key = launchpad.secret ? keypair(launchpad.secret) : null;
await check('launchpad wallet', async () => {
  if (!key) fail('set LAUNCHPAD_SECRET_KEY: a NEW wallet that only this site uses. Until then launches stay closed');
  const sol = (await conn.getBalance(key!.publicKey)) / LAMPORTS;
  const held = Number(new Registry(launchpad.dir).solHeldForCoins()) / LAMPORTS;
  const free = sol - held;
  if (free < config.minSolReserve) fail(`${key!.publicKey.toBase58()} has ${free.toFixed(4)} SOL of its own (${sol} in all, ${held} owed to coins). It needs ${config.minSolReserve}+ for network fees and new USDC accounts`);
  return `${key!.publicKey.toBase58()}, ${sol} SOL (${held} owed to coins)`;
});

await check('SOL to USDC route', async () => {
  const q = new URLSearchParams({ inputMint: SOL_MINT, outputMint: USDC_MINT, amount: String(Math.round(launchpad.minSwapSol * LAMPORTS)), slippageBps: String(config.swapSlippageBps) });
  const r = await fetch(`${config.jupiterBase}/quote?${q}`, { headers: config.jupiterKey ? { 'x-api-key': config.jupiterKey } : {} });
  if (!r.ok) fail(`Jupiter answered ${r.status}${config.jupiterKey ? '' : ': set JUPITER_API_KEY'}. Fees cannot be turned into USDC without it`);
  const body = await r.json() as { outAmount: string };
  return `${launchpad.minSwapSol} SOL is ${(Number(body.outAmount) / 1e6).toFixed(2)} USDC now`;
});

await check('platform coin', async () => {
  if (!launchpad.platformMint) fail(`set PLATFORM_MINT once the platform coin is launched through the site. Until then its ${split.platform}% share waits in the wallet`);
  const mint = new PublicKey(launchpad.platformMint);
  const curve = await new OnlinePumpSdk(conn as never).fetchBondingCurve(mint);
  if (!isSolLikeQuoteMint(curve.quoteMint)) fail(`it is paired with ${curve.quoteMint.toBase58()}, not SOL`);
  if (!curve.creator.equals(feeSharingConfigPda(mint))) fail('its fees do not go to a launchpad fee-sharing vault. Launch it through the site so its fees reach the launchpad wallet');
  const listed = new Registry(launchpad.dir).coin(launchpad.platformMint);
  if (!listed || listed.status !== 'live') fail('it is not in this site\'s registry. Launch it through the site, not on pump.fun directly');
  return `${listed!.name} ($${listed!.symbol}), paired with SOL`;
});

await check('coins', async () => {
  const reg = new Registry(launchpad.dir);
  const live = reg.coins('live');
  return `${live.length} launched here, ${reg.coins('pending').length} waiting to land, ${(Number(reg.feesSol()) / LAMPORTS).toFixed(4)} SOL claimed in fees`;
});
console.log(`  split ${split.reward}% callers (in USDC) / ${split.burn}% buyback and burn / ${split.platform}% platform coin callers`);
process.exit(bad ? 1 : 0);
