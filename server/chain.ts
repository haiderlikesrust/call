// Everything that touches Solana. A transaction's signature is handed to `onSigned` (which writes it
// to disk) BEFORE broadcast, so a crash can never turn into a second payment.
//
// Callers are paid in USDC. Buybacks swap USDC for the coin through Jupiter and burn what they bought.
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction, type TransactionInstruction,
} from '@solana/web3.js';
import {
  AccountLayout, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createBurnCheckedInstruction,
  createTransferCheckedInstruction, getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import bs58 from 'bs58';
import { LAMPORTS, USDC_DECIMALS, USDC_MINT, config } from './config.ts';

export type Outcome = 'confirmed' | 'failed' | 'expired' | 'pending';
export type OnSigned = (sig: string, lastValid: number) => void;
export interface Holders { at: number; balances: Map<string, bigint> }
export interface Chain {
  readonly canSign: boolean;
  /** USDC this coin can pay out, in base units. */
  treasuryBalance(): Promise<bigint>;
  supply(): Promise<bigint>;
  holding(wallet: string): Promise<bigint>;
  /** Every wallet holding the coin, with its balance, and when that read started (ms). */
  holders(): Promise<Holders>;
  solOk(): Promise<boolean>;
  /** Collects fees and turns them into USDC. Returns a signature when something moved. */
  claim(): Promise<string | null>;
  pay(items: { wallet: string; amount: bigint }[], onSigned: OnSigned): Promise<Outcome>;
  resolve(sig: string, lastValid: number): Promise<Outcome>;
  /** Swaps USDC for the coin, to burn. */
  buyback(usdcIn: bigint, onSigned: OnSigned): Promise<Outcome>;
  bought(sig: string): Promise<bigint>;
  burn(which: 'quote' | 'coin', amount: bigint, onSigned: OnSigned): Promise<Outcome>;
}

export const USDC = new PublicKey(USDC_MINT);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const keypair = (secret: string): Keypair =>
  Keypair.fromSecretKey(secret.startsWith('[') ? Uint8Array.from(JSON.parse(secret)) : bs58.decode(secret));
/** Network fees and any token account a swap opens. A swap that costs more SOL than this is refused. */
const SWAP_SOL_SLACK = BigInt(Math.round(0.01 * LAMPORTS));

export interface ChainOpts {
  /** The coin. */
  mint: string;
  /** The paying wallet; null to only read. */
  signer: Keypair | null;
  live?: boolean;
  conn?: Connection;
}

export class SolanaChain implements Chain {
  readonly conn: Connection;
  readonly signer: Keypair | null;
  readonly treasury: PublicKey | null;
  readonly coin: PublicKey;
  private readonly live: boolean;
  private coinInfo: { program: PublicKey; decimals: number } | null = null;

  constructor(o: ChainOpts) {
    this.conn = o.conn ?? new Connection(config.rpcUrl, 'confirmed');
    this.signer = o.signer;
    this.treasury = this.signer?.publicKey ?? null;
    this.coin = new PublicKey(o.mint);
    this.live = o.live ?? config.live;
  }
  private supplyCache = { at: 0, v: 0n };
  private holderCache: Holders = { at: 0, balances: new Map() };

  get canSign() { return this.signer !== null && this.live; }
  protected me(): Keypair {
    if (!this.signer || !this.live) throw new Error('live payouts are off');
    return this.signer;
  }
  usdcAta(owner: PublicKey) { return getAssociatedTokenAddressSync(USDC, owner, true, TOKEN_PROGRAM_ID); }
  protected async coinMeta() {
    if (!this.coinInfo) {
      const acc = await this.conn.getParsedAccountInfo(this.coin);
      if (!acc.value) throw new Error('coin mint not found on-chain');
      const data = acc.value.data as { parsed?: { info?: { decimals?: number } } };
      const decimals = data.parsed?.info?.decimals;
      if (decimals === undefined) throw new Error('coin mint is not a token mint');
      this.coinInfo = { program: acc.value.owner, decimals };
    }
    return this.coinInfo;
  }

  /** The wallet's actual USDC. A launched coin's own share of it is its treasuryBalance. */
  async walletUsdc(): Promise<bigint> {
    if (!this.treasury) return 0n;
    const acc = await this.conn.getAccountInfo(this.usdcAta(this.treasury));
    return acc ? AccountLayout.decode(acc.data.subarray(0, AccountLayout.span)).amount : 0n;
  }
  async treasuryBalance() { return this.walletUsdc(); }
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
    return !!this.treasury && (await this.conn.getBalance(this.treasury)) >= config.minSolReserve * LAMPORTS;
  }

  protected async build(ixs: TransactionInstruction[], units: number) {
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
  protected async send(tx: VersionedTransaction, lastValid: number, onSigned: OnSigned): Promise<Outcome> {
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

  /** Outside the launchpad there are no creator fees to collect. LaunchChain overrides this. */
  async claim(): Promise<string | null> { return null; }

  async pay(items: { wallet: string; amount: bigint }[], onSigned: OnSigned) {
    const me = this.me();
    const from = this.usdcAta(me.publicKey);
    const ixs: TransactionInstruction[] = [];
    for (const it of items) {
      const owner = new PublicKey(it.wallet);
      const to = this.usdcAta(owner);
      ixs.push(
        createAssociatedTokenAccountIdempotentInstruction(me.publicKey, to, owner, USDC, TOKEN_PROGRAM_ID),
        createTransferCheckedInstruction(from, USDC, to, me.publicKey, it.amount, USDC_DECIMALS, [], TOKEN_PROGRAM_ID),
      );
    }
    const { tx, lastValid } = await this.build(ixs, 40_000 + 40_000 * items.length);
    return this.send(tx, lastValid, onSigned);
  }

  /** A Jupiter swap for this wallet, unsigned. */
  protected async jupiter(inputMint: string, outputMint: string, amount: bigint, slippageBps: number) {
    const me = this.me();
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(config.jupiterKey ? { 'x-api-key': config.jupiterKey } : {}) };
    const q = new URLSearchParams({ inputMint, outputMint, amount: amount.toString(), slippageBps: String(slippageBps) });
    const quote = await json(await fetch(`${config.jupiterBase}/quote?${q}`, { headers, signal: AbortSignal.timeout(10_000) }));
    const swap = await json(await fetch(`${config.jupiterBase}/swap`, {
      method: 'POST', headers, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ quoteResponse: quote, userPublicKey: me.publicKey.toBase58(), dynamicComputeUnitLimit: true, wrapAndUnwrapSol: true }),
    }));
    return { tx: VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, 'base64')), lastValid: Number(swap.lastValidBlockHeight), minOut: BigInt(quote.otherAmountThreshold) };
  }

  /**
   * The swap is built by a third party, so prove what it does to our wallet before signing it: only we sign, no
   * token account changes hands or gains a delegate, it spends no more than allowed and returns at least the quote.
   * `spend` is the token account paid from, or null when paying in native SOL.
   */
  protected async assertSwap(tx: VersionedTransaction, o: { spend: PublicKey | null; maxSpend: bigint; out: PublicKey; minOut: bigint; maxSol: bigint }) {
    const me = this.me().publicKey;
    if (!tx.message.staticAccountKeys[0]?.equals(me) || tx.message.header.numRequiredSignatures !== 1) throw new Error('swap: unexpected signers');
    const tokens = [o.spend, o.out].filter((k): k is PublicKey => k !== null);
    const watch = [...tokens, me];
    const before = await this.conn.getMultipleAccountsInfo(watch);
    const sim = await this.conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, accounts: { encoding: 'base64', addresses: watch.map((k) => k.toBase58()) } });
    if (sim.value.err) throw new Error(`swap would fail: ${JSON.stringify(sim.value.err)}`);
    const after = sim.value.accounts ?? [];
    const amount = (data: Buffer | null | undefined) => (data && data.length >= AccountLayout.span ? AccountLayout.decode(data.subarray(0, AccountLayout.span)).amount : 0n);
    for (let i = 0; i < tokens.length; i++) {
      const d = decode(after[i]?.data);
      if (!d || !d.owner.equals(me) || d.delegateOption !== 0 || d.closeAuthorityOption !== 0) throw new Error('swap: token account authority would change');
    }
    let k = 0;
    if (o.spend) {
      const spent = amount(before[k]?.data) - decodeAmount(after[k]?.data);
      if (spent > o.maxSpend) throw new Error('swap: spends more than allowed');
      k++;
    }
    if (decodeAmount(after[k]?.data) - amount(before[k]?.data) < o.minOut) throw new Error('swap: returns less than quoted');
    const solSpent = BigInt(before[watch.length - 1]?.lamports ?? 0) - BigInt(after[watch.length - 1]?.lamports ?? 0);
    if (solSpent > o.maxSol) throw new Error('swap: spends too much SOL');
  }

  async buyback(usdcIn: bigint, onSigned: OnSigned): Promise<Outcome> {
    const me = this.me();
    const { program } = await this.coinMeta();
    const { tx, lastValid, minOut } = await this.jupiter(USDC_MINT, this.coin.toBase58(), usdcIn, config.burnSlippageBps);
    await this.assertSwap(tx, { spend: this.usdcAta(me.publicKey), maxSpend: usdcIn, out: getAssociatedTokenAddressSync(this.coin, me.publicKey, true, program), minOut, maxSol: SWAP_SOL_SLACK });
    return this.send(tx, lastValid, onSigned);
  }

  /** This wallet's SOL and token change in one confirmed transaction. Throws until the RPC has indexed it. */
  protected async deltas(sig: string, mint: string): Promise<{ lamports: bigint; tokens: bigint }> {
    const tx = await this.conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
    if (!tx?.meta) throw new Error('transaction not indexed yet');
    const owner = this.treasury!.toBase58();
    const i = tx.transaction.message.accountKeys.findIndex((k) => k.pubkey.toBase58() === owner);
    const lamports = i < 0 ? 0n : BigInt(tx.meta.postBalances[i] ?? 0) - BigInt(tx.meta.preBalances[i] ?? 0);
    const sum = (l: typeof tx.meta.preTokenBalances) => (l ?? []).filter((b) => b.mint === mint && b.owner === owner).reduce((n, b) => n + BigInt(b.uiTokenAmount.amount), 0n);
    return { lamports, tokens: sum(tx.meta.postTokenBalances) - sum(tx.meta.preTokenBalances) };
  }
  async bought(sig: string) {
    return (await this.deltas(sig, this.coin.toBase58())).tokens;
  }
  async burn(which: 'quote' | 'coin', amount: bigint, onSigned: OnSigned) {
    // USDC is never burned: it is what callers are paid in. Burns are always bought coins.
    if (which !== 'coin') throw new Error('only the coin is burned');
    const me = this.me();
    const { program, decimals } = await this.coinMeta();
    const ata = getAssociatedTokenAddressSync(this.coin, me.publicKey, true, program);
    const { tx, lastValid } = await this.build([createBurnCheckedInstruction(ata, this.coin, me.publicKey, amount, decimals, [], program)], 60_000);
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
