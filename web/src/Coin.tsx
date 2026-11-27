import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ago, clock, compact, fmt, pct, share, short, sol, usd, useEased, useNow, usePoll, type CoinList, type LaunchpadView, type PublicCallout, type Snapshot } from './live.ts';
import { onLink } from './route.ts';
import { Avatar, CoinImage, Empty, SplitBar, XLogo, who } from './ui.tsx';

const WHY: Record<string, string> = {
  'before-start': 'made before the coin launched', excluded: 'team wallet', dev: 'the dev cannot earn', group: 'squad callout',
  'not-pump-user': 'no pump.fun profile', 'low-quality': 'flagged low quality', 'not-holder': 'holds none', 'low-holding': 'bag too small', late: 'called out before buying',
  'low-followers': 'too few followers', 'new-account': 'account too new', rehearsal: 'made before payouts opened', cooldown: 'called out too soon', 'in-line': 'already has one in line', sold: 'sold before payout',
  deleted: 'callout removed', 'payout-failed': 'transfer failed', 'no-profile': 'profile gone', expired: 'expired in line',
};
const minutes = (m: number) => `${m} minute${m === 1 ? '' : 's'}`;

type Live = Exclude<LaunchpadView, { pending: true }>;

export function CoinPage({ mint, list }: { mint: string; list: CoinList | null }) {
  const { data, error, status } = usePoll<LaunchpadView>(`/api/coins/${mint}`, 4_000);
  if (!data) {
    return (
      <main className="wrap section">
        <a className="back" href="/" onClick={onLink}>← All coins</a>
        <Empty>{status === 404 ? 'No coin by that address was launched here.' : error ?? 'Loading the coin…'}</Empty>
      </main>
    );
  }
  if ('pending' in data) {
    return (
      <main className="wrap section">
        <a className="back" href="/" onClick={onLink}>← All coins</a>
        <div className="coin-head"><CoinImage coin={data.coin} size={96} /><div><h1>{data.coin.name}</h1><p className="coin-sym">${data.coin.symbol}</p></div></div>
        <Empty>Waiting for the launch to land on Solana. This page fills in by itself the moment it does.</Empty>
      </main>
    );
  }
  return <Coin data={data} list={list} />;
}

function Coin({ data, list }: { data: Live; list: CoinList | null }) {
  const s = data.state;
  return (
    <main>
      <Header data={data} />
      <section className="wrap coin-grid">
        <Feed data={s} />
        <aside className="coin-side">
          <PotCard data={s} />
          <Fees data={data} platformSymbol={data.platformSymbol ?? list?.platform?.symbol ?? null} />
        </aside>
      </section>
      <Queue data={s} />
      <section className="wrap coin-pair">
        <Board data={s} />
        <Burns data={s} />
      </section>
      <Rules data={s} />
    </main>
  );
}

