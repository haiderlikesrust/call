// Builds a launch: metadata, then one transaction that creates the coin on pump.fun paired to SOL, gives it its
// own fee-sharing vault paying the launchpad wallet, makes the launcher's optional first buy, and pays the launch fee.
// The launcher signs and pays for it in their own wallet; the server signs only for the new mint and the
// fee-sharing setup, and simulates the whole thing before handing it over.
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  AddressLookupTableAccount, AddressLookupTableProgram, ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram,
  TransactionMessage, VersionedTransaction, type TransactionInstruction,
} from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { OnlinePumpSdk, PUMP_SDK, bondingCurvePda, feeSharingConfigPda, getBuyV3TokenAmountFromQuoteAmount, isSolLikeQuoteMint, newBondingCurve } from '@pump-fun/pump-sdk';
import BN from 'bn.js';
import { Impit } from 'impit';
import { LAMPORTS, config, launchpad } from '../config.ts';
import type { Registry } from './registry.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface LaunchInput {
  name: string; symbol: string; description: string;
  website: string; twitter: string; telegram: string;
  /** data: URL of a PNG, JPEG, GIF or WebP image. */
  image: string;
  launcher: string;
  /** SOL for the launcher's first buy; 0 for none. */
  devBuy: number;
}
export class LaunchError extends Error {}

