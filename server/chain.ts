// Everything that touches Solana. A transaction's signature is handed to `onSigned` (which writes it
// to disk) BEFORE broadcast, so a crash can never turn into a second payment.
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction, type TransactionInstruction,
} from '@solana/web3.js';
import {
  AccountLayout, TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createBurnCheckedInstruction,
  createTransferCheckedWithTransferHookInstruction, getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { OnlinePumpSdk, PUMP_SDK, canonicalPumpPoolPdaWithQuote } from '@pump-fun/pump-sdk';
import { OnlinePumpAmmSdk } from '@pump-fun/pump-swap-sdk';
import bs58 from 'bs58';
import { PUMP_DECIMALS, PUMP_MINT, config } from './config.ts';

export type Outcome = 'confirmed' | 'failed' | 'expired' | 'pending';
export type OnSigned = (sig: string, lastValid: number) => void;
export interface Holders { at: number; balances: Map<string, bigint> }
export interface Chain {
  readonly canSign: boolean;
  treasuryBalance(): Promise<bigint>;
  supply(): Promise<bigint>;
  holding(wallet: string): Promise<bigint>;
  /** Every wallet holding the coin, with its balance, and when that read started (ms). */
  holders(): Promise<Holders>;
  solOk(): Promise<boolean>;
  claim(): Promise<string | null>;
  pay(items: { wallet: string; amount: bigint }[], onSigned: OnSigned): Promise<Outcome>;
  resolve(sig: string, lastValid: number): Promise<Outcome>;
  buyback(pumpIn: bigint, onSigned: OnSigned): Promise<Outcome>;
  bought(sig: string): Promise<bigint>;
  burn(mint: 'pump' | 'coin', amount: bigint, onSigned: OnSigned): Promise<Outcome>;
}

const PUMP = new PublicKey(PUMP_MINT);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const keypair = (secret: string): Keypair =>
  Keypair.fromSecretKey(secret.startsWith('[') ? Uint8Array.from(JSON.parse(secret)) : bs58.decode(secret));

export class SolanaChain implements Chain {
  readonly conn = new Connection(config.rpcUrl, 'confirmed');
  readonly signer: Keypair | null = config.treasurySecret ? keypair(config.treasurySecret) : null;
  readonly treasury: PublicKey | null = this.signer?.publicKey ?? (config.treasuryPubkey ? new PublicKey(config.treasuryPubkey) : null);
  readonly coin = new PublicKey(config.coinMint);
  private coinInfo: { program: PublicKey; decimals: number } | null = null;
  private supplyCache = { at: 0, v: 0n };
  private holderCache: Holders = { at: 0, balances: new Map() };

  get canSign() { return this.signer !== null && config.live; }
  private me(): Keypair {
    if (!this.signer || !config.live) throw new Error('live payouts are off');
    return this.signer;
  }
  private pumpAta(owner: PublicKey) { return getAssociatedTokenAddressSync(PUMP, owner, true, TOKEN_2022_PROGRAM_ID); }
  private async coinMeta() {
    if (!this.coinInfo) {
      const acc = await this.conn.getParsedAccountInfo(this.coin);
      if (!acc.value) throw new Error('COIN_MINT not found on-chain');
      const data = acc.value.data as { parsed?: { info?: { decimals?: number } } };
      const decimals = data.parsed?.info?.decimals;
      if (decimals === undefined) throw new Error('COIN_MINT is not a token mint');
      this.coinInfo = { program: acc.value.owner, decimals };
    }
    return this.coinInfo;
  }

  async treasuryBalance() {
    if (!this.treasury) return 0n;
    const acc = await this.conn.getAccountInfo(this.pumpAta(this.treasury));
    return acc ? AccountLayout.decode(acc.data.subarray(0, AccountLayout.span)).amount : 0n;
  }
  async supply() {
    if (Date.now() - this.supplyCache.at > 30_000) this.supplyCache = { at: Date.now(), v: BigInt((await this.conn.getTokenSupply(this.coin)).value.amount) };
    return this.supplyCache.v;
  }
  async holding(wallet: string) {
    const res = await this.conn.getParsedTokenAccountsByOwner(new PublicKey(wallet), { mint: this.coin });
    return res.value.reduce((n, a) => n + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
  }
  /** One read of every token account for the coin. Program-owned accounts (bonding curve, pool) are left out. */
  async holders(): Promise<Holders> {
    if (Date.now() - this.holderCache.at < 30_000) return this.holderCache;
    const { program } = await this.coinMeta();
    // Stamped when the read starts: anything that happened after this may be missing from it.
    const at = Date.now();
    const accs = await this.conn.getProgramAccounts(program, {
      filters: [{ memcmp: { offset: 0, bytes: this.coin.toBase58() } }],
      dataSlice: { offset: 32, length: 40 },
    });
    const out = new Map<string, bigint>();
    for (const { account } of accs) {
      if (account.data.length < 40) continue;
      const amount = account.data.readBigUInt64LE(32);
      if (amount === 0n) continue;
      const owner = new PublicKey(account.data.subarray(0, 32));
      if (!PublicKey.isOnCurve(owner.toBytes())) continue;
      const w = owner.toBase58();
      out.set(w, (out.get(w) ?? 0n) + amount);
    }
    this.holderCache = { at, balances: out };
    return this.holderCache;
  }
  async solOk() {
    return !!this.treasury && (await this.conn.getBalance(this.treasury)) >= config.minSolReserve * 1e9;
  }

  private async build(ixs: TransactionInstruction[], units: number) {
    const { blockhash, lastValidBlockHeight } = await this.conn.getLatestBlockhash('confirmed');
    const msg = new TransactionMessage({
      payerKey: this.me().publicKey, recentBlockhash: blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.priorityMicroLamports }),
        ...ixs,
      ],
    }).compileToV0Message();
    return { tx: new VersionedTransaction(msg), lastValid: lastValidBlockHeight };
  }
  private async send(tx: VersionedTransaction, lastValid: number, onSigned: OnSigned): Promise<Outcome> {
    tx.sign([this.me()]);
    const sig = bs58.encode(tx.signatures[0]!);
    onSigned(sig, lastValid);
    const raw = tx.serialize();
    try {
      await this.conn.sendRawTransaction(raw, { maxRetries: 0, preflightCommitment: 'confirmed' });
    } catch (e) {
      // Preflight refused it, or the RPC dropped the call. Either way only the chain can say whether it
      // landed, so keep polling until the blockhash is provably dead.
      console.error('[chain] send:', e instanceof Error ? e.message : e);
    }
    const stop = Date.now() + 45_000;
    while (Date.now() < stop) {
      await sleep(2000);
      const out = await this.resolve(sig, lastValid);
      if (out !== 'pending') return out;
      await this.conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
    }
    return 'pending';
  }
  async resolve(sig: string, lastValid: number): Promise<Outcome> {
    // Height first: if it is already past the limit and the signature is still unknown, it can never land.
    const height = await this.conn.getBlockHeight('finalized');
    const st = (await this.conn.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0];
    // Only a confirmed verdict counts. A 'processed' error on a minority fork could still land elsewhere.
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return st.err ? 'failed' : 'confirmed';
    return !st && height > lastValid ? 'expired' : 'pending';
  }

  async claim(): Promise<string | null> {
    const me = this.me();
    const online = new OnlinePumpSdk(this.conn as never);
    const curve = await online.fetchBondingCurve(this.coin);
    const pool = canonicalPumpPoolPdaWithQuote(this.coin, PUMP);
    const ixs: TransactionInstruction[] = [
      await PUMP_SDK.sweepCreatorFeeInstruction({ payer: me.publicKey, mint: this.coin, creator: curve.creator, quoteMint: PUMP, quoteTokenProgram: TOKEN_2022_PROGRAM_ID }),
    ];
    if (curve.complete && (await this.conn.getAccountInfo(pool)))
      ixs.push(await new OnlinePumpAmmSdk(this.conn as never).sweepCreatorFeeInstruction(pool, me.publicKey));
    ixs.push(...(await online.collectCoinCreatorFeeV2Instructions(me.publicKey, PUMP, TOKEN_2022_PROGRAM_ID, me.publicKey)));
    const { tx, lastValid } = await this.build(ixs, 400_000);
    const ata = this.pumpAta(me.publicKey);
    const before = await this.treasuryBalance();
    const sim = await this.conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, accounts: { encoding: 'base64', addresses: [ata.toBase58()] } });
    if (sim.value.err) throw new Error(`claim would fail: ${JSON.stringify(sim.value.err)}`);
    const gained = decodeAmount(sim.value.accounts?.[0]?.data) - before;
    if (gained < BigInt(config.minBurn) * 10n ** BigInt(PUMP_DECIMALS)) return null; // not worth the fee yet
    let signature = '';
    const out = await this.send(tx, lastValid, (s) => { signature = s; });
    return out === 'confirmed' ? signature : null;
  }

  async pay(items: { wallet: string; amount: bigint }[], onSigned: OnSigned) {
    const me = this.me();
    const from = this.pumpAta(me.publicKey);
    const ixs: TransactionInstruction[] = [];
    for (const it of items) {
      const owner = new PublicKey(it.wallet);
      const to = this.pumpAta(owner);
      ixs.push(
        createAssociatedTokenAccountIdempotentInstruction(me.publicKey, to, owner, PUMP, TOKEN_2022_PROGRAM_ID),
        await createTransferCheckedWithTransferHookInstruction(this.conn, from, PUMP, to, me.publicKey, it.amount, PUMP_DECIMALS, [], 'confirmed', TOKEN_2022_PROGRAM_ID),
      );
    }
    const { tx, lastValid } = await this.build(ixs, 60_000 + 60_000 * items.length);
    return this.send(tx, lastValid, onSigned);
  }

  async buyback(pumpIn: bigint, onSigned: OnSigned): Promise<Outcome> {
    const me = this.me();
    const { program } = await this.coinMeta();
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(config.jupiterKey ? { 'x-api-key': config.jupiterKey } : {}) };
    const q = new URLSearchParams({ inputMint: PUMP_MINT, outputMint: config.coinMint, amount: pumpIn.toString(), slippageBps: String(config.burnSlippageBps) });
    const quote = await json(await fetch(`${config.jupiterBase}/quote?${q}`, { headers, signal: AbortSignal.timeout(10_000) }));
    const swap = await json(await fetch(`${config.jupiterBase}/swap`, {
      method: 'POST', headers, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ quoteResponse: quote, userPublicKey: me.publicKey.toBase58(), dynamicComputeUnitLimit: true, wrapAndUnwrapSol: true }),
    }));
    const tx = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, 'base64'));
    await this.assertSwapIsSafe(tx, pumpIn, BigInt(quote.otherAmountThreshold), getAssociatedTokenAddressSync(this.coin, me.publicKey, true, program));
    return this.send(tx, Number(swap.lastValidBlockHeight), onSigned);
  }
  /** The swap is built by a third party, so prove what it does to our wallet before signing it. */
  private async assertSwapIsSafe(tx: VersionedTransaction, maxIn: bigint, minOut: bigint, coinAta: PublicKey) {
    const me = this.me().publicKey;
    const keys = tx.message.staticAccountKeys;
    if (!keys[0]?.equals(me) || tx.message.header.numRequiredSignatures !== 1) throw new Error('swap: unexpected signers');
    const pumpAta = this.pumpAta(me);
    const [pumpBefore, coinAcc, solBefore] = await Promise.all([this.treasuryBalance(), this.conn.getAccountInfo(coinAta), this.conn.getBalance(me)]);
    const coinBefore = coinAcc ? AccountLayout.decode(coinAcc.data.subarray(0, AccountLayout.span)).amount : 0n;
    const sim = await this.conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, accounts: { encoding: 'base64', addresses: [pumpAta, coinAta, me].map((k) => k.toBase58()) } });
    if (sim.value.err) throw new Error(`swap would fail: ${JSON.stringify(sim.value.err)}`);
    const [p, c, s] = sim.value.accounts ?? [];
    for (const acc of [p, c]) {
      const d = decode(acc?.data);
      if (!d || !d.owner.equals(me) || d.delegateOption !== 0 || d.closeAuthorityOption !== 0) throw new Error('swap: token account authority would change');
    }
    if (pumpBefore - decodeAmount(p?.data) > maxIn) throw new Error('swap: spends more $PUMP than allowed');
    if (decodeAmount(c?.data) - coinBefore < minOut) throw new Error('swap: returns less than quoted');
    if (solBefore - (s?.lamports ?? 0) > 10_000_000) throw new Error('swap: spends too much SOL');
  }
  async bought(sig: string) {
    const tx = await this.conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
    if (!tx?.meta) throw new Error('swap transaction not indexed yet');
    const owner = this.treasury!.toBase58();
    const sum = (l: typeof tx.meta.preTokenBalances) => (l ?? []).filter((b) => b.mint === config.coinMint && b.owner === owner).reduce((n, b) => n + BigInt(b.uiTokenAmount.amount), 0n);
    return sum(tx.meta.postTokenBalances) - sum(tx.meta.preTokenBalances);
  }
  async burn(which: 'pump' | 'coin', amount: bigint, onSigned: OnSigned) {
    const me = this.me();
    const { mint, program, decimals } = which === 'pump'
      ? { mint: PUMP, program: TOKEN_2022_PROGRAM_ID, decimals: PUMP_DECIMALS }
      : { mint: this.coin, ...(await this.coinMeta()) };
    const ata = getAssociatedTokenAddressSync(mint, me.publicKey, true, program);
    const { tx, lastValid } = await this.build([createBurnCheckedInstruction(ata, mint, me.publicKey, amount, decimals, [], program)], 60_000);
    return this.send(tx, lastValid, onSigned);
  }
}

function decode(data: unknown) {
  const b64 = Array.isArray(data) ? (data[0] as string) : null;
  const buf = b64 ? Buffer.from(b64, 'base64') : null;
  return buf && buf.length >= AccountLayout.span ? AccountLayout.decode(buf.subarray(0, AccountLayout.span)) : null;
}
const decodeAmount = (data: unknown): bigint => decode(data)?.amount ?? 0n;
async function json(res: Response): Promise<any> {
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Jupiter ${res.status}: ${body?.error ?? body?.message ?? 'no route'}`);
  return body;
}
