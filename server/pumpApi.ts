// Where callouts come from.
// - pump.fun's mint-positions feed is the main source: every current holder's callout on the coin, newest first,
//   with everything a reward depends on (dev flag, low quality, account id, squad, followers, account age).
// - gmgn is the backup: it lists every callout on the coin, holders or not, so it catches callouts the feed lacks
//   and sees non-holders the moment they call out. It is skipped whenever it does not answer. Its follower counts
//   are often stale, so a callout only gmgn has is judged on pump.fun's /callout/{id} and account overview.
// Both sites only answer browser-like clients, so requests carry Chrome's TLS fingerprint (impit).
import { Impit } from 'impit';
import { config } from './config.ts';

export interface Row {
  calloutId: string; wallet: string; userId: string; username: string; avatar: string | null;
  thesis: string; likes: number; followers: number; accountCreatedAt: number | null; createdAt: number;
  isDev: boolean; isGroup: boolean; isPumpUser: boolean; lowQuality: boolean;
  /** Set for an update on a callout: `<calloutId>/<updateId>`. Absent for the callout itself. */
  key?: string;
}
/** One callout as gmgn lists it. `calloutId` is pump.fun's own id. */
export interface Listed { calloutId: string; wallet: string; createdAt: number; thesis: string; likes: number; username: string; avatar: string | null; followers: number; key?: string }

/**
 * What one reward is for. pump.fun gives a wallet one callout per coin; calling the coin out again means posting an
 * update on it. Each update is its own event, with its own time and text, and is judged like a new callout (the
 * per-account cooldown and one-in-line rule still apply). `calloutId` stays the parent callout's id.
 */
export const eventKey = (x: { calloutId: string; key?: string }): string => x.key ?? x.calloutId;
/** The callout as pump.fun has it. `userId` is the pump.fun account, shared by all of one person's wallets. */
export interface Detail { calloutId: string; wallet: string; userId: string; isDev: boolean; isGroup: boolean; username: string; avatar: string | null }
export interface Overview { followers: number; isPumpUser: boolean; banned: boolean; isGroup: boolean; username: string; avatar: string | null }
/** What pump.fun says about a callout and its author: everything a reward depends on. */
export type Account = Detail & Pick<Overview, 'followers' | 'isPumpUser' | 'banned'>;

/** A callout from pump.fun's feed. `row` is complete when the feed carried the author's profile. */
export interface Fed { listed: Listed; row: Row | null }

export interface Source {
  /** pump.fun's feed: current holders' callouts and their updates, by callout date, 50 holders a page. Throws when pump.fun does not answer. */
  positions(page: number): Promise<{ items: Fed[]; hasMore: boolean }>;
  /** gmgn: every callout on the coin from the last day, newest first; null while gmgn is not answering. */
  callouts(): Promise<Listed[] | null>;
  /** null: the callout is gone from pump.fun. Throws when pump.fun does not answer; ask again later. */
  account(l: Listed): Promise<Account | null>;
  /** False once the callout is gone from pump.fun. Throws when pump.fun does not answer. */
  exists(calloutId: string): Promise<boolean>;
  /** pump.fun followers; null when unknown. */
  followers(wallet: string): Promise<number | null>;
  /** How often the listing is read. */
  readonly everyMs: number;
  readonly health: { ok: boolean; note: string; remaining: number | null };
}

