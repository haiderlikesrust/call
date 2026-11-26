import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Field } from './Field.tsx';
import { Vault } from './Vault.tsx';
import { ago, clock, compact, fmt, pct, short, useEased, useLive, useNow, type PublicCallout, type Snapshot } from './live.ts';

const WHY: Record<string, string> = {
  'before-start': 'made before rewards began', excluded: 'team wallet', dev: 'the dev cannot earn', group: 'squad callout',
  'not-pump-user': 'no pump.fun profile', 'low-quality': 'flagged low quality', 'not-holder': 'holds none', 'low-holding': 'bag too small',
  'low-followers': 'too few followers', 'new-account': 'account too new', rehearsal: 'made before launch', cooldown: 'called out too soon', 'in-line': 'already has one in line', sold: 'sold before payout',
  deleted: 'callout removed', 'payout-failed': 'transfer failed', 'no-profile': 'profile gone', expired: 'expired in queue',
};

export function App() {
  const { data, online, stale } = useLive();
  return (
    <>
      <Nav data={data} online={online} stale={stale} />
      <main>
        <Hero data={data} />
        {data ? (
          <>
            <Pot data={data} />
            <Live data={data} />
            <section className="wrap section" id="earn">
              <Head art="bag" title="What would yours pay?" text="The bigger the pool, the bigger every reward. Your bag and your reach set how much of it you take. Drag the field or the sliders." />
              <Field data={data} />
            </section>
            <Queue data={data} />
            <Furnace data={data} />
            <Board data={data} />
            <Rules data={data} />
          </>
        ) : <p className="wrap loading" role="status">{online ? 'Loading the pot…' : 'The server is not answering. Retrying…'}</p>}
      </main>
      <Footer data={data} />
    </>
  );
}

// ---------------------------------------------------------------- chrome

const XLogo = () => (
  <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path fill="currentColor" d="M18.9 2H22l-6.8 7.8L23.2 22h-6.3l-4.9-6.4L6.4 22H3.3l7.3-8.3L2.9 2h6.4l4.4 5.9L18.9 2Zm-1.1 18.1h1.7L8.3 3.8H6.5l11.3 16.3Z" /></svg>
);
const xHandle = (url: string) => '@' + (url.replace(/\/+$/, '').split('/').pop() ?? '');
const coinUrl = (d: Snapshot | null) => (d?.coin.mint ? `https://pump.fun/coin/${d.coin.mint}` : 'https://pump.fun');

function Nav({ data, online, stale }: { data: Snapshot | null; online: boolean; stale: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(data!.coin.mint); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* address stays selectable on pump.fun */ }
  };
  return (
    <header className="nav">
      <div className="wrap nav-in">
        <a className="brand" href="#top"><img src="/icon.png" alt="" width="40" height="40" /><span>callout</span></a>
        <nav aria-label="Sections">
          <a href="#live">Live</a><a href="#earn">Earn</a><a href="#queue">Queue</a><a href="#furnace">Furnace</a><a href="#board">Leaders</a><a href="#rules">Rules</a>
        </nav>
        <div className="nav-end">
          {stale ? <button className="btn btn-update" onClick={() => location.reload()}>Update</button> : <Status data={data} online={online} />}
          {data?.coin.mint && <button className="btn btn-quiet mono" onClick={copy}>{copied ? 'Copied' : short(data.coin.mint)}</button>}
          {data?.coin.xUrl && <a className="btn btn-x" href={data.coin.xUrl} target="_blank" rel="noreferrer" aria-label={`${xHandle(data.coin.xUrl)} on X`} title={`${xHandle(data.coin.xUrl)} on X`}><XLogo /></a>}
          <a className="btn" href={coinUrl(data)} target="_blank" rel="noreferrer">Call it out</a>
        </div>
      </div>
      {data?.mode === 'demo' && <p className="demo-bar">Demo data. Every name, callout and payout here is invented until the pump.fun API key is connected.</p>}
      {data?.mode === 'prelaunch' && <p className="soon-bar">Not live yet. The pot opens when ${data.coin.symbol} launches.</p>}
      {data?.mode === 'dry-run' && <p className="demo-bar">Rehearsal. Callouts are real, payouts are switched off.</p>}
    </header>
  );
}

function Status({ data, online }: { data: Snapshot | null; online: boolean }) {
  const ok = online && !!data && data.health.source && data.health.problems.length === 0;
  const text = !online ? 'Reconnecting' : !data ? 'Connecting' : data.mode === 'demo' ? 'Demo' : data.mode === 'prelaunch' ? 'Soon' : ok ? `Every ${data.stats.pollMs / 1000}s` : 'Delayed';
  const title = data?.health.problems.length ? `Delayed: ${data.health.problems.join(', ')}` : undefined;
  return <span className={`status ${ok ? 'ok' : 'off'}`} title={title}><i />{text}</span>;
}

