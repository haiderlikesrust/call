import { useRef, useState, type FormEvent } from 'react';
import { fmt, short, type CoinList } from './live.ts';
import { go, onLink } from './route.ts';
import { CoinImage, Empty, SplitBar } from './ui.tsx';
import { connect, signAndSend, useWallets, type Wallet, type WalletAccount } from './wallet.ts';

type Step = 'idle' | 'preparing' | 'signing' | 'landing';
const STEP: Record<Step, string> = { idle: 'Launch it', preparing: 'Building the launch…', signing: 'Approve it in your wallet…', landing: 'Landing on Solana…' };
const b64 = (s: string) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));

export function Launch({ list }: { list: CoinList | null }) {
  const wallets = useWallets();
  const [wallet, setWallet] = useState<{ w: Wallet; a: WalletAccount } | null>(null);
  const [f, setF] = useState({ name: '', symbol: '', description: '', website: '', twitter: '', telegram: '', devBuy: '' });
  const [image, setImage] = useState<string>('');
  const [step, setStep] = useState<Step>('idle');
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));

  const pick = async (w: Wallet) => {
    setError(null);
    try { setWallet({ w, a: await connect(w) }); } catch (e) { setError(e instanceof Error ? e.message : 'The wallet did not connect.'); }
  };
  const readImage = (fl: File | undefined) => {
    setError(null);
    if (!fl) return;
    if (!/^image\/(png|jpeg|gif|webp)$/.test(fl.type)) return setError('Use a PNG, JPEG, GIF or WebP image.');
    if (fl.size > 4 * 1024 * 1024) return setError('The image can be at most 4 MB.');
    const r = new FileReader();
    r.onload = () => setImage(String(r.result));
    r.readAsDataURL(fl);
  };

  const launch = async (e: FormEvent) => {
    e.preventDefault();
    if (!wallet) return setError('Connect a wallet first.');
    if (!image) return setError('Add an image for the coin.');
    setError(null);
    setStep('preparing');
    try {
      const r = await fetch('/api/launch/prepare', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...f, devBuy: Number(f.devBuy || 0), image, launcher: wallet.a.address }),
      });
      const body = await r.json().catch(() => null);
      if (!r.ok) throw new Error(body?.error ?? 'Could not build the launch.');
      setStep('signing');
      await signAndSend(wallet.w, wallet.a, b64(body.tx));
      setStep('landing');
      await fetch('/api/launch/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mint: body.mint }) }).catch(() => null);
      go(`/coin/${body.mint}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(/reject|denied|cancel/i.test(msg) ? 'The launch was cancelled in the wallet. Nothing was sent.' : msg);
      setStep('idle');
    }
  };

  const busy = step !== 'idle';
  const closed = list && !list.canLaunch;
  const buy = Number(f.devBuy) || 0;
  return (
    <main className="wrap section launch">
      <a className="back" href="/" onClick={onLink}>← All coins</a>
      <div className="sec-head">
        <div>
          <p className="kicker">New coin</p>
          <h1>Launch a coin</h1>
          <p className="lede">It goes live on pump.fun, paired with SOL. You sign and pay in your own wallet; nothing is sent until you approve it there.</p>
        </div>
      </div>
      {closed && <Empty>{list.mode === 'demo' ? 'Launches are off in the demo. Everything else on the site works.' : 'Launches open soon.'}</Empty>}
      <form className="launch-grid" onSubmit={launch} aria-disabled={!!closed}>
        <fieldset className="panel launch-form" disabled={busy || !!closed}>
          <div className="fields">
            <label>Name<input value={f.name} onChange={set('name')} maxLength={32} required placeholder="Moth Lamp" /></label>
            <label>Ticker<input value={f.symbol} onChange={set('symbol')} maxLength={10} required placeholder="MOTH" pattern="\$?[A-Za-z0-9]{1,10}" /></label>
            <label className="wide">Description<textarea value={f.description} onChange={set('description')} maxLength={500} rows={3} placeholder="What is it about?" /></label>
            <label>Website<input value={f.website} onChange={set('website')} maxLength={200} placeholder="https://" inputMode="url" /></label>
            <label>X<input value={f.twitter} onChange={set('twitter')} maxLength={200} placeholder="https://x.com/…" inputMode="url" /></label>
            <label>Telegram<input value={f.telegram} onChange={set('telegram')} maxLength={200} placeholder="https://t.me/…" inputMode="url" /></label>
            <label>First buy, in SOL<input value={f.devBuy} onChange={set('devBuy')} inputMode="decimal" placeholder="0 (optional)" pattern="[0-9]*[.]?[0-9]*" /></label>
          </div>
          <button type="button" className="drop" onClick={() => file.current?.click()}
            onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); readImage(e.dataTransfer.files[0]); }}>
            {image ? <img src={image} alt="The coin's image" /> : <span><b>Add an image</b><small>PNG, JPEG, GIF or WebP, up to 4 MB. Drop it here or click.</small></span>}
          </button>
          <input ref={file} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e) => readImage(e.target.files?.[0])} />
        </fieldset>

        <div className="launch-side">
          <div className="panel preview" aria-label="Preview">
            <p className="panel-label">Preview</p>
            <div className="card-top">
              {image ? <img className="coin-img" src={image} alt="" width={56} height={56} style={{ width: 56, height: 56 }} /> : <CoinImage coin={{ image: '', symbol: f.symbol || '??', mint: f.name || 'new' }} size={56} />}
              <div className="card-id">
                <p className="card-name">{f.name || 'Your coin'}</p>
                <p className="card-sym">${(f.symbol || 'TICKER').replace(/^\$/, '').toUpperCase()}<span>just now</span></p>
              </div>
              <span className="tag tag-new">new</span>
            </div>
            {f.description && <p className="card-desc">{f.description}</p>}
            {list && <SplitBar split={list.split} platform={list.platform?.symbol} compact />}
          </div>

          <div className="panel">
            <p className="panel-label">Wallet</p>
            {wallet
              ? <p>Launching from <b className="mono">{short(wallet.a.address)}</b> <button type="button" className="linkish" onClick={() => setWallet(null)} disabled={busy}>change</button></p>
              : wallets.length
                ? <div className="row">{wallets.map((w) => <button type="button" key={w.name} className="btn btn-ghost" onClick={() => pick(w)} disabled={!!closed}><img src={w.icon} alt="" width="20" height="20" />{w.name}</button>)}</div>
                : <p className="dim">No Solana wallet found in this browser. Install Phantom, Solflare or Backpack, then reload.</p>}
            <p className="cost">Costs {list ? list.feeSol : '…'} SOL launch fee, about 0.02 SOL pump.fun charges to create the coin, and the network fee{buy > 0 ? `, plus ${fmt(buy, 4)} SOL for your first buy` : ''}. You cannot earn from your own coin's callouts.</p>
            <button className="btn btn-big btn-wide" disabled={busy || !wallet || !!closed}>{STEP[step]}</button>
            {error && <p className="bad" role="alert">{error}</p>}
          </div>
        </div>
      </form>
    </main>
  );
}
