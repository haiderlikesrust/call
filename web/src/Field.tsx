// "What would mine pay?" A field of pills: sideways is reach, up is bag size, and each pill's
// size is the score at that point. Same functions the payout engine runs.
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { rewardFor, score, streakBoost, toUnits } from '../../server/rewards.ts';
import { compact, fmt, pct, short, useEased, type Snapshot } from './live.ts';

const SUPPLY = 10n ** 15n;
const X0 = 10;
// Pool sizes the slider spans, in $PUMP.
const P0 = 5_000;
const P1 = 20_000_000;
const bag = (p: number) => BigInt(Math.round((p / 100) * Number(SUPPLY)));

export function Field({ data }: { data: Snapshot }) {
  const { rules, pots } = data;
  const X1 = rules.followersFull;
  const Y1 = rules.holdFullBps / 100;
  const Y0 = rules.minHoldBps / 100;
  const [x, setX] = useState(0.55); // 0..1 along followers (log)
  const [y, setY] = useState(0.62); // 0..1 along holding (log)
  const followers = Math.round(X0 * (X1 / X0) ** x);
  const hold = Y0 * (Y1 / Y0) ** y;
  const [streak, setStreak] = useState(0);
  const s = score(bag(hold), SUPPLY, followers, rules, streak);
  const [z, setZ] = useState<number | null>(data.mode === 'prelaunch' ? 0.65 : null); // null follows the live pool
  const pool = z === null ? pots.reward : P0 * (P1 / P0) ** z;
  const zLive = Math.min(1, Math.max(0, Math.log(Math.max(P0, pots.reward) / P0) / Math.log(P1 / P0)));
  const est = Number(rewardFor(toUnits(pool), s, 1, rules)) / 1e6;
  const waits = pool < rules.potFloor || est < rules.minPayout;
  const shown = useEased(est);
  const cv = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const c = cv.current!;
    const ctx = c.getContext('2d')!;
    const draw = () => {
      const d = Math.min(2, devicePixelRatio || 1);
      const W = c.clientWidth;
      const H = c.clientHeight;
      c.width = W * d;
      c.height = H * d;
      ctx.setTransform(d, 0, 0, d, 0, 0);
      const nx = Math.max(14, Math.floor(W / 30));
      const ny = Math.max(8, Math.floor(H / 28));
      for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
        const u = (i + 0.5) / nx;
        const v = 1 - (j + 0.5) / ny;
        const k = score(bag(Y0 * (Y1 / Y0) ** v), SUPPLY, X0 * (X1 / X0) ** u, rules, streak);
        const near = Math.max(0, 1 - Math.hypot((u - x) * (W / H), v - y) / 0.22);
        const w = 7 + k * 19 + near * 4;
        const h = w * 0.52;
        ctx.save();
        ctx.translate(u * W, (1 - v) * H);
        ctx.rotate(-0.7);
        ctx.globalAlpha = 0.24 + k * 0.76;
        ctx.beginPath();
        ctx.roundRect(-w / 2, -h / 2, w, h, h / 2);
        ctx.fillStyle = '#4fcf72';
        ctx.fill();
        ctx.beginPath();
        ctx.roundRect(0, -h / 2, w / 2, h, [0, h / 2, h / 2, 0]);
        ctx.fillStyle = '#f4fff5';
        ctx.fill();
        ctx.restore();
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(c);
    return () => ro.disconnect();
  }, [x, y, X1, Y1, rules]);

  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (e.type === 'pointermove' && !(e.buttons & 1)) return;
    const r = e.currentTarget.getBoundingClientRect();
    setX(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
    setY(Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height)));
  };

  return (
    <div className="field">
      <div className="field-plot">
        <div className="field-pad" onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); move(e); }} onPointerMove={move}>
          <canvas ref={cv} aria-hidden="true" />
          <span className="field-puck" style={{ left: `${x * 100}%`, bottom: `${y * 100}%` }} aria-hidden="true" />
        </div>
        <div className="field-ax field-ax-y" aria-hidden="true"><span>{Y1}% of supply</span><span>{Y0}%</span></div>
        <div className="field-ax field-ax-x" aria-hidden="true"><span>{X0} followers</span><span>1K</span><span>{compact(X1)}</span></div>
      </div>
      <div className="field-out">
        <p className="label">One callout pays about</p>
        <p className="field-num"><b>{fmt(shown, shown < 100 ? 1 : 0)}</b> $PUMP</p>
        <p className="dim">{pct((est / Math.max(1, pool)) * 100)} of the pool, plus {fmt(est / (rules.rewardBps / (10_000 - rules.rewardBps)), est < 400 ? 1 : 0)} $PUMP sent to the furnace.{waits && <b className="ember"> Too small to send at this pool size, so it would wait in line.</b>}</p>
        <label className="slide"><span>You hold <b>{pct(hold)}</b> <i>{compact(hold * 1e7)} tokens</i></span>
          <input id="hold" type="range" min="0" max="1" step="0.005" value={y} onChange={(e) => setY(+e.target.value)} /></label>
        <label className="slide"><span>You have <b>{fmt(followers)}</b> pump.fun followers</span>
          <input id="followers" type="range" min="0" max="1" step="0.005" value={x} onChange={(e) => setX(+e.target.value)} /></label>
        <label className="slide"><span>Held through <b>{streak}</b> {streak === 1 ? 'callout' : 'callouts'} in a row <i>bag ×{streakBoost(streak, rules).toFixed(2)}</i></span>
          <input id="streak" type="range" min="0" max={Math.ceil(Math.log(rules.holdStreakCap) / Math.log(1 + rules.holdStreakRate))} step="1" value={streak} onChange={(e) => setStreak(+e.target.value)} /></label>
        <label className="slide"><span>Reward pool <b>{compact(pool)}</b> <i>$PUMP{z === null ? ', live' : data.mode === 'prelaunch' ? ', example' : ''}</i></span>
          <input id="pool" type="range" min="0" max="1" step="0.005" value={z ?? zLive} onChange={(e) => setZ(+e.target.value)} /></label>
        {z !== null && data.mode !== 'prelaunch' && <button type="button" className="btn btn-quiet reset" onClick={() => setZ(null)}>Back to the live pool</button>}
        {data.mode !== 'prelaunch' && <Lookup symbol={data.coin.symbol} />}
      </div>
    </div>
  );
}