function Hero({ data }: { data: Snapshot | null }) {
  const sym = `$${data?.coin.symbol ?? 'CALLOUT'}`;
  const paid = data?.feed.filter((c) => c.status === 'paid') ?? [];
  return (
    <section className="hero" id="top">
      <picture>
        <source media="(max-width: 799px)" srcSet="/art/hero-sm.webp" />
        <img className="hero-art" src="/art/hero.webp" alt="A cream and green pill character on a hill at night, shouting into a megaphone that throws out glowing pills" />
      </picture>
      <div className="wrap hero-in">
        <h1><span>Hold it.</span> <span>Say it.</span> <span className="lit">Get paid.</span></h1>
        <p className="lede">Call out {sym} on pump.fun while you hold it. Creator fees come back to you in $PUMP, sized by your bag and your following. Every reward burns supply.</p>
        <div className="row">
          <a className="btn btn-big" href={coinUrl(data)} target="_blank" rel="noreferrer">Make a callout</a>
          <a className="btn btn-big btn-quiet" href="#earn">See what you'd earn</a>
        </div>
      </div>
      <div className="ticker" aria-hidden="true">
        {paid.length > 0 && (
          <div className="ticker-in">
            {[...paid, ...paid].map((c, i) => <span key={i}><PillDot /> <b>{name(c)}</b> got <em>{compact(c.amount ?? 0)} $PUMP</em> and burned {compact(c.burn ?? 0)}</span>)}
          </div>
        )}
      </div>
    </section>
  );
}

function Head({ art, title, text, flip }: { art: string; title: string; text: string; flip?: boolean }) {
  return (
    <div className={`head ${flip ? 'flip' : ''}`}>
      <div><h2>{title}</h2><p>{text}</p></div>
      <motion.img src={`/art/${art}.webp`} alt="" loading="lazy" initial={{ y: 18, rotate: flip ? -3 : 3 }} whileInView={{ y: 0, rotate: 0 }} viewport={{ once: true, margin: '-60px' }} transition={{ type: 'spring', stiffness: 120, damping: 12 }} />
    </div>
  );
}

const PillDot = () => <i className="pill-dot" aria-hidden="true" />;
const name = (c: { username: string | null; wallet: string }) => c.username ?? short(c.wallet);

function Avatar({ c, size = 42 }: { c: { wallet: string; avatar: string | null }; size?: number }) {
  const [bad, setBad] = useState(false);
  let h = 0;
  for (const ch of c.wallet) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return c.avatar && !bad
    ? <img className="ava" src={c.avatar} alt="" width={size} height={size} referrerPolicy="no-referrer" loading="lazy" onError={() => setBad(true)} style={{ width: size, height: size }} />
    : <span className="ava ava-pill" style={{ width: size, height: size, ['--h' as string]: h }} aria-hidden="true"><i /></span>;
}

// ---------------------------------------------------------------- pot

function Pot({ data }: { data: Snapshot }) {
  const { pots, stats, rules } = data;
  const reward = useEased(pots.reward);
  const burn = useEased(pots.burn);
  const [drops, setDrops] = useState<{ id: string; text: string; x: number }[]>([]);
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    const paid = data.feed.filter((c) => c.status === 'paid');
    if (!seen.current) { seen.current = new Set(paid.map((c) => c.id)); return; }
    const fresh = paid.filter((c) => !seen.current!.has(c.id)).slice(0, 4);
    for (const c of paid) seen.current.add(c.id);
    if (!fresh.length) return;
    setDrops((d) => [...d, ...fresh.map((c, i) => ({ id: c.id, text: `${name(c)}  +${compact(c.amount ?? 0)}`, x: 6 + ((drops.length + i) % 4) * 18 }))].slice(-6));
    const t = setTimeout(() => setDrops((d) => d.filter((x) => !fresh.some((f) => f.id === x.id))), 4200);
    return () => clearTimeout(t);
  }, [data.feed]);

  return (
    <section className="wrap pot" aria-label="The pot">
      <div className="pot-top">
        <div><p className="label">Reward pot, 80% of fees</p><p className="big green">{fmt(reward)}<small> $PUMP</small></p></div>
        <div className="right"><p className="label">Burn pot, 20%</p><p className="big ember">{fmt(burn)}<small> $PUMP</small></p></div>
      </div>
      <div className="vault">
        <Vault reward={pots.reward} burn={pots.burn} floor={rules.potFloor} pulse={stats.paidCallouts} />
        <div className="drops" aria-hidden="true">
          <AnimatePresence>
            {drops.map((d) => (
              <motion.span key={d.id} style={{ left: `${d.x}%` }} initial={{ y: -20, opacity: 0, scale: 0.7 }} animate={{ y: 118, opacity: 1, scale: 1, rotate: [0, -4, 4, 0] }} exit={{ opacity: 0, y: 140, scale: 0.6 }} transition={{ duration: 3.4, ease: 'easeOut' }}>
                <Chute />{d.text}
              </motion.span>
            ))}
          </AnimatePresence>
        </div>
      </div>
      <dl className="stats">
        <div><dt>Paid to holders</dt><dd>{compact(stats.paidOut)} <small>$PUMP</small></dd></div>
        <div><dt>Callouts rewarded</dt><dd>{fmt(stats.paidCallouts)}</dd></div>
        <div><dt>{data.coin.burnMode === 'direct' ? '$PUMP burned' : `$${data.coin.symbol} burned`}</dt><dd className="ember">{compact(data.coin.burnMode === 'direct' ? stats.burnedPump : stats.burnedCoin)}</dd></div>
        <div><dt>In the queue</dt><dd>{fmt(stats.queue)}</dd></div>
      </dl>
    </section>
  );
}