const DAY = 86_400_000;
const when = (v: unknown): number => {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string' || !v) return 0;
  const n = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
  return Number.isFinite(n) ? n : 0;
};
const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
const https = (v: unknown): string | null => (typeof v === 'string' && v.startsWith('https://') ? v : null);
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* eslint-disable @typescript-eslint/no-explicit-any */
export function parseListed(it: any, coinMint: string): Listed | null {
  const id = typeof it?.callout_id === 'string' ? it.callout_id.replace(/^pumpfun:/, '') : '';
  const wallet = it?.author?.wallet;
  if (!UUID.test(id) || it.platform !== 'pump' || it.token?.address !== coinMint || !BASE58.test(wallet ?? '')) return null;
  const createdAt = when(it.created_at);
  if (!createdAt) return null;
  return {
    calloutId: id, wallet, createdAt, thesis: text(it.content?.text, 280), likes: Number(it.stats?.likes) || 0,
    username: text(it.author.name, 40), avatar: https(it.author.avatar), followers: Number(it.author.followers) || 0,
  };
}
/** One position from pump.fun's `/mint-positions` feed, read with includeProfile=true. */
export function parsePosition(p: any, coinMint: string): Fed | null {
  const c = p?.callout;
  const wallet = p?.walletAddress;
  if (!c || !UUID.test(c.calloutId ?? '') || p.coinMint !== coinMint || !BASE58.test(wallet ?? '')) return null;
  const createdAt = when(c.calloutTimestamp);
  if (!createdAt) return null;
  const pr = p.profile;
  const listed: Listed = {
    calloutId: c.calloutId, wallet, createdAt, thesis: text(c.thesis, 280), likes: Number(c.likes) || 0,
    username: text(p.userName, 40), avatar: https(p.profileImage), followers: Number(pr?.followerCount) || 0,
  };
  // Without the profile the follower count is unknown: leave it to the account lookup rather than guess.
  const row: Row | null = pr ? {
    calloutId: c.calloutId, wallet, userId: UUID.test(p.userId ?? '') ? p.userId : wallet, username: listed.username, avatar: listed.avatar,
    thesis: listed.thesis, likes: listed.likes, followers: Number(pr.followerCount) || 0, accountCreatedAt: when(pr.createdAt) || null, createdAt,
    isDev: c.authorIsDev === true, isGroup: p.accountKind === 'group' || pr.kind === 'group',
    isPumpUser: UUID.test(p.userId ?? '') && pr.isPumpUser !== false, lowQuality: p.lowQuality === true,
  } : null;
  return { listed, row };
}
/**
 * A position's callout and every update on it that the feed carried (read with updatesLimit, newest first). Each is
 * its own event: the update's id, time and text, the author's profile as for the callout.
 */
export function parsePositionEvents(p: any, coinMint: string): Fed[] {
  const base = parsePosition(p, coinMint);
  if (!base) return [];
  const out: Fed[] = [base];
  const updates: any[] = Array.isArray(p.callout?.updates) ? p.callout.updates : [];
  for (const u of updates) {
    const createdAt = when(u?.createdAt);
    if (!UUID.test(u?.id ?? '') || !createdAt || u.parentMessageId) continue;
    const key = `${base.listed.calloutId}/${u.id}`;
    const thesis = text(u.content, 280), likes = Number(u.likeCount) || 0;
    out.push({
      listed: { ...base.listed, key, createdAt, thesis, likes },
      row: base.row ? { ...base.row, key, createdAt, thesis, likes } : null,
    });
  }
  return out;
}
/** pump.fun's `/callout/{id}`. Only trusted when it is the same callout, on this coin, by this wallet. */
export function parseDetail(body: any, l: Listed, coinMint: string): Detail | null {
  const c = body?.callout;
  if (!c || c.calloutId !== l.calloutId || c.coinMint !== coinMint || c.userId !== l.wallet) return null;
  return {
    calloutId: l.calloutId, wallet: l.wallet, userId: UUID.test(c.user_uuid ?? '') ? c.user_uuid : l.wallet,
    isDev: c.authorIsDev === true, isGroup: c.accountKind === 'group', username: text(c.userName, 40), avatar: https(c.profileImage),
  };
}
/** pump.fun's `/users/{wallet}/overview`. */
export function parseOverview(body: any, wallet: string): Overview | null {
  const p = body?.profile;
  if (!p || p.address !== wallet) return null;
  return {
    followers: Number(body.counts?.followers ?? p.followers) || 0,
    isPumpUser: (body.isPumpUser ?? p.is_pump_user) === true, banned: body.banned === true || p.is_banned === true,
    isGroup: p.kind === 'group', username: text(p.username, 40), avatar: https(p.profile_image),
  };
}
/**
 * For a callout only gmgn has. A null account is only ever passed for callouts turned away on the holder list
 * alone (not a holder, too small, excluded, late): gmgn's details are then shown and decide nothing. The account
 * lookups carry no account date, so MIN_ACCOUNT_AGE_DAYS applies to callouts from the holder feed only.
 */