const IMAGE: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Checks the form. Everything is trimmed and bounded the way pump.fun bounds it. */
export function validate(raw: Record<string, unknown>): LaunchInput & { bytes: Buffer; type: string } {
  const s = (k: string, max: number) => {
    const v = typeof raw[k] === 'string' ? (raw[k] as string).trim() : '';
    const label = ({ symbol: 'The ticker', name: 'The name', description: 'The description' } as Record<string, string>)[k] ?? `The ${k} link`;
    if (v.length > max) throw new LaunchError(`${label} can be at most ${max} characters.`);
    return v;
  };
  const name = s('name', 32), symbol = s('symbol', 10).replace(/^\$/, ''), description = s('description', 500);
  if (!name) throw new LaunchError('Give the coin a name.');
  if (!/^[A-Za-z0-9]{1,10}$/.test(symbol)) throw new LaunchError('The ticker is 1 to 10 letters or numbers.');
  const link = (k: string) => {
    const v = s(k, 200);
    if (!v) return '';
    let u: URL;
    try { u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`); } catch { throw new LaunchError(`The ${k} link is not a web address.`); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new LaunchError(`The ${k} link must start with https://.`);
    return u.toString();
  };
  const website = link('website'), twitter = link('twitter'), telegram = link('telegram');
  const launcher = s('launcher', 44);
  if (!BASE58.test(launcher)) throw new LaunchError('Connect a wallet first.');
  try { if (!PublicKey.isOnCurve(new PublicKey(launcher).toBytes())) throw new Error(); } catch { throw new LaunchError('That wallet address cannot sign.'); }
  const devBuy = Number(raw.devBuy ?? 0);
  if (!Number.isFinite(devBuy) || devBuy < 0) throw new LaunchError('The first buy must be an amount of SOL, or empty.');
  if (devBuy > launchpad.maxDevBuySol) throw new LaunchError(`The first buy can be at most ${launchpad.maxDevBuySol} SOL.`);
  const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(typeof raw.image === 'string' ? raw.image : '');
  if (!m) throw new LaunchError('Add a PNG, JPEG, GIF or WebP image.');
  const bytes = Buffer.from(m[2]!, 'base64');
  if (bytes.length > 4 * 1024 * 1024) throw new LaunchError('The image can be at most 4 MB.');
  if (!sniff(bytes, m[1]!)) throw new LaunchError('That file is not the image it claims to be.');
  return { name, symbol, description, website, twitter, telegram, image: '', launcher, devBuy, bytes, type: m[1]! };
}
/** The file's first bytes must match its declared type. */
function sniff(b: Buffer, type: string): boolean {
  if (type === 'image/png') return b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (type === 'image/jpeg') return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (type === 'image/gif') return b.subarray(0, 4).toString('ascii') === 'GIF8';
  return b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP';
}

/**
 * Stores the image and metadata. pump.fun's own upload (IPFS, what its site uses) first; if that is unavailable,
 * this site hosts them under /media/. Returns the metadata URI and the image URL.
 */
export async function uploadMetadata(input: LaunchInput & { bytes: Buffer; type: string }, mint: string): Promise<{ uri: string; image: string }> {
  try {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(input.bytes)], { type: input.type }), `image.${IMAGE[input.type]}`);
    for (const [k, v] of Object.entries({ name: input.name, symbol: input.symbol, description: input.description, twitter: input.twitter, telegram: input.telegram, website: input.website })) form.append(k, v);
    form.append('showName', 'true');
    const http = new Impit({ browser: 'chrome', timeout: 30_000 });
    const res = await http.fetch(launchpad.ipfsUrl, { method: 'POST', body: form, headers: { accept: 'application/json', origin: 'https://pump.fun', referer: 'https://pump.fun/create' } });
    const body = await res.json().catch(() => null) as { metadataUri?: string; metadata?: { image?: string } } | null;
    if (res.ok && typeof body?.metadataUri === 'string' && /^https:\/\//.test(body.metadataUri) && body.metadataUri.length <= 200) {
      return { uri: body.metadataUri, image: typeof body.metadata?.image === 'string' ? body.metadata.image : body.metadataUri };
    }
    console.warn(`[launchpad] pump.fun upload answered ${res.status}; hosting the metadata here`);
  } catch (e) {
    console.warn('[launchpad] pump.fun upload failed; hosting the metadata here:', e instanceof Error ? e.message : e);
  }
  const dir = `${launchpad.dir}/media`;
  mkdirSync(dir, { recursive: true });
  const file = `${mint}.${IMAGE[input.type]}`;
  writeFileSync(`${dir}/${file}`, input.bytes);
  const image = `${launchpad.siteUrl}/media/${file}`;
  const meta = {
    name: input.name, symbol: input.symbol, description: input.description, image, showName: true, createdOn: launchpad.siteUrl,
    ...(input.twitter ? { twitter: input.twitter } : {}), ...(input.telegram ? { telegram: input.telegram } : {}), ...(input.website ? { website: input.website } : {}),
  };
  writeFileSync(`${dir}/${mint}.json`, JSON.stringify(meta));
  return { uri: `${launchpad.siteUrl}/media/${mint}.json`, image };
}

/** The instructions of a launch. Also used to find which accounts every launch shares, for the lookup table. */
async function launchIxs(online: OnlinePumpSdk, lp: PublicKey, mint: PublicKey, user: PublicKey, meta: { name: string; symbol: string; uri: string }, devBuy: bigint, feeLamports: number) {
  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.priorityMicroLamports }),
    // No quote mint: the coin trades against SOL, so its creator fees arrive in SOL.
    await PUMP_SDK.createV2Instruction({ mint, name: meta.name, symbol: meta.symbol, uri: meta.uri, creator: lp, user, mayhemMode: false }),
    // Moves the coin's creator to its own fee-sharing config, whose vault pays the launchpad wallet: fees stay per coin.
    await PUMP_SDK.createFeeSharingConfig({ creator: lp, mint, pool: null }),
  ];
  let tokens = 0n;
  if (devBuy > 0n) {
    const [global, feeConfig] = await Promise.all([online.fetchGlobal(), online.fetchFeeConfig()]);
    const curve = newBondingCurve(global);
    curve.creator = feeSharingConfigPda(mint);
    const amount = new BN(devBuy.toString());
    const out = getBuyV3TokenAmountFromQuoteAmount({ global, feeConfig, mintSupply: curve.tokenTotalSupply, bondingCurve: curve, amount, curveBaseTokenBalance: curve.realTokenReserves, quoteTransferFee: null });
    tokens = BigInt(out.toString());
    // v3 keeps the creator fee on the curve until it is swept into the coin's own vault, so even this first buy pays the coin's callers.
    ixs.push(...(await PUMP_SDK.buyExactQuoteInV3Instructions({ bondingCurve: curve, associatedUserAccountInfo: null, mint, user, amount: out, quoteAmount: amount, slippage: 1, tokenProgram: TOKEN_2022_PROGRAM_ID })));
  }
  if (feeLamports > 0) ixs.push(SystemProgram.transfer({ fromPubkey: user, toPubkey: lp, lamports: feeLamports }));
  return { ixs, tokens };
}
const keysOf = (ixs: TransactionInstruction[]) => new Set(ixs.flatMap((ix) => [ix.programId.toBase58(), ...ix.keys.map((k) => k.pubkey.toBase58())]));