const Chute = () => (
  <svg width="22" height="24" viewBox="0 0 22 24" aria-hidden="true"><path d="M1 10a10 9 0 0 1 20 0Z" fill="#82e28d" /><path d="M8 10a3 9 0 0 1 6 0Z" fill="#f4fff5" /><path d="M1 10l10 12L21 10M8 10l3 12 3-12" stroke="#a1a1aa" strokeWidth=".8" fill="none" /></svg>
);

// ---------------------------------------------------------------- live feed

function Live({ data }: { data: Snapshot }) {
  const now = useNow();
  const hold = data.rules.holdMinutes * 60_000;
  const n = (s: string) => data.feed.filter((c) => c.status === s).length;
  return (
    <section className="wrap section" id="live">
      <Head art="shout" title="Callouts, as they land" text="We read new callouts on the coin straight from pump.fun, confirm the caller holds it on-chain, then start the clock." />
      <div className="live">
        <ol className="feed" aria-label="Latest callouts">
          <AnimatePresence initial={false}>
            {data.feed.slice(0, 9).map((c) => <FeedRow key={c.id} c={c} now={now} hold={hold} demo={data.mode === 'demo'} />)}
          </AnimatePresence>
          {data.feed.length === 0 && <li className="empty">{data.mode === 'prelaunch' ? 'Callouts appear here from the moment the coin launches.' : 'No callouts yet. The first one will show up here within seconds.'}</li>}
        </ol>
        <ol className="path" aria-label="What happens to a callout">
          <li><b>Spotted</b><p>Holder check on-chain, the moment it appears.</p></li>
          <li><b>Holding{n('maturing') > 0 && <span className="chip">{n('maturing')} now</span>}</b><p>{data.mode === 'demo' ? 'Ten minutes live, sped up here.' : `${data.rules.holdMinutes} minutes without selling.`} Your lowest balance is the one that counts.</p></li>
          <li><b>In line{data.stats.queue > 0 && <span className="chip">{data.stats.queue} now</span>}</b><p>Paid oldest first. If the pot is dry you keep your place, and waiting adds weight.</p></li>
          <li><b>Paid</b><p>$PUMP arrives in your wallet. The matching slice goes to the furnace.</p></li>
        </ol>
      </div>
    </section>
  );
}

