import { useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { ago, compact, fmt, sol, usd, useEased, useNow, type CoinList, type ListedCoin } from './live.ts';
import { onLink } from './route.ts';
import { CoinImage, Empty, SplitBar } from './ui.tsx';

type Sort = 'new' | 'pot' | 'paid' | 'busy';
const SORTS: { k: Sort; t: string }[] = [{ k: 'new', t: 'Newest' }, { k: 'pot', t: 'Biggest pot' }, { k: 'paid', t: 'Most paid' }, { k: 'busy', t: 'Busiest' }];
const ORDER: Record<Sort, (a: ListedCoin, b: ListedCoin) => number> = {
  new: (a, b) => b.createdAt - a.createdAt,
  pot: (a, b) => b.pot - a.pot,
  paid: (a, b) => b.paidOut - a.paidOut,
  busy: (a, b) => b.lastHour - a.lastHour || b.callouts - a.callouts,
};

export function Home({ list, error }: { list: CoinList | null; error: string | null }) {
  return (
    <main>
      <Hero list={list} />
      {list ? (
        <>
          <section className="wrap band-split" aria-label="Where every coin's fees go">
            <div>
              <p className="kicker">Every SOL of creator fees</p>
              <h2>Split three ways, on every coin.</h2>
            </div>
            <SplitBar split={list.split} platform={list.platform?.symbol} />
          </section>
          {list.platform && <Spotlight coin={list.platform} list={list} />}
          <Coins list={list} />
          <How list={list} />
        </>
      ) : <p className="wrap loading" role="status">{error ?? 'Loading coins…'}</p>}
    </main>
  );
}

function Hero({ list }: { list: CoinList | null }) {
  const t = list?.totals;
  const paid = useEased(t?.paidOut ?? 0);
  return (
    <section className="hero" id="top">
      <div className="wrap hero-in">
        <div className="hero-copy">
          <p className="kicker">A pump.fun launchpad</p>
          <h1>Launch a coin.<br /><span className="hl">Pay the people</span><br />who shout about it.</h1>
          <p className="lede">Coins launched here trade on pump.fun against SOL. Their creator fees are swapped to USDC and paid to holders who call them out on pump.fun. Some of every fee buys the coin back and burns it.</p>
          <div className="row">
            <a className="btn btn-big" href="/launch" onClick={onLink}>Launch a coin</a>
            <a className="btn btn-big btn-ghost" href="#coins">Browse coins</a>
          </div>
        </div>
        <motion.div className="scoreboard" initial={{ y: 10, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ duration: 0.5, ease: 'easeOut' }}>
          <p className="sb-label">Paid to callers, in USDC</p>
          <p className="sb-big">{usd(paid)}</p>
          <dl className="sb-grid">
            <div><dt>Coins launched</dt><dd>{fmt(t?.coins ?? 0)}</dd></div>
            <div><dt>Callouts paid</dt><dd>{fmt(t?.paidCallouts ?? 0)}</dd></div>
            <div><dt>Fees claimed</dt><dd>{sol(t?.feesSol ?? 0)}</dd></div>
            <div><dt>Callouts seen</dt><dd>{compact(t?.callouts ?? 0)}</dd></div>
          </dl>
          <p className="sb-foot"><i className="live-dot" />{list?.mode === 'demo' ? 'demo numbers' : 'live from the ledger'}</p>
        </motion.div>
      </div>
    </section>
  );
}

function Spotlight({ coin, list }: { coin: ListedCoin; list: CoinList }) {
  return (
    <section className="wrap spot" aria-label="The platform coin">
      <a className="spot-card" href={`/coin/${coin.mint}`} onClick={onLink}>
        <div className="spot-id">
          <CoinImage coin={coin} size={88} />
          <div>
            <p className="kicker">The platform coin</p>
            <h2>${coin.symbol}</h2>
            <p className="spot-text">{list.split.platform}% of every coin's fees, on top of its own, go to the people who call out ${coin.symbol}. The more coins launch here, the bigger its pot.</p>
          </div>
        </div>
        <dl className="spot-stats">
          <div><dt>Reward pot</dt><dd>{usd(coin.pot)}</dd></div>
          <div><dt>Paid to callers</dt><dd>{usd(coin.paidOut)}</dd></div>
          <div><dt>From other coins</dt><dd>{sol(coin.fromOthersSol)}</dd></div>
        </dl>
        <span className="spot-go" aria-hidden="true">→</span>
      </a>
    </section>
  );
}

function Coins({ list }: { list: CoinList }) {
  const [sort, setSort] = useState<Sort>('new');
  const [q, setQ] = useState('');
  const now = useNow(15_000);
  const coins = useMemo(() => {
    const s = q.trim().toLowerCase().replace(/^\$/, '');
    return list.coins.filter((c) => !c.platform && (!s || c.name.toLowerCase().includes(s) || c.symbol.toLowerCase().includes(s) || c.mint === q.trim())).sort(ORDER[sort]);
  }, [list.coins, q, sort]);
  return (
    <section className="wrap section" id="coins">
      <div className="sec-head">
        <div>
          <p className="kicker">Launched here</p>
          <h2>Coins</h2>
        </div>
        <div className="tools">
          <div className="tabs" role="tablist" aria-label="Sort coins">
            {SORTS.map((s) => <button key={s.k} role="tab" aria-selected={sort === s.k} className={sort === s.k ? 'on' : ''} onClick={() => setSort(s.k)}>{s.t}</button>)}
          </div>
          <input className="search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, ticker or address" aria-label="Search coins" />
        </div>
      </div>
      {coins.length ? (
        <ol className="grid">
          {coins.map((c, i) => (
            <motion.li key={c.mint} layout initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 8) * 0.03, type: 'spring', stiffness: 220, damping: 24 }}>
              <CoinCard c={c} now={now} />
            </motion.li>
          ))}
        </ol>
      ) : (
        <Empty>{q ? 'No coin matches that.' : list.canLaunch ? 'No coins yet. Launch the first one.' : 'No coins yet. Launches open soon.'}</Empty>
      )}
    </section>
  );
}