interface Found { wallet: string; followers: number | null; holdPct: number; estimate: number; holds: boolean; reach: boolean; streak?: number }

function Lookup({ symbol }: { symbol: string }) {
  const [addr, setAddr] = useState('');
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<Found | null>(null);
  const [err, setErr] = useState('');
  const go = async () => {
    const a = addr.trim();
    setFound(null);
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) return setErr('That is not a Solana wallet address.');
    setErr('');
    setBusy(true);
    try {
      const r = await fetch(`/api/wallet/${a}`);
      const b = await r.json();
      if (r.ok) setFound(b); else setErr(b.error);
    } catch { setErr('Could not reach the server. Try again.'); }
    setBusy(false);
  };
  return (
    <form className="lookup" onSubmit={(e) => { e.preventDefault(); void go(); }}>
      <label htmlFor="wallet" className="label">Or check a wallet</label>
      <div className="lookup-row">
        <input id="wallet" value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="Solana address" spellCheck={false} autoComplete="off" />
        <button className="btn btn-quiet" disabled={busy}>{busy ? 'Checking' : 'Check'}</button>
      </div>
      <div aria-live="polite">
        {err && <p className="bad">{err}</p>}
        {found && (
          <p className={found.holds && found.reach ? 'good' : 'bad'}>
            {!found.holds ? `${short(found.wallet)} does not hold enough $${symbol} yet.`
              : !found.reach ? `${short(found.wallet)} holds ${pct(found.holdPct)} but needs more followers.`
              : `${short(found.wallet)} holds ${pct(found.holdPct)} with ${fmt(found.followers ?? 0)} pump.fun followers${found.streak ? ` and a ${found.streak}-callout holding streak` : ''}: about ${fmt(found.estimate)} $PUMP per callout.`}
          </p>
        )}
      </div>
    </form>
  );
}
