// Small pieces every page uses: the mark, coin images, avatars, the fee split.
import { useState } from 'react';
import { hue, share, short, type LaunchpadList } from './live.ts';

/** The wordmark: italic "holler" in mint, with a speed line off the h. A 2x file keeps it sharp on retina screens. */
export function Wordmark({ height = 22, alt }: { height?: number; alt: string }) {
  return <img className="wordmark" src="/wordmark.png" srcSet="/wordmark@2x.png 2x" alt={alt} height={height} width={Math.round((height * 510) / 96)} />;
}

export const XLogo = ({ size = 16 }: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true"><path fill="currentColor" d="M18.9 2H22l-6.8 7.8L23.2 22h-6.3l-4.9-6.4L6.4 22H3.3l7.3-8.3L2.9 2h6.4l4.4 5.9L18.9 2Zm-1.1 18.1h1.7L8.3 3.8H6.5l11.3 16.3Z" /></svg>
);

export function CoinImage({ coin, size }: { coin: { image: string; symbol: string; mint: string }; size: number }) {
  const [bad, setBad] = useState(false);
  return coin.image && !bad
    ? <img className="coin-img" src={coin.image} alt="" width={size} height={size} referrerPolicy="no-referrer" loading="lazy" onError={() => setBad(true)} style={{ width: size, height: size }} />
    : (
      <span className="coin-img coin-img-none" style={{ width: size, height: size, ['--h' as string]: hue(coin.mint), fontSize: size * 0.32 }} aria-hidden="true">
        {coin.symbol.slice(0, 2)}
      </span>
    );
}

export function Avatar({ c, size = 38 }: { c: { wallet: string; avatar: string | null }; size?: number }) {
  const [bad, setBad] = useState(false);
  return c.avatar && !bad
    ? <img className="ava" src={c.avatar} alt="" width={size} height={size} referrerPolicy="no-referrer" loading="lazy" onError={() => setBad(true)} style={{ width: size, height: size }} />
    : <span className="ava ava-none" style={{ width: size, height: size, ['--h' as string]: hue(c.wallet) }} aria-hidden="true" />;
}

export const who = (c: { username: string | null; wallet: string }) => c.username ?? short(c.wallet);

/** Where a coin's creator fees go, as one bar and its legend. */
export function SplitBar({ split, platform, compact }: { split: LaunchpadList['split']; platform?: string | null; compact?: boolean }) {
  const parts = [
    { k: 'reward', v: split.reward, t: 'to its callers, swapped to USDC' },
    { k: 'burn', v: split.burn, t: 'buys the coin back and burns it' },
    { k: 'platform', v: split.platform, t: `to ${platform ? `$${platform}` : 'the platform coin'}'s callers` },
  ].filter((p) => p.v > 0);
  return (
    <div className={`split ${compact ? 'split-compact' : ''}`}>
      <div className="split-bar" role="img" aria-label={parts.map((p) => `${share(p.v)} ${p.t}`).join(', ')}>
        {parts.map((p) => <i key={p.k} className={`seg seg-${p.k}`} style={{ flexGrow: p.v }}><b>{share(p.v)}</b></i>)}
      </div>
      {!compact && (
        <ul className="split-legend">
          {parts.map((p) => <li key={p.k}><i className={`dot seg-${p.k}`} /><b>{share(p.v)}</b> {p.t}</li>)}
        </ul>
      )}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="empty">{children}</p>;
}
