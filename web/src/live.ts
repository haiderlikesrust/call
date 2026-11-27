import { useEffect, useRef, useState } from 'react';
import type { PublicCallout, Snapshot } from '../../server/view.ts';
import type { LaunchpadCoin, LaunchpadList, LaunchpadView, ListedCoin } from '../../server/launchpad/index.ts';

export type { LaunchpadCoin, LaunchpadList, LaunchpadView, ListedCoin, PublicCallout, Snapshot };
export type CoinList = LaunchpadList & { build: string };

/** GETs JSON now and every `ms`; `null` until the first answer. Keeps the last good answer through a hiccup. */
export function usePoll<T>(url: string, ms: number): { data: T | null; error: string | null; status: number } {
  const [s, set] = useState<{ data: T | null; error: string | null; status: number }>({ data: null, error: null, status: 0 });
  useEffect(() => {
    let live = true;
    let t: ReturnType<typeof setTimeout>;
    set({ data: null, error: null, status: 0 });
    const tick = async () => {
      try {
        const r = await fetch(url, { cache: 'no-store' });
        const body = await r.json().catch(() => null);
        if (live) set((p) => (r.ok ? { data: body, error: null, status: r.status } : { data: p.data, error: body?.error ?? 'Could not load this right now.', status: r.status }));
      } catch {
        if (live) set((p) => ({ ...p, error: p.data ? null : 'The server is not answering. Retrying…' }));
      }
      if (live) t = setTimeout(tick, document.visibilityState === 'hidden' ? ms * 4 : ms);
    };
    void tick();
    return () => { live = false; clearTimeout(t); };
  }, [url, ms]);
  return s;
}

/** True once the server has been answering with a different build for a while: time to reload. */
export function useStale(build: string | undefined): boolean {
  const first = useRef('');
  const since = useRef(0);
  const [stale, setStale] = useState(false);
  useEffect(() => {
    if (!build) return;
    first.current ||= build;
    // During an update both versions answer for a moment, so only believe a build that sticks.
    if (build === first.current) { since.current = 0; return; }
    if (!since.current) since.current = Date.now();
    else if (Date.now() - since.current > 10_000) {
      if (document.visibilityState === 'hidden') location.reload();
      setStale(true);
    }
  }, [build]);
  return stale;
}

export function useNow(ms = 1000): number {
  const [now, set] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => set(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Eases a number toward its target so totals tick instead of jumping. */
export function useEased(target: number): number {
  const [v, set] = useState(target);
  const cur = useRef(target);
  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { cur.current = target; set(target); return; }
    // Time-based with a hard stop, so a throttled tab can never be left showing a stale figure.
    const from = cur.current;
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, Math.max(0, (t - t0) / 700));
      cur.current = k === 1 ? target : from + (target - from) * (1 - (1 - k) ** 3);
      set(cur.current);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    const stop = setTimeout(() => { cancelAnimationFrame(raf); cur.current = target; set(target); }, 800);
    return () => { cancelAnimationFrame(raf); clearTimeout(stop); };
  }, [target]);
  return v;
}

export const fmt = (n: number, d = 0): string => n.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: 0 });
export const compact = (n: number): string =>
  n >= 1000 ? n.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: n >= 100_000 ? 1 : 2 }) : fmt(n, n < 10 ? 2 : 0);
/** Dollars: cents below $100, whole dollars to $10K, compact above. */
export const usd = (n: number): string =>
  n >= 10_000 ? `$${n.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 })}`
    : `$${n.toLocaleString('en-US', { minimumFractionDigits: n < 100 && n > 0 ? 2 : 0, maximumFractionDigits: n < 100 ? 2 : 0 })}`;
export const sol = (n: number): string => `${n.toLocaleString('en-US', { maximumFractionDigits: n < 1 ? 3 : n < 100 ? 2 : 0 })} SOL`;
export const short = (w: string): string => `${w.slice(0, 4)}…${w.slice(-4)}`;
export const pct = (n: number): string => `${n >= 0.1 ? n.toFixed(2) : n.toFixed(3)}%`;
/** Split percentages for display: whole numbers when they are, one decimal otherwise. */
export const share = (n: number): string => `${Math.abs(n - Math.round(n)) < 0.05 ? Math.round(n) : n.toFixed(1)}%`;
export function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
export const clock = (ms: number): string => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
/** A stable hue for an address, so every coin and caller without an image still has its own colour. */
export function hue(s: string): number {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}
