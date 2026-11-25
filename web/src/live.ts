import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from '../../server/view.ts';
import type { PublicCallout } from '../../server/view.ts';

export type { Snapshot, PublicCallout };

/** Live state over server-sent events. The browser reconnects by itself. */
export function useLive(): { data: Snapshot | null; online: boolean; stale: boolean } {
  const [data, setData] = useState<Snapshot | null>(null);
  const [online, setOnline] = useState(true);
  const [stale, setStale] = useState(false);
  useEffect(() => {
    let first = '';
    let changedAt = 0;
    let lost: ReturnType<typeof setTimeout> | undefined;
    const es = new EventSource('/api/stream');
    es.onmessage = (m) => {
      const s = JSON.parse(m.data) as Snapshot;
      clearTimeout(lost);
      lost = undefined;
      setOnline(true);
      first ||= s.build;
      // During an update both versions answer for a moment, so only believe a build that sticks.
      if (s.build === first) changedAt = 0;
      else if (!changedAt) changedAt = Date.now();
      else if (Date.now() - changedAt > 10_000) {
        if (document.visibilityState === 'hidden') location.reload();
        setStale(true);
      }
      setData(s);
    };
    // An update moves this stream to the new server within a second. Only a longer gap is worth showing.
    es.onerror = () => { lost ??= setTimeout(() => setOnline(false), 5000); };
    return () => { es.close(); clearTimeout(lost); };
  }, []);
  return { data, online, stale };
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
      const k = Math.min(1, Math.max(0, (t - t0) / 600));
      cur.current = k === 1 ? target : from + (target - from) * (1 - (1 - k) ** 3);
      set(cur.current);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    const stop = setTimeout(() => { cancelAnimationFrame(raf); cur.current = target; set(target); }, 700);
    return () => { cancelAnimationFrame(raf); clearTimeout(stop); };
  }, [target]);
  return v;
}

export const fmt = (n: number, d = 0): string => n.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: 0 });
export const compact = (n: number): string =>
  n >= 1000 ? n.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: n >= 100_000 ? 1 : 2 }) : fmt(n, n < 10 ? 2 : 0);
export const short = (w: string): string => `${w.slice(0, 4)}…${w.slice(-4)}`;
export const pct = (n: number): string => `${n >= 1 ? n.toFixed(2) : n >= 0.1 ? n.toFixed(2) : n.toFixed(3)}%`;
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