export function toRow(l: Listed, a: Account | null): Row {
  return {
    calloutId: l.calloutId, wallet: l.wallet, userId: a?.userId ?? l.wallet, username: a?.username || l.username, avatar: a ? a.avatar : l.avatar,
    thesis: l.thesis, likes: l.likes, followers: a?.followers ?? l.followers, accountCreatedAt: null, createdAt: l.createdAt,
    isDev: a?.isDev ?? false, isGroup: a?.isGroup ?? false, isPumpUser: a?.isPumpUser ?? true, lowQuality: a?.banned ?? false,
    ...(l.key ? { key: l.key } : {}),
  };
}

/** Spaces calls evenly under a per-minute allowance, and holds them all when a site says to wait. */
export class Lane {
  private next = 0;
  private readonly gap: number;
  constructor(perMinute: number) { this.gap = 60_000 / perMinute; }
  wait(): number { return Math.max(0, this.next - Date.now()); }
  async turn(): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + this.gap;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  }
  hold(ms: number): void { this.next = Math.max(this.next, Date.now() + ms); }
}

const IMPIT = { browser: 'chrome', timeout: 15_000 } as const;
const BROWSER = { accept: 'application/json, text/plain, */*', 'accept-language': 'en-US,en;q=0.9' };
const PUMP = { ...BROWSER, origin: 'https://pump.fun', referer: 'https://pump.fun/' };
const GMGN = { ...BROWSER, referer: 'https://gmgn.ai/' };

export type Lanes = Record<'positions' | 'gmgn' | 'callout' | 'overview', Lane>;
/** pump.fun allows 60 a minute on the feed; the overview states no limit, so it gets a cautious 30. */
export const mainLanes = (): Lanes => ({ positions: new Lane(50), gmgn: new Lane(40), callout: new Lane(50), overview: new Lane(30) });

export interface SourceOpts {
  /** The coin to read. */
  mint: string;
  /** Rate limits, shared by every source handed the same object (the launchpad's coins share one set). */
  lanes?: Lanes;
  /** Read gmgn as a backup. On by default. */
  gmgn?: boolean;
  everyMs?: number;
}

export class LiveSource implements Source {
  health = { ok: true, note: 'starting', remaining: null as number | null };
  readonly everyMs: number;
  readonly mint: string;
  private readonly lanes: Lanes;
  private readonly useGmgn: boolean;
  /** Why gmgn was last skipped, or null while it answers. */
  backup: string | null = null;
  /** One reused connection: a steady browser-like client, not a new handshake per call. */
  private http = new Impit(IMPIT);
  private refused = 0;
  private readonly overviews = new Map<string, { at: number; o: Overview }>();

  constructor(o: SourceOpts) {
    this.mint = o.mint;
    this.lanes = o.lanes ?? mainLanes();
    this.useGmgn = o.gmgn ?? true;
    this.everyMs = o.everyMs ?? 10_000;
  }

  /**
   * Per-callout pump.fun lookups never queue behind a pause it asked for: they fail at once and the caller asks
   * again on its next round, so one slow site cannot stall intake. Feed and gmgn reads wait their turn.
   */
  private async get(lane: keyof Lanes, url: string, headers: Record<string, string>): Promise<{ status: number; body: any }> {
    const l = this.lanes[lane];
    if ((lane === 'callout' || lane === 'overview') && l.wait() > 2_000) throw new Error(`pump.fun ${lane}: pausing ${Math.ceil(l.wait() / 1000)}s`);
    await l.turn();
    const res = await this.http.fetch(url, { headers });
    if (res.headers.get('x-ratelimit-remaining') === '0') l.hold((Number(res.headers.get('x-ratelimit-reset')) || 60) * 1000);
    if (res.status === 429 || res.status === 503) {
      const s = Number(res.headers.get('retry-after')) || Number(res.headers.get('x-ratelimit-reset')) || 5;
      l.hold(s * 1000);
      throw new Error(`${lane}: asked to wait ${s}s`);
    }
    const body = await res.json().catch(() => null);
    if (!res.ok && res.status !== 404) {
      // "Client not allowed" comes now and then, mostly on fresh connections in quick succession. Start a new
      // connection after a pause that grows while it keeps happening (5s, 10s, ... up to a minute).
      if (res.status === 403) {
        this.refused = Math.min(this.refused + 1, 12);
        this.http = new Impit(IMPIT);
        l.hold(this.refused * 5_000);
      }
      throw new Error(`${lane} ${res.status} ${body?.message ?? ''}`.trim());
    }
    this.refused = 0;
    return { status: res.status, body };
  }