function Header({ data }: { data: Live }) {
  const c = data.coin;
  const [copied, setCopied] = useState(false);
  const copy = async () => { try { await navigator.clipboard.writeText(c.mint); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* still selectable */ } };
  return (
    <section className="coin-top">
      <div className="wrap">
        <a className="back" href="/" onClick={onLink}>← All coins</a>
        <div className="coin-head">
          <CoinImage coin={c} size={112} />
          <div className="coin-head-main">
            <div className="coin-title">
              <h1>{c.name}</h1>
              {c.platform && <span className="tag tag-platform">platform coin</span>}
            </div>
            <p className="coin-sym">${c.symbol}<button className="chip-btn mono" onClick={copy} title="Copy the address">{copied ? 'Copied' : short(c.mint)}</button></p>
            {c.description && <p className="coin-desc">{c.description}</p>}
            <div className="row">
              <a className="btn btn-big" href={`https://pump.fun/coin/${c.mint}`} target="_blank" rel="noreferrer">Call it out on pump.fun</a>
              {c.twitter && <a className="btn btn-ghost" href={c.twitter} target="_blank" rel="noreferrer"><XLogo /> X</a>}
              {c.telegram && <a className="btn btn-ghost" href={c.telegram} target="_blank" rel="noreferrer">Telegram</a>}
              {c.website && <a className="btn btn-ghost" href={c.website} target="_blank" rel="noreferrer">Website</a>}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- pot

function PotCard({ data }: { data: Snapshot }) {
  const { pots, stats, rules } = data;
  const reward = useEased(pots.reward);
  const floor = Math.min(100, (pots.reward / Math.max(1e-9, rules.potFloor)) * 100);
  const [pops, setPops] = useState<{ id: string; text: string }[]>([]);
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    const paid = data.feed.filter((c) => c.status === 'paid');
    if (!seen.current) { seen.current = new Set(paid.map((c) => c.id)); return; }
    const fresh = paid.filter((c) => !seen.current!.has(c.id)).slice(0, 3);
    for (const c of paid) seen.current.add(c.id);
    if (!fresh.length) return;
    setPops((p) => [...p, ...fresh.map((c) => ({ id: c.id, text: `${who(c)} +${usd(c.amount ?? 0)}` }))].slice(-4));
    const t = setTimeout(() => setPops((p) => p.filter((x) => !fresh.some((f) => f.id === x.id))), 3200);
    return () => clearTimeout(t);
  }, [data.feed]);
  return (
    <div className="panel pot">
      <p className="panel-label">Reward pot</p>
      <p className="pot-big">{usd(reward)}<small>USDC</small></p>
      <div className="pot-pops" aria-hidden="true">
        <AnimatePresence>
          {pops.map((p) => <motion.span key={p.id} initial={{ opacity: 0, y: 8, scale: 0.9 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -14 }}>{p.text}</motion.span>)}
        </AnimatePresence>
      </div>
      {pots.reward < rules.potFloor && (
        <div className="floor">
          <div className="floor-bar"><i style={{ width: `${floor}%` }} /></div>
          <p>Payouts start at {usd(rules.potFloor)}. Matured callouts wait in line until then.</p>
        </div>
      )}
      <dl className="mini">
        <div><dt>Paid to callers</dt><dd>{usd(stats.paidOut)}</dd></div>
        <div><dt>Callouts paid</dt><dd>{fmt(stats.paidCallouts)}</dd></div>
        <div><dt>Buyback pot</dt><dd>{usd(pots.burn)}</dd></div>
        <div><dt>In line</dt><dd>{fmt(stats.queue)}</dd></div>
      </dl>
    </div>
  );
}

function Fees({ data, platformSymbol }: { data: Live; platformSymbol: string | null }) {
  const c = data.coin;
  return (
    <div className="panel">
      <p className="panel-label">Where this coin's fees go</p>
      <SplitBar split={data.state.split} platform={platformSymbol} />
      <dl className="mini">
        <div><dt>Fees claimed</dt><dd>{sol(data.sol.fees)}</dd></div>
        {c.platform
          ? <div><dt>From other coins</dt><dd>{sol(data.sol.fromOthers)}</dd></div>
          : <div><dt>Sent to {platformSymbol ? `$${platformSymbol}` : 'platform'}</dt><dd>{sol(data.sol.toPlatform)}</dd></div>}
      </dl>
      <p className="panel-note">Fees arrive in SOL and are swapped to USDC before anyone is paid. {c.platform ? 'As the platform coin, it also gets a share of every other coin\'s fees.' : ''}</p>
    </div>
  );
}

// ---------------------------------------------------------------- live feed

function Feed({ data }: { data: Snapshot }) {
  const now = useNow();
  const hold = data.rules.holdMinutes * 60_000;
  const demo = data.mode === 'demo';
  return (
    <div className="panel feed-panel" id="live">
      <div className="panel-head">
        <p className="panel-label">Callouts, as they land</p>
        <span className="live-tag"><i className="live-dot" />live</span>
      </div>
      <ol className="feed" aria-label="Latest callouts">
        <AnimatePresence initial={false}>
          {data.feed.slice(0, 10).map((c) => <FeedRow key={c.id} c={c} now={now} hold={hold} demo={demo} />)}
        </AnimatePresence>
        {data.feed.length === 0 && <li className="feed-empty">No callouts yet. Post one on pump.fun and it shows up here within seconds.</li>}
      </ol>
      <ol className="flow" aria-label="What happens to a callout">
        <li><b>Spotted</b>bag checked on-chain</li>
        <li><b>Holding</b>{demo ? 'a few seconds here' : minutes(data.rules.holdMinutes)}, lowest balance counts</li>
        <li><b>In line</b>oldest paid first</li>
        <li><b>Paid</b>USDC in the wallet</li>
      </ol>
    </div>
  );
}

