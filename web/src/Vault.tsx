// The capsule. Left 80% is the reward pot, right 20% is the burn pot, both drawn against one scale,
// so equal levels mean the 80:20 ratio is holding.
import { useEffect, useRef } from 'react';

const nice = (v: number): number => {
  const need = Math.max(v * 1.25, 10_000);
  const p = 10 ** Math.floor(Math.log10(need));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((x) => x >= need) ?? 10 * p;
};

export function Vault({ reward, burn, floor, pulse }: { reward: number; burn: number; floor: number; pulse: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const live = useRef({ reward, burn, floor, kick: 0 });
  live.current.reward = reward;
  live.current.burn = burn;
  live.current.floor = floor;
  useEffect(() => { live.current.kick = 1; }, [pulse]);

  useEffect(() => {
    const cv = ref.current!;
    const ctx = cv.getContext('2d')!;
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    let visible = true;
    const s = { a: 0, b: 0, scale: 0 };
    const bubbles = Array.from({ length: 34 }, (_, i) => ({ x: Math.random(), y: Math.random(), r: 1 + Math.random() * 4, v: 0.02 + Math.random() * 0.06, hot: i % 5 === 0 }));
    const size = () => {
      const d = Math.min(2, devicePixelRatio || 1);
      cv.width = cv.clientWidth * d;
      cv.height = cv.clientHeight * d;
      ctx.setTransform(d, 0, 0, d, 0, 0);
    };
    const ro = new ResizeObserver(() => { size(); if (still) draw(0); });
    ro.observe(cv);
    const io = new IntersectionObserver(([e]) => { visible = !!e?.isIntersecting; if (visible && !still) { cancelAnimationFrame(raf); raf = requestAnimationFrame(draw); } });
    io.observe(cv);

    function liquid(x0: number, x1: number, top: number, h: number, level: number, t: number, colors: [string, string, string], amp: number) {
      const y = top + h * (1 - level);
      for (let layer = 0; layer < 2; layer++) {
        ctx.beginPath();
        ctx.moveTo(x0, top + h);
        for (let x = x0; x <= x1; x += 4) {
          const w = Math.sin(x * 0.018 + t * (1.1 + layer * 0.5) + layer * 2) * amp + Math.sin(x * 0.041 - t * 1.7) * amp * 0.45;
          ctx.lineTo(x, y + w + layer * 5);
        }
        ctx.lineTo(x1, top + h);
        ctx.closePath();
        if (layer === 0) { ctx.globalAlpha = 0.45; ctx.fillStyle = colors[0]; }
        else {
          ctx.globalAlpha = 1;
          const g = ctx.createLinearGradient(0, y, 0, top + h);
          g.addColorStop(0, colors[0]);
          g.addColorStop(0.5, colors[1]);
          g.addColorStop(1, colors[2]);
          ctx.fillStyle = g;
        }
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      return y;
    }

    function draw(ms: number) {
      const t = ms / 1000;
      const W = cv.clientWidth;
      const H = cv.clientHeight;
      const L = live.current;
      const scale = nice(Math.max(L.reward, L.burn * 4));
      if (!s.scale || still) Object.assign(s, { scale, a: L.reward, b: L.burn });
      s.scale += (scale - s.scale) * 0.06;
      s.a += (L.reward - s.a) * 0.06;
      s.b += (L.burn - s.b) * 0.06;
      L.kick *= 0.965;
      const la = Math.min(0.96, s.a / s.scale);
      const lb = Math.min(0.96, (s.b * 4) / s.scale);
      const amp = (3.5 + L.kick * 7) * Math.min(1, H / 200);
      const split = W * 0.8;

      ctx.clearRect(0, 0, W, H);
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(1.5, 1.5, W - 3, H - 3, (H - 3) / 2);
      ctx.clip();
      const bg = ctx.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, '#1b1d20');
      bg.addColorStop(1, '#101113');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);

      const ya = liquid(0, split, 0, H, la, t, ['#a3eaab', '#4fcf72', '#12803a'], amp);
      const yb = liquid(split, W, 0, H, lb, t + 3, ['#ffd08a', '#fb923c', '#b4400c'], amp * 0.8);

      for (const b of bubbles) {
        if (!still) { b.y -= b.v * 0.02; if (b.y < 0) { b.y = 1; b.x = Math.random(); } }
        const x = b.hot ? split + b.x * (W - split) : b.x * split;
        const top = b.hot ? yb : ya;
        const y = top + 10 + b.y * (H - top - 10);
        ctx.beginPath();
        ctx.arc(x + Math.sin(t + b.x * 9) * 3, y, b.r, 0, 7);
        ctx.fillStyle = b.hot ? 'rgba(255,236,200,.5)' : 'rgba(240,255,242,.38)';
        ctx.fill();
      }

      // Scale marks, drawn where the rounded end no longer clips them.
      ctx.font = '500 11px "Geist Mono Variable", monospace';
      ctx.textBaseline = 'middle';
      for (const q of [0.25, 0.5, 0.75]) {
        const y = H * (1 - q);
        ctx.fillStyle = q <= la ? 'rgba(5,46,22,.7)' : 'rgba(235,235,235,.42)';
        ctx.fillRect(split - 18, y - 0.5, 14, 1);
        ctx.textAlign = 'right';
        ctx.fillText(Intl.NumberFormat('en-US', { notation: 'compact' }).format(scale * q), split - 24, y);
      }
      const fl = L.floor / s.scale;
      if (fl > 0.02 && fl < 0.95) {
        ctx.setLineDash([3, 5]);
        ctx.strokeStyle = 'rgba(235,235,235,.5)';
        ctx.beginPath();
        ctx.moveTo(H * 0.3, H * (1 - fl));
        ctx.lineTo(split - 70, H * (1 - fl));
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Seam and glass.
      ctx.fillStyle = '#0e0f11';
      ctx.fillRect(split - 3, 0, 6, H);
      ctx.fillStyle = 'rgba(255,255,255,.14)';
      ctx.fillRect(split - 3, 0, 1, H);
      const gl = ctx.createLinearGradient(0, 0, 0, H * 0.42);
      gl.addColorStop(0, 'rgba(255,255,255,.26)');
      gl.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = gl;
      ctx.beginPath();
      ctx.roundRect(H * 0.22, H * 0.07, W - H * 0.44, H * 0.26, H * 0.13);
      ctx.fill();
      const sh = ctx.createLinearGradient(0, H * 0.6, 0, H);
      sh.addColorStop(0, 'rgba(0,0,0,0)');
      sh.addColorStop(1, 'rgba(0,0,0,.35)');
      ctx.fillStyle = sh;
      ctx.fillRect(0, H * 0.6, W, H * 0.4);
      ctx.restore();

      ctx.beginPath();
      ctx.roundRect(1.5, 1.5, W - 3, H - 3, (H - 3) / 2);
      ctx.strokeStyle = 'rgba(255,255,255,.16)';
      ctx.lineWidth = 2;
      ctx.stroke();
      if (!still && visible) raf = requestAnimationFrame(draw);
    }
    size();
    raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); io.disconnect(); };
  }, []);

  return <canvas ref={ref} className="vault-canvas" role="img" aria-label={`Reward pot ${Math.round(reward).toLocaleString()} PUMP, burn pot ${Math.round(burn).toLocaleString()} PUMP`} />;
}