  async positions(page: number): Promise<{ items: Fed[]; hasMore: boolean }> {
    try {
      const q = new URLSearchParams({ sortBy: 'LATEST', withThesis: 'true', includeProfile: 'true', updatesLimit: '10', pageSize: '50', page: String(page) });
      const { body } = await this.get('positions', `${config.pumpFrontendBase}/mint-positions/${this.mint}?${q}`, PUMP);
      if (!Array.isArray(body?.positions)) throw new Error('pump.fun feed: unexpected answer');
      const items: Fed[] = body.positions.flatMap((p: any) => parsePositionEvents(p, this.mint));
      this.health = { ...this.health, ok: true, note: this.backup ? `live; gmgn backup off (${this.backup})` : 'live' };
      return { items, hasMore: body.hasMore === true && body.positions.length > 0 };
    } catch (e) {
      this.health = { ...this.health, ok: false, note: e instanceof Error ? e.message : String(e) };
      throw e;
    }
  }

  async callouts() {
    if (!this.useGmgn) return null;
    try {
      const out: Listed[] = [];
      let cursor = '';
      let oldest = Date.now();
      for (let page = 0; page < 10; page++) {
        const q = new URLSearchParams({ from_app: 'gmgn', os: 'web', app_lang: 'en-US', chain: 'sol', token: this.mint, platforms: 'pump', limit: '100' });
        if (cursor) q.set('cursor', cursor);
        const { body } = await this.get('gmgn', `${config.gmgnBase}/vas/api/v1/callout/token?${q}`, GMGN);
        if (body?.code !== 0 || !Array.isArray(body.data?.list)) throw new Error(`gmgn: ${body?.message || 'unexpected answer'}`);
        for (const it of body.data.list) {
          const l = parseListed(it, this.mint);
          if (l) { out.push(l); oldest = Math.min(oldest, l.createdAt); }
        }
        cursor = typeof body.data.next_cursor === 'string' ? body.data.next_cursor : '';
        if (!cursor || body.data.list.length === 0 || Date.now() - oldest > DAY) break;
      }
      if (this.backup) console.log('[gmgn] answering again');
      this.backup = null;
      return out;
    } catch (e) {
      const why = (e instanceof Error ? e.message : String(e)).split(/\r?\n/)[0]!.slice(0, 120);
      if (this.backup === null) console.error('[gmgn] backup off:', why);
      this.backup = why;
      return null;
    }
  }

  private async overview(wallet: string, maxAge: number): Promise<Overview | null> {
    const hit = this.overviews.get(wallet);
    if (hit && Date.now() - hit.at < maxAge) return hit.o;
    const { status, body } = await this.get('overview', `${config.pumpFrontendBase}/users/${wallet}/overview`, PUMP);
    const o = status === 404 ? null : parseOverview(body, wallet);
    if (o) {
      if (this.overviews.size > 5000) this.overviews.clear();
      this.overviews.set(wallet, { at: Date.now(), o });
    }
    return o;
  }

  async account(l: Listed) {
    const { status, body } = await this.get('callout', `${config.pumpFrontendBase}/callout/${l.calloutId}`, PUMP);
    if (status === 404) return null;
    const d = parseDetail(body, l, this.mint);
    if (!d) throw new Error(`pump.fun callout ${l.calloutId.slice(0, 8)}: does not match gmgn`);
    const o = await this.overview(l.wallet, 60_000);
    if (!o) throw new Error(`pump.fun has no overview for ${l.wallet.slice(0, 6)}`);
    return { ...d, followers: o.followers, isPumpUser: o.isPumpUser, banned: o.banned, isGroup: d.isGroup || o.isGroup };
  }
  async exists(calloutId: string) {
    const { status, body } = await this.get('callout', `${config.pumpFrontendBase}/callout/${encodeURIComponent(calloutId)}`, PUMP);
    return status !== 404 && !!body?.callout;
  }
  async followers(wallet: string) {
    if (!BASE58.test(wallet)) return null;
    return (await this.overview(wallet, 300_000))?.followers ?? null;
  }
}
