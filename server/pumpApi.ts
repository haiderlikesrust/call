// Client for https://api.pump.fun/v1. Server-side only: pump.fun revokes keys seen in browsers.
import { config } from './config.ts';

export interface Row {
  calloutId: string; wallet: string; userId: string; username: string; avatar: string | null;
  thesis: string; likes: number; followers: number; accountCreatedAt: number | null; createdAt: number;
  isDev: boolean; isGroup: boolean; isPumpUser: boolean; lowQuality: boolean;
}
export interface Source {
  /** Newest callouts first, each already tied to an open position in the coin. */
  page(n: number): Promise<{ rows: Row[]; hasMore: boolean }>;
  exists(calloutId: string): Promise<boolean>;
  followers(wallet: string): Promise<number | null>;
  readonly health: { ok: boolean; note: string; remaining: number | null };
}

const when = (v: unknown): number => {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string' || !v) return 0;
  const n = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
  return Number.isFinite(n) ? n : 0;
};
const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
const https = (v: unknown): string | null => (typeof v === 'string' && v.startsWith('https://') ? v : null);
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/* eslint-disable @typescript-eslint/no-explicit-any */
export function parseRow(p: any, coinMint: string): Row | null {
  const c = p?.callout;
  if (!c?.calloutId || p.coinMint !== coinMint || !BASE58.test(p.walletAddress ?? '')) return null;
  const createdAt = when(c.calloutTimestamp);
  if (!createdAt) return null;
  return {
    calloutId: String(c.calloutId), wallet: p.walletAddress, userId: String(p.userId || p.walletAddress),
    username: text(p.userName, 40), avatar: https(p.profileImage), thesis: text(c.thesis, 280), likes: Number(c.likes) || 0,
    followers: Number(p.profile?.followerCount) || 0, accountCreatedAt: when(p.profile?.createdAt) || null, createdAt,
    isDev: c.authorIsDev === true, isGroup: p.accountKind === 'group',
    isPumpUser: !!p.userId && p.profile?.isPumpUser !== false, lowQuality: p.lowQuality === true,
  };
}

export class PumpApi implements Source {
  health = { ok: true, note: 'starting', remaining: null as number | null };
  private blockedUntil = 0;

  private async get(path: string): Promise<{ status: number; body: any }> {
    const wait = this.blockedUntil - Date.now();
    if (wait > 0) throw new Error(`rate limited for ${Math.ceil(wait / 1000)}s`);
    const res = await fetch(config.pumpApiBase + path, {
      headers: { authorization: `Bearer ${config.pumpApiKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (remaining !== null) this.health.remaining = Number(remaining);
    if (res.status === 429 || res.status === 503) {
      const s = Number(res.headers.get('retry-after')) || 5;
      this.blockedUntil = Date.now() + s * 1000;
      this.health = { ...this.health, ok: false, note: `pump.fun asked us to wait ${s}s` };
      throw new Error(this.health.note);
    }
    const body = await res.json().catch(() => null);
    if (!res.ok && res.status !== 404) {
      const note = `pump.fun ${res.status} ${body?.error ?? ''}`.trim();
      this.health = { ...this.health, ok: false, note };
      // Bad or revoked key: back off a full minute rather than hammering the failed-auth throttle.
      if (res.status === 401 || res.status === 403) this.blockedUntil = Date.now() + 60_000;
      throw new Error(note);
    }
    this.health = { ...this.health, ok: true, note: 'live' };
    return { status: res.status, body };
  }

  async page(n: number) {
    const q = new URLSearchParams({ sortBy: 'LATEST', withThesis: 'true', includeProfile: 'true', updatesLimit: '0', pageSize: '50', page: String(n) });
    const { status, body } = await this.get(`/mint-positions/${config.coinMint}?${q}`);
    if (status === 404) return { rows: [], hasMore: false };
    const rows = (body?.positions ?? []).map((p: any) => parseRow(p, config.coinMint)).filter((r: Row | null): r is Row => r !== null);
    return { rows, hasMore: body?.hasMore === true };
  }
  async exists(calloutId: string) {
    const { status, body } = await this.get(`/callout/${encodeURIComponent(calloutId)}`);
    return status !== 404 && !!body?.callout;
  }
  async followers(wallet: string) {
    const { status, body } = await this.get(`/users/${wallet}`);
    return status === 404 ? null : Number(body?.followers) || 0;
  }
}