function FeedRow({ c, now, hold, demo }: { c: PublicCallout; now: number; hold: number; demo: boolean }) {
  const left = c.seenAt + hold - now;
  return (
    <motion.li layout initial={{ opacity: 0, y: -24, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0 }} transition={{ type: 'spring', stiffness: 260, damping: 26 }} className={`call is-${c.status}`}>
      <Avatar c={c} />
      <div className="call-main">
        <p className="call-who"><b>{name(c)}</b><span>{pct(c.holdPct)} held</span>{c.followers !== null && <span>{compact(c.followers)} followers</span>}<span className="dim">{ago(now - c.createdAt)}</span></p>
        {c.thesis && <p className="call-text">{c.thesis}</p>}
      </div>
      <div className="call-end">
        {c.status === 'paid' && (<><b className="green">+{compact(c.amount ?? 0)}</b>{c.sig && !demo ? <a href={`https://solscan.io/tx/${c.sig}`} target="_blank" rel="noreferrer">receipt</a> : <small>$PUMP</small>}</>)}
        {c.status === 'maturing' && (<><b className="ring" style={{ ['--p' as string]: `${Math.min(100, Math.max(0, (1 - left / hold) * 100))}%` }}>{left > 0 ? clock(left) : '…'}</b><small>~{compact(c.estimate ?? 0)}</small></>)}
        {(c.status === 'ready' || c.status === 'sending') && (<><b>{c.status === 'sending' ? 'Sending' : 'In line'}</b><small>~{compact(c.estimate ?? c.amount ?? 0)}</small></>)}
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
    <section className="band" id="queue">
      <div className="wrap section">
        <Head flip art="queue" title={data.queue.length ? `${data.queue.length} in line` : 'Nobody is waiting'} text="When the wallet runs dry, matured callouts take a ticket. The next fees pay the oldest ticket first, and every hour in line adds weight to yours." />
        {data.queue.length ? (
          <ol className="tickets">
            <AnimatePresence initial={false}>
              {data.queue.slice(0, 12).map((c, i) => (
                <motion.li layout key={c.id} className={`ticket ${c.payableNow ? 'next' : ''}`} initial={{ opacity: 0, x: 40 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, y: -40, rotate: -4 }} transition={{ type: 'spring', stiffness: 220, damping: 24 }}>
                  <span className="ticket-n">{i + 1}</span>
                  <div className="ticket-who"><Avatar c={c} size={34} /><b>{name(c)}</b></div>
                  <dl><div><dt>Estimate</dt><dd>{compact(c.estimate ?? 0)}</dd></div><div><dt>Waited</dt><dd>{ago(now - (c.readyAt ?? now))}</dd></div><div><dt>Weight</dt><dd>{Math.min(rules.agingCap, 1 + ((now - (c.readyAt ?? now)) / 3_600_000) * rules.agingPerHour).toFixed(2)}×</dd></div></dl>
                </motion.li>
              ))}
            </AnimatePresence>
          </ol>
        ) : (
          <p className="empty">{data.mode === 'prelaunch' ? 'The line opens with the coin.' : pots.reward >= rules.potFloor ? `The pot holds ${compact(pots.reward)} $PUMP, so matured callouts are paid straight away.` : `The pot is below its ${compact(rules.potFloor)} $PUMP floor. New callouts will line up here until fees arrive.`}</p>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- furnace

function Furnace({ data }: { data: Snapshot }) {
  const now = useNow(5000);
  const direct = data.coin.burnMode === 'direct';
  const coin = useEased(direct ? data.stats.burnedPump : data.stats.burnedCoin);
  return (
    <section className="furnace" id="furnace">
      <div className="wrap furnace-in">
        <div>
          <h2>Every callout feeds the furnace</h2>
          <p className="lede">{direct
            ? 'For each 80 $PUMP a holder receives, 20 $PUMP is burned.'
            : `For each 80 $PUMP a holder receives, 20 $PUMP buys $${data.coin.symbol} off the market and burns it.`}</p>
          <p className="furnace-num"><b>{fmt(coin)}</b> {direct ? '$PUMP' : `$${data.coin.symbol}`} gone for good</p>
          <ul className="burns">
            {data.burns.slice(0, 4).map((b) => (
              <li key={b.id}><span>{ago(now - b.at)} ago</span><b>{compact(direct ? b.pump : b.coin ?? 0)} burned</b>
                {data.mode !== 'demo' && b.sig ? <a href={`https://solscan.io/tx/${b.sig}`} target="_blank" rel="noreferrer">receipt</a> : <span>{compact(b.pump)} $PUMP in</span>}</li>
            ))}
            {data.burns.length === 0 && <li>The furnace lights with the first rewarded callout.</li>}
          </ul>
          {data.pots.due > 0 && <p className="dim">{compact(data.pots.due)} $PUMP is loaded for the next burn.</p>}
        </div>
        <img src="/art/burn.webp" alt="The pill character shovelling pills into a furnace" loading="lazy" />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- leaderboard

function Board({ data }: { data: Snapshot }) {
  const top = data.board[0]?.total ?? 1;
  return (
    <section className="wrap section" id="board">
      <Head art="trophy" title="Loudest holders" text="Total $PUMP earned from callouts, all time." />
      {data.board.length ? (
        <ol className="board">
          {data.board.map((b, i) => (
            <li key={b.wallet} style={{ ['--w' as string]: `${Math.max(3, (b.total / top) * 100)}%` }}>
              <span className="board-n">{i + 1}</span><Avatar c={b} size={36} />
              <span className="board-who"><b>{name(b)}</b><small>{b.n} {b.n === 1 ? 'callout' : 'callouts'}</small></span>
              <b className="mono">{compact(b.total)}</b>
            </li>
          ))}
        </ol>
      ) : <p className="empty">The board fills as the first rewards land.</p>}
    </section>
  );
}

// ---------------------------------------------------------------- rules

function Rules({ data }: { data: Snapshot }) {
  const r = data.rules;
  const demo = data.mode === 'demo';
  const list: [string, string][] = [
    ['Hold', `At least ${r.minHoldBps / 100}% of supply, checked on-chain when you call out and again right before you are paid.`],
    ['Keep holding', `${demo ? 10 : r.holdMinutes} minutes. We pay on the lowest balance we see in that time.`],
    ['Have a following', `${r.minFollowers} pump.fun followers or more.${r.minAccountAgeDays ? ` The account must be at least ${r.minAccountAgeDays} days old.` : ' New accounts are welcome.'}`],
    ['Keep calling', `Earn again every ${demo ? 10 : r.cooldownMinutes} minutes, one callout at a time. Anything sooner counts as spam and earns nothing.`],
    ['Keep it up', 'Deleting the callout before payout gives up the reward.'],
  ];
  return (
    <section className="band" id="rules">
      <div className="wrap section rules">
        <div className="rules-sum">
          <h2>The sum</h2>
          <p className="formula"><span>pot</span> × <span>{r.maxPotShareBps / 100}%</span> × (<span>{Math.round(r.baseScore * 100)}%</span> + <span>{Math.round(r.bagWeight * 100)}%</span> × <span>bag</span> × <span>streak</span> + <span>{Math.round((1 - r.baseScore - r.bagWeight) * 100)}%</span> × <span>reach</span>)</p>
          <ul>
            <li>Every callout that qualifies starts at <b>{Math.round(r.baseScore * 100)}%</b> of the maximum, so a small bag still earns. Your bag adds up to {Math.round(r.bagWeight * 100)}% and your followers up to {Math.round((1 - r.baseScore - r.bagWeight) * 100)}%, each on its own.</li>
            <li><b>bag</b> climbs to full at {r.holdFullBps / 100}% of supply.</li>
            <li><b>streak</b> rewards holding. Each paid callout in a row where you kept at least the same bag grows the bag part {Math.round(r.holdStreakRate * 100)}%, compounding, up to {r.holdStreakCap}×. Sell below your last callout and it starts over.</li>
            <li><b>reach</b> is your pump.fun followers. It climbs from {r.minFollowers} to full at {compact(r.followersFull)}, on a log curve, so going from 100 to 1K counts as much as 1K to 10K.</li>
            <li><b>pot</b> is the reward pool at the moment you are paid. Double the pool and every reward doubles; as it drains, rewards shrink with it. No callout can take more than {r.maxPotShareBps / 100}% of it before queue weight, or {(r.maxPotShareBps * r.agingCap) / 100}% after.</li>
            <li>Anything under {compact(r.minPayout)} $PUMP waits for a bigger pot instead of being sent as dust.</li>
          </ul>
          <img src="/art/drop.webp" alt="" loading="lazy" />
        </div>
        <dl className="rules-list">{list.map(([t, d]) => <div key={t}><dt>{t}</dt><dd>{d}</dd></div>)}</dl>
      </div>
    </section>
  );
}

function Footer({ data }: { data: Snapshot | null }) {
  return (
    <footer className="foot">
      <picture>
        <source media="(max-width: 799px)" srcSet="/art/crowd-sm.webp" />
        <img src="/art/crowd.webp" alt="" loading="lazy" />
      </picture>
      <div className="wrap foot-in">
        <h2>{data?.mode === 'prelaunch' ? 'The pot opens soon' : 'The pot is open'}</h2>
        <div className="foot-cta">
          <a className="btn btn-big" href={coinUrl(data)} target="_blank" rel="noreferrer">Make a callout</a>
          {data?.coin.xUrl && <a className="btn btn-big btn-quiet" href={data.coin.xUrl} target="_blank" rel="noreferrer"><XLogo /> Follow {xHandle(data.coin.xUrl)}</a>}
        </div>
      </div>
      <div className="wrap foot-legal">
        <p>Data from <a href="https://pump.fun" target="_blank" rel="noreferrer">pump.fun</a>. Unofficial fan project. Not made by, affiliated with or endorsed by pump.fun. Character art is fan art.</p>
        <p>Rewards depend on trading fees, can be zero, and are not guaranteed. Estimates move with the pot. Memecoins can go to zero; nothing here is financial advice.</p>
      </div>
    </footer>
  );
}
