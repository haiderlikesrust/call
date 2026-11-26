// npm run doctor: read-only preflight. Sends no transactions and prints no secrets.
import { PublicKey } from '@solana/web3.js';
import { OnlinePumpSdk } from '@pump-fun/pump-sdk';
import { PUMP_MINT, config, mode, rules } from './config.ts';
import { SolanaChain } from './chain.ts';
import { LiveSource } from './pumpApi.ts';
import { checkSettings, report } from './settings.ts';

if (report(checkSettings(process.env), 'npm run doctor')) process.exit(1);

let bad = 0;
const check = async (name: string, fn: () => Promise<string>) => {
  try { console.log(`  ok    ${name}: ${await fn()}`); } catch (e) { bad++; console.log(`  FIX   ${name}: ${e instanceof Error ? e.message : e}`); }
};
const fail = (m: string): never => { throw new Error(m); };

console.log(`mode: ${mode}`);
await check('COIN_MINT', async () => (config.coinMint ? new PublicKey(config.coinMint).toBase58() : fail('not set')));
if (config.coinMint) {
  const chain = new SolanaChain();
  await check('RPC', async () => `slot ${await chain.conn.getSlot()}${config.rpcUrl.includes('api.mainnet-beta') ? ' (public RPC: fine for testing, use a paid one live)' : ''}`);
  await check('coin supply', async () => `${Number(await chain.supply()) / 1e6}`);
  await check('coin is paired with $PUMP', async () => {
    const curve = await new OnlinePumpSdk(chain.conn as never).fetchBondingCurve(chain.coin);
    if (curve.quoteMint.toBase58() !== PUMP_MINT) fail(`quote mint is ${curve.quoteMint.toBase58()}, so creator fees will not arrive in $PUMP`);
    if (chain.treasury && !curve.creator.equals(chain.treasury)) fail(`creator is ${curve.creator.toBase58()}, not the treasury wallet, so auto-claim cannot collect. Use the creator wallet, or share fees to the treasury`);
    return 'yes';
  });
  await check('treasury', async () => {
    if (!chain.treasury) fail('set TREASURY_SECRET_KEY (or TREASURY_PUBKEY to only watch)');
    const sol = (await chain.conn.getBalance(chain.treasury!)) / 1e9;
    if (sol < config.minSolReserve) fail(`${chain.treasury!.toBase58()} has ${sol} SOL, needs ${config.minSolReserve}+ for network fees and new token accounts`);
    return `${chain.treasury!.toBase58()}, ${sol} SOL, ${Number(await chain.treasuryBalance()) / 1e6} $PUMP`;
  });
  if (config.burnMode === 'buyback') await check('buyback route', async () => {
    const q = new URLSearchParams({ inputMint: PUMP_MINT, outputMint: config.coinMint, amount: String(config.minBurn * 1e6), slippageBps: String(config.burnSlippageBps) });
    const r = await fetch(`${config.jupiterBase}/quote?${q}`, { headers: config.jupiterKey ? { 'x-api-key': config.jupiterKey } : {} });
    return r.ok ? `impact ${((await r.json()).priceImpactPct * 100).toFixed(2)}%` : fail(`Jupiter has no route yet (${r.status}). Burns will wait, or set BURN_MODE=direct`);
  });
}
if (config.coinMint) await check('holders and callouts', async () => {
  const chain = new SolanaChain();
  const [{ balances: all }, supply] = await Promise.all([chain.holders(), chain.supply()]);
  const min = (supply * BigInt(Math.round(rules.minHoldBps * 100))) / 1_000_000n;
  const big = [...all].filter(([, b]) => b >= min).sort((a, b) => (b[1] > a[1] ? 1 : -1));
  const api = new LiveSource();
  const { items } = await api.positions(0);
  const list = (await api.callouts()) ?? [];
  const from = new Set(big.map(([w]) => w));
  const mine = list.filter((c) => from.has(c.wallet));
  let pump = 'nothing to look up yet';
  if (mine[0]) {
    try { const a = await api.account(mine[0]); pump = a ? `answers (${a.username}: ${a.followers} followers)` : 'says that callout is deleted'; }
    catch (e) { pump = `not answering right now (${e instanceof Error ? e.message : e}); callouts wait until it does`; }
  }
  const fed = items.filter((f) => from.has(f.listed.wallet)).length;
  return `${all.size} holders, ${big.length} at or above the minimum; pump.fun feed: ${items.length} holder callouts on page 1, ${fed} from qualifying holders; gmgn backup: ${api.backup ? 'off (' + api.backup + ')' : list.length + ' callouts in the last day'}; account lookups ${pump}`;
});
console.log(`  rules ${rules.rewardBps / 100}/${100 - rules.rewardBps / 100} split, max ${rules.maxPotShareBps / 100}% of pot per callout`);
process.exit(bad ? 1 : 0);