function FeedRow({ c, now, hold, demo }: { c: PublicCallout; now: number; hold: number; demo: boolean }) {
  const left = c.seenAt + hold - now;
  return (
    <motion.li layout initial={{ opacity: 0, x: -16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} transition={{ type: 'spring', stiffness: 260, damping: 26 }} className={`call is-${c.status}`}>
      <Avatar c={c} />
      <div className="call-main">
        <p className="call-who"><b>{who(c)}</b><span>{pct(c.holdPct)}</span>{c.followers !== null && <span>{compact(c.followers)} followers</span>}<span className="dim">{ago(now - c.createdAt)}</span></p>
        {c.thesis && <p className="call-text">{c.thesis}</p>}
      </div>
      <div className="call-end">
        {c.status === 'paid' && (<><b className="paid">+{usd(c.amount ?? 0)}</b>{c.sig && !demo ? <a href={`https://solscan.io/tx/${c.sig}`} target="_blank" rel="noreferrer">receipt</a> : <small>USDC</small>}</>)}
        {c.status === 'maturing' && (<><b className="ring" style={{ ['--p' as string]: `${Math.min(100, Math.max(0, (1 - left / hold) * 100))}%` }}>{left > 0 ? clock(left) : '…'}</b><small>~{usd(c.estimate ?? 0)}</small></>)}
        {(c.status === 'ready' || c.status === 'sending') && (<><b>{c.status === 'sending' ? 'Sending' : 'In line'}</b><small>~{usd(c.estimate ?? c.amount ?? 0)}</small></>)}
        {(c.status === 'rejected' || c.status === 'expired') && <small className="why">{WHY[c.reason ?? ''] ?? 'not eligible'}</small>}
      </div>
    </motion.li>
  );
}

// ---------------------------------------------------------------- queue

function Queue({ data }: { data: Snapshot }) {
  const now = useNow();
  const { rules, pots } = data;
  return (
    <section className="wrap section-tight" id="queue">
      <div className="sec-head"><div><p className="kicker">The line</p><h2>{data.queue.length ? `${data.queue.length} waiting to be paid` : 'Nobody is waiting'}</h2></div></div>
      {data.queue.length ? (
        <ol className="tickets">
          <AnimatePresence initial={false}>
            {data.queue.slice(0, 12).map((c, i) => (
              <motion.li layout key={c.id} className={`ticket ${c.payableNow ? 'next' : ''}`} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.9 }}>
                <span className="ticket-n">{i + 1}</span>
                <Avatar c={c} size={30} /><b className="ticket-who">{who(c)}</b>
                <span className="ticket-est">~{usd(c.estimate ?? 0)}</span>
                <span className="ticket-wait">{ago(now - (c.readyAt ?? now))} · {Math.min(rules.agingCap, 1 + ((now - (c.readyAt ?? now)) / 3_600_000) * rules.agingPerHour).toFixed(2)}×</span>
              </motion.li>
            ))}
          </AnimatePresence>
        </ol>
      ) : (
        <Empty>{pots.reward >= rules.potFloor ? `The pot holds ${usd(pots.reward)}, so matured callouts are paid straight away.` : `The pot is below its ${usd(rules.potFloor)} floor. Matured callouts will line up here until fees arrive, and every hour in line adds weight.`}</Empty>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- board and burns

function Board({ data }: { data: Snapshot }) {
  const top = data.board[0]?.total ?? 1;
  return (
    <div className="panel">
      <p className="panel-label">Top callers</p>
      {data.board.length ? (
        <ol className="board">
          {data.board.map((b, i) => (
            <li key={b.wallet} style={{ ['--w' as string]: `${Math.max(4, (b.total / top) * 100)}%` }}>
              <span className="board-n">{i + 1}</span><Avatar c={b} size={30} />
              <span className="board-who"><b>{who(b)}</b><small>{b.n} {b.n === 1 ? 'callout' : 'callouts'}</small></span>
              <b className="mono">{usd(b.total)}</b>
            </li>
          ))}
        </ol>
      ) : <p className="panel-empty">The board fills as the first rewards land.</p>}
    </div>
  );
}

function Burns({ data }: { data: Snapshot }) {
  const now = useNow(5000);
  const burned = useEased(data.stats.burnedCoin);
  const burnPart = (data.split.burn / Math.max(1e-9, data.split.reward + data.split.burn)) * 100;
  return (
    <div className="panel burn-panel" id="burns">
      <p className="panel-label">Buyback and burn</p>
      <p className="burn-big">{compact(burned)}<small>${data.coin.symbol} burned</small></p>
      <p className="panel-note">Of the USDC this coin's fees make, {share(burnPart)} buys ${data.coin.symbol} back and burns it, a little after each paid callout.</p>
      <ul className="burns">
        {data.burns.slice(0, 5).map((b) => (
          <li key={b.id}><span>{ago(now - b.at)} ago</span><b>{compact(b.coin ?? 0)} burned</b>
            {data.mode !== 'demo' && b.sig ? <a href={`https://solscan.io/tx/${b.sig}`} target="_blank" rel="noreferrer">receipt</a> : <span>{usd(b.usdc)} in</span>}</li>
        ))}
        {data.burns.length === 0 && <li className="panel-empty">The first burn follows the first rewarded callouts.</li>}
      </ul>
      {data.pots.due > 0 && <p className="dim">{usd(data.pots.due)} is loaded for the next burn.</p>}
    </div>
  );
}

// ---------------------------------------------------------------- rules

function Rules({ data }: { data: Snapshot }) {
  const r = data.rules;
  const demo = data.mode === 'demo';
  const reach = Math.round((1 - r.baseScore - r.bagWeight) * 100);
  const list: [string, string][] = [
    ['Hold', `At least ${r.minHoldBps / 100}% of supply, checked on-chain when you call out and again right before you are paid.`],
    ['Keep holding', `${minutes(demo ? 2 : r.holdMinutes)} without selling. The lowest balance we see is the one that counts.`],
    ['Have a following', `${r.minFollowers}+ pump.fun followers.${r.minAccountAgeDays ? ` Accounts must be ${r.minAccountAgeDays}+ days old.` : ' New accounts are welcome.'}`],
    ['Take turns', `Earn again every ${demo ? 10 : r.cooldownMinutes} minutes, one callout in line at a time.`],
    ['Keep it up', 'Deleting the callout before payout gives up the reward. The launcher can never earn.'],
  ];
  return (
    <section className="rules-band" id="rules">
      <div className="wrap section-tight rules">
        <div>
          <p className="kicker">The maths</p>
          <h2>What one callout pays</h2>
          <p className="formula"><span>pot</span> × <span>{r.maxPotShareBps / 100}%</span> × (<span>{Math.round(r.baseScore * 100)}%</span> + <span>{Math.round(r.bagWeight * 100)}%</span> × bag × streak + <span>{reach}%</span> × reach)</p>
          <ul className="rules-notes">
            <li>Every qualifying callout starts at {Math.round(r.baseScore * 100)}% of the maximum. Your bag adds up to {Math.round(r.bagWeight * 100)}% (full at {r.holdFullBps / 100}% of supply), your pump.fun followers up to {reach}% (full at {compact(r.followersFull)}).</li>
            <li>Holding pays: each paid callout in a row where you kept your bag grows the bag part {Math.round(r.holdStreakRate * 100)}%, up to {r.holdStreakCap}×.</li>
            <li>No callout takes more than {r.maxPotShareBps / 100}% of the pot, or {(r.maxPotShareBps * r.agingCap) / 100}% after waiting in line. Anything under {usd(r.minPayout)} waits for a bigger pot.</li>
          </ul>
        </div>
        <dl className="rules-list">{list.map(([t, d]) => <div key={t}><dt>{t}</dt><dd>{d}</dd></div>)}</dl>
      </div>
    </section>
  );
}