export class Launcher {
  readonly conn: Connection;
  readonly online: OnlinePumpSdk;
  private table: AddressLookupTableAccount | null = null;
  private tableBusy: Promise<AddressLookupTableAccount> | null = null;

  readonly key: Keypair;
  private readonly registry: Registry;

  constructor(key: Keypair, registry: Registry, conn?: Connection) {
    this.key = key;
    this.registry = registry;
    this.conn = conn ?? new Connection(config.rpcUrl, 'confirmed');
    this.online = new OnlinePumpSdk(this.conn as never);
  }

  /**
   * A launch with a first buy needs more accounts than one transaction holds. The accounts every launch shares
   * (pump.fun's programs and settings) go into one lookup table, created once by the launchpad wallet (~0.003 SOL).
   */
  lookupTable(): Promise<AddressLookupTableAccount> {
    if (this.table) return Promise.resolve(this.table);
    this.tableBusy ??= this.loadOrCreateTable().finally(() => { this.tableBusy = null; });
    return this.tableBusy;
  }
  private async loadOrCreateTable(): Promise<AddressLookupTableAccount> {
    const saved = this.registry.get('lookup_table');
    if (saved) {
      const t = (await this.conn.getAddressLookupTable(new PublicKey(saved))).value;
      if (t && t.state.addresses.length > 0) return (this.table = t);
    }
    const lp = this.key.publicKey;
    if ((await this.conn.getBalance(lp)) < 10_000_000) {
      console.error(`[launchpad] the launchpad wallet ${lp.toBase58()} needs SOL (0.05 or more) before the first launch`);
      throw new LaunchError('Launches are paused for a moment. Try again later.');
    }
    // Two launches for different coins and wallets: what they have in common is fixed.
    const a = keysOf((await launchIxs(this.online, lp, Keypair.generate().publicKey, Keypair.generate().publicKey, { name: 'a', symbol: 'a', uri: 'a' }, 1_000_000n, 1)).ixs);
    const b = keysOf((await launchIxs(this.online, lp, Keypair.generate().publicKey, Keypair.generate().publicKey, { name: 'b', symbol: 'b', uri: 'b' }, 1_000_000n, 1)).ixs);
    const fixed = [...a].filter((k) => b.has(k) && k !== lp.toBase58()).map((k) => new PublicKey(k));
    const slot = await this.conn.getSlot('finalized');
    const [create, address] = AddressLookupTableProgram.createLookupTable({ authority: lp, payer: lp, recentSlot: slot });
    const extend = AddressLookupTableProgram.extendLookupTable({ lookupTable: address, authority: lp, payer: lp, addresses: fixed });
    await this.sendOwn([create, extend]);
    this.registry.set('lookup_table', address.toBase58());
    console.log(`[launchpad] lookup table ${address.toBase58()} with ${fixed.length} accounts`);
    // A table can be used from the slot after it was extended.
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      const t = (await this.conn.getAddressLookupTable(address)).value;
      if (t && t.state.addresses.length === fixed.length && (await this.conn.getSlot('confirmed')) > t.state.lastExtendedSlot) return (this.table = t);
    }
    throw new LaunchError('Launches are warming up. Try again in a minute.');
  }
  private async sendOwn(ixs: TransactionInstruction[]): Promise<void> {
    const { blockhash, lastValidBlockHeight } = await this.conn.getLatestBlockhash('confirmed');
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: this.key.publicKey, recentBlockhash: blockhash, instructions: [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.priorityMicroLamports }), ...ixs] }).compileToV0Message());
    tx.sign([this.key]);
    const sig = await this.conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
    const res = await this.conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    if (res.value.err) throw new Error(`launchpad setup failed: ${JSON.stringify(res.value.err)}`);
  }

  /** The launch transaction for the launcher to sign, already signed for the mint and the launchpad. */
  async prepare(input: LaunchInput & { bytes: Buffer; type: string }): Promise<{ mint: string; tx: string; lastValid: number; uri: string; image: string; tokens: string }> {
    const table = await this.lookupTable();
    const lp = this.key.publicKey;
    const user = new PublicKey(input.launcher);
    const mint = Keypair.generate();
    const devBuy = BigInt(Math.round(input.devBuy * LAMPORTS));
    const feeLamports = Math.round(launchpad.feeSol * LAMPORTS);
    const solHave = BigInt(await this.conn.getBalance(user));
    // The launch fee, pump.fun's rent for the new coin's accounts, and the first buy with its trading fee.
    const need = BigInt(feeLamports) + 30_000_000n + (devBuy * 102n) / 100n;
    if (solHave < need) {
      throw new LaunchError(`That wallet needs about ${(Number(need) / LAMPORTS).toFixed(3)} SOL: the ${launchpad.feeSol} SOL launch fee, pump.fun's cost to create the coin${devBuy > 0n ? ' and the first buy' : ''}.`);
    }
    const meta = await uploadMetadata(input, mint.publicKey.toBase58());
    const { ixs, tokens } = await launchIxs(this.online, lp, mint.publicKey, user, { name: input.name, symbol: input.symbol, uri: meta.uri }, devBuy, feeLamports);
    const { blockhash, lastValidBlockHeight } = await this.conn.getLatestBlockhash('confirmed');
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: user, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message([table]));
    if (tx.serialize().length > 1232) throw new LaunchError('The launch does not fit in one transaction. Try again without the first buy.');
    // Proves the launch works before the launcher sees it: a wallet that cannot pay fails here, not in their wallet.
    const sim = await this.conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
    if (sim.value.err) {
      const logs = (sim.value.logs ?? []).join(' ');
      console.warn('[launchpad] launch simulation failed:', JSON.stringify(sim.value.err), logs.slice(-400));
      throw new LaunchError(/insufficient|0x1\b/i.test(logs) ? 'That wallet cannot cover the launch. Add SOL and try again.' : 'pump.fun refused this launch right now. Try again in a minute.');
    }
    tx.sign([mint, this.key]);
    return { mint: mint.publicKey.toBase58(), tx: Buffer.from(tx.serialize()).toString('base64'), lastValid: lastValidBlockHeight, uri: meta.uri, image: meta.image, tokens: tokens.toString() };
  }

  /** Whether a launch landed: the coin exists, paired to SOL, with its fees going to its own sharing vault. */
  async landed(mint: string): Promise<boolean> {
    const acc = await this.conn.getAccountInfo(bondingCurvePda(new PublicKey(mint)));
    if (!acc) return false;
    const curve = PUMP_SDK.decodeBondingCurve(acc as never);
    return isSolLikeQuoteMint(curve.quoteMint) && curve.creator.equals(feeSharingConfigPda(new PublicKey(mint)));
  }
  async expired(lastValid: number): Promise<boolean> {
    return (await this.conn.getBlockHeight('confirmed')) > lastValid;
  }
}