function CoinCard({ c, now }: { c: ListedCoin; now: number }) {
  const fresh = now - c.createdAt < 6 * 3_600_000;
  return (
    <a className="card" href={`/coin/${c.mint}`} onClick={onLink}>
      <div className="card-top">
        <CoinImage coin={c} size={56} />
        <div className="card-id">
          <p className="card-name">{c.name}</p>
          <p className="card-sym">${c.symbol}<span>{ago(now - c.createdAt)} old</span></p>
        </div>
        {fresh && <span className="tag tag-new">new</span>}
        {!fresh && c.lastHour > 4 && <span className="tag tag-hot">{c.lastHour}/h</span>}
      </div>
      {c.description && <p className="card-desc">{c.description}</p>}
      <dl className="card-stats">
        <div className="card-pot"><dt>Pot</dt><dd>{usd(c.pot)}</dd></div>
        <div><dt>Paid out</dt><dd>{usd(c.paidOut)}</dd></div>
        <div><dt>Callouts</dt><dd>{fmt(c.callouts)}</dd></div>
      </dl>
    </a>
  );
}

function How({ list }: { list: CoinList }) {
  const steps = [
    { n: '01', t: 'Launch', d: `Name it, add an image, sign once in your wallet. It goes live on pump.fun paired with SOL. The launch fee is ${list.feeSol} SOL.` },
    { n: '02', t: 'Call it out', d: 'Holders post a callout on the coin\'s pump.fun page. We confirm their bag on-chain and start a short hold clock.' },
    { n: '03', t: 'Get paid in USDC', d: `Creator fees come in as SOL. ${list.split.reward}% is swapped to USDC for callers, sized by bag and following. ${list.split.burn}% buys the coin back and burns it.` },
    { n: '04', t: 'Feed the platform', d: `The other ${list.split.platform}% goes to the callers of ${list.platform ? `$${list.platform.symbol}` : 'the platform coin'}, so every launch grows its pot.` },
  ];
  return (
    <section className="how" id="how">
      <div className="wrap section">
        <div className="sec-head"><div><p className="kicker">How it works</p><h2>Four steps, no claiming.</h2></div></div>
        <ol className="steps">
          {steps.map((s) => <li key={s.n}><span className="step-n">{s.n}</span><h3>{s.t}</h3><p>{s.d}</p></li>)}
        </ol>
        <p className="how-note">Launchers cannot earn from their own coin. Every payout is checked against the chain twice, and every transfer is written down before it is sent, so nobody is paid twice.</p>
      </div>
    </section>
  );
}
