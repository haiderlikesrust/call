// Solana wallets in the browser through the Wallet Standard, which Phantom, Solflare, Backpack and most others
// implement. No wallet library and no RPC from the page: the wallet signs the launch and sends it itself.
import { useEffect, useState } from 'react';

export interface WalletAccount { address: string; publicKey: Uint8Array; chains?: readonly string[] }
export interface Wallet {
  name: string; icon: string; chains: readonly string[]; accounts: readonly WalletAccount[];
  features: Record<string, any>;
}

const found: Wallet[] = [];
const subs = new Set<() => void>();
let ready = false;

function listen(): void {
  if (ready) return;
  ready = true;
  const api = {
    register: (...ws: Wallet[]) => {
      for (const w of ws) if (!found.includes(w)) found.push(w);
      for (const s of subs) s();
      return () => {
        for (const w of ws) found.splice(found.indexOf(w), 1);
        for (const s of subs) s();
      };
    },
  };
  // Wallets that loaded first answer the app-ready call; later ones announce themselves.
  addEventListener('wallet-standard:register-wallet', ((e: CustomEvent) => e.detail(api)) as EventListener);
  dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api }));
}

const usable = (w: Wallet) => !!w.features['standard:connect'] && !!w.features['solana:signAndSendTransaction'] && w.chains.some((c) => c.startsWith('solana:'));

/** Wallets installed in this browser that can sign and send a Solana transaction. */
export function useWallets(): Wallet[] {
  const [list, set] = useState<Wallet[]>(() => { listen(); return found.filter(usable); });
  useEffect(() => {
    const on = () => set(found.filter(usable));
    subs.add(on);
    on();
    return () => { subs.delete(on); };
  }, []);
  return list;
}

export async function connect(w: Wallet): Promise<WalletAccount> {
  const { accounts } = await w.features['standard:connect'].connect();
  const a = (accounts as WalletAccount[] | undefined)?.[0] ?? w.accounts[0];
  if (!a) throw new Error('The wallet did not share an account.');
  return a;
}

/** Shows the transaction in the wallet; the person approves, and the wallet sends it. */
export async function signAndSend(w: Wallet, account: WalletAccount, tx: Uint8Array): Promise<void> {
  const out = await w.features['solana:signAndSendTransaction'].signAndSendTransaction({ account, transaction: tx, chain: 'solana:mainnet' });
  if (!out?.[0]?.signature) throw new Error('The wallet did not send the launch.');
}
