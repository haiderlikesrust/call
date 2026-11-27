import { CoinPage } from './Coin.tsx';
import { Home } from './Home.tsx';
import { Launch } from './Launch.tsx';
import { usePoll, useStale, type CoinList } from './live.ts';
import { onLink, usePath } from './route.ts';
import { Wordmark, XLogo } from './ui.tsx';

const MINT = /^\/coin\/([1-9A-HJ-NP-Za-km-z]{32,44})\/?$/;

export function App() {
  const path = usePath();
  const list = usePoll<CoinList>('/api/coins', 8_000);
  const stale = useStale(list.data?.build);
  const coin = MINT.exec(path)?.[1];
  const page = path === '/launch' || path === '/launch/' ? 'launch' : coin ? 'coin' : 'home';
  return (
    <>
      <Nav list={list.data} stale={stale} page={page} />
      {page === 'launch' ? <Launch list={list.data} /> : coin ? <CoinPage key={coin} mint={coin} list={list.data} /> : <Home list={list.data} error={list.error} />}
      <Footer list={list.data} />
    </>
  );
}

function Nav({ list, stale, page }: { list: CoinList | null; stale: boolean; page: string }) {
  const name = (list?.site ?? 'holler').toLowerCase();
  const platform = list?.platform;
  return (
    <header className="nav">
      <div className="wrap nav-in">
        <a className="brand" href="/" onClick={onLink} aria-label={`${name} home`}><Wordmark height={22} alt={name} /></a>
        <nav aria-label="Pages">
          <a href="/#coins" className={page === 'home' ? 'here' : undefined}>Coins</a>
          <a href="/#how">How it works</a>
          {platform && <a href={`/coin/${platform.mint}`} onClick={onLink} className={page === 'coin' && location.pathname.includes(platform.mint) ? 'here' : undefined}>${platform.symbol}</a>}
        </nav>
        <div className="nav-end">
          {stale && <button className="btn btn-ghost" onClick={() => location.reload()}>New version, reload</button>}
          {list?.xUrl && <a className="btn btn-ghost btn-icon" href={list.xUrl} target="_blank" rel="noreferrer" aria-label="On X"><XLogo /></a>}
          <a className="btn" href="/launch" onClick={onLink}>Launch a coin</a>
        </div>
      </div>
      {list?.mode === 'demo' && <p className="bar">Demo. Every coin, callout and payout on this page is invented.</p>}
      {list?.mode === 'dry-run' && <p className="bar">Rehearsal. Callouts are real; payouts are switched off.</p>}
    </header>
  );
}

function Footer({ list }: { list: CoinList | null }) {
  const name = list?.site ?? 'Holler';
  return (
    <footer className="foot">
      <div className="wrap foot-in">
        <div className="foot-brand"><Wordmark height={18} alt={name} /><span>launch it, call it out, get paid in USDC</span></div>
        <div className="foot-links">
          <a href="/launch" onClick={onLink}>Launch a coin</a>
          <a href="/#how">How it works</a>
          {list?.xUrl && <a href={list.xUrl} target="_blank" rel="noreferrer">X</a>}
          <a href="https://pump.fun" target="_blank" rel="noreferrer">pump.fun</a>
        </div>
        <p className="legal">Coins launched here trade on pump.fun. {name} is not made by, affiliated with or endorsed by pump.fun. Rewards come from trading fees: they can be zero and are never guaranteed. Memecoins can go to zero. Nothing here is financial advice.</p>
      </div>
    </footer>
  );
}
