// The site, the API and the payout worker, in one process. Everything on the site is the launchpad: the home page
// lists the coins launched here, each coin has its own page, and /launch launches a new one.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { config, mode } from './config.ts';
import { LeaderLock } from './leader.ts';
import { checkSettings, report } from './settings.ts';
import { Launchpad } from './launchpad/index.ts';
import { LaunchError } from './launchpad/build.ts';

// A bad setting stops the server here, with a message naming it. During an update, Swarm then keeps the previous
// server running, so a typo never replaces a working site (or pauses payouts) with a broken one.
if (report(checkSettings(process.env), 'The server') && mode !== 'demo') process.exit(1);

const demo = mode === 'demo';
const pad = new Launchpad(mode);
if (pad.key) config.excludeWallets.add(pad.key.publicKey.toBase58());

// ------------------------------------------------------------------ worker
type State = 'standby' | 'active' | 'stopping' | 'failed';
let state: State = 'standby';
let stopping = false;
const inFlight = new Set<Promise<unknown>>();
const loop = (ms: () => number, fn: () => Promise<unknown>) => {
  const tick = async () => {
    if (stopping) return;
    const run = fn().catch((e) => console.error('[loop]', e));
    inFlight.add(run);
    await run;
    inFlight.delete(run);
    if (!stopping) setTimeout(tick, ms());
  };
  void tick();
};

// One server owns the worker. During an update the new one stands by, already serving the site from the
// shared ledgers, and takes over the moment the old one lets go (or dies).
const lock = demo ? null : new LeaderLock(join(config.dataDir, 'leader.lock'));
function takeOver(): void {
  if (stopping || state !== 'standby') return;
  try {
    if (lock && !lock.tryAcquire()) { setTimeout(takeOver, 250); return; }
  } catch (e) {
    state = 'failed';
    console.error('[leader]', e);
    return;
  }
  state = 'active';
  console.log('[leader] active');
  pad.start(loop);
}

// ------------------------------------------------------------------ http
const DIST = resolve('web/dist');
const build = existsSync(join(DIST, 'index.html')) ? createHash('sha256').update(readFileSync(join(DIST, 'index.html'))).digest('hex').slice(0, 10) : 'dev';

/** Behind a reverse proxy set TRUST_PROXY=true so limits apply per visitor, not to the proxy. */
const clientIp = (req: IncomingMessage): string =>
  (process.env.TRUST_PROXY === 'true' && String(req.headers['x-forwarded-for'] ?? '').split(',').pop()?.trim()) || req.socket.remoteAddress || '';
const send = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};
/** A small JSON body, refused past `max` bytes. */
function readJson(req: IncomingMessage, max: number): Promise<Record<string, unknown>> {
  return new Promise((ok, fail) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) { fail(new LaunchError('That is too large. Use an image under 4 MB.')); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => {
      try {
        const v = JSON.parse(Buffer.concat(parts).toString('utf8'));
        if (v && typeof v === 'object' && !Array.isArray(v)) ok(v); else fail(new LaunchError('Bad request.'));
      } catch { fail(new LaunchError('Bad request.')); }
    });
    req.on('error', fail);
  });
}
const launches = new Map<string, { n: number; t: number }>();
const launchLimited = (ip: string): boolean => {
  const now = Date.now();
  const h = launches.get(ip);
  if (launches.size > 10_000) launches.clear();
  if (!h || now - h.t > 600_000) { launches.set(ip, { n: 1, t: now }); return false; }
  return ++h.n > 6;
};
const failed = (res: ServerResponse) => (e: unknown) => {
  if (e instanceof LaunchError) return send(res, 400, { error: e.message });
  console.error('[launch]', e instanceof Error ? e.message : e);
  send(res, 502, { error: 'Something went wrong on our side. Try again in a minute.' });
};
const MEDIA: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.json': 'application/json; charset=utf-8' };

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon' };
function file(path: string, res: ServerResponse): void {
  let f = normalize(join(DIST, path === '/' ? 'index.html' : path));
  if (f !== DIST && !f.startsWith(DIST + sep)) return send(res, 404, { error: 'not found' });
  if (!existsSync(f) || !statSync(f).isFile()) {
    // Never answer a script request with a page: the browser would cache a broken site.
    if (extname(path) || path.includes('/.')) return send(res, 404, { error: 'not found' });
    f = join(DIST, 'index.html');
  }
  if (!existsSync(f)) return send(res, 503, { error: 'site not built yet: run npm run build' });
  res.writeHead(200, {
    'content-type': TYPES[extname(f)] ?? 'application/octet-stream',
    'cache-control': path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin', 'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; frame-ancestors 'none'",
  });
  createReadStream(f).pipe(res);
}

const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (stopping) res.setHeader('connection', 'close');
  let path: string;
  try { path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname); } catch { return send(res, 400, { error: 'bad request' }); }

  if (req.method === 'POST') {
    if (path !== '/api/launch/prepare' && path !== '/api/launch/submit') return send(res, 404, { error: 'not found' });
    if (path === '/api/launch/prepare' && launchLimited(clientIp(req))) return send(res, 429, { error: 'Too many launches from here. Try again in a few minutes.' });
    readJson(req, 6 * 1024 * 1024)
      .then((body): Promise<unknown> => (path === '/api/launch/prepare' ? pad.prepare(body) : pad.submitted(String(body.mint ?? ''))))
      .then((out) => send(res, 200, out), failed(res));
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });

  if (path === '/api/health') {
    // Docker's health check. Standby counts as healthy: that is what lets Swarm retire the old server.
    let ok = state !== 'failed';
    try { pad.registry.get('lookup_table'); } catch { ok = false; }
    return send(res, ok ? 200 : 503, { ok, state, mode, build });
  }
  if (path === '/api/coins') return send(res, 200, { ...pad.list(), build });
  const coin = /^\/api\/coins\/([^/]+)$/.exec(path);
  if (coin) {
    const v = MINT.test(coin[1]!) ? pad.view(coin[1]!, build) : null;
    return send(res, v ? 200 : 404, v ?? { error: 'No coin by that address was launched here.' });
  }
  const m = /^\/media\/([^/]+)$/.exec(path);
  if (m) {
    const f = pad.media(m[1]!);
    if (!f) return send(res, 404, { error: 'not found' });
    // pump.fun and wallets read these from their own sites.
    res.writeHead(200, { 'content-type': MEDIA[extname(f)] ?? 'application/octet-stream', 'cache-control': 'public, max-age=86400', 'access-control-allow-origin': '*', 'x-content-type-options': 'nosniff' });
    createReadStream(f).pipe(res);
    return;
  }
  if (path.startsWith('/api/')) return send(res, 404, { error: 'not found' });
  file(path, res);
});
server.listen(config.port, config.host, () => {
  console.log(`[${mode}] http://${config.host}:${config.port}`);
  takeOver();
  if (state === 'standby') console.log('[leader] standby: waiting for the running server to hand over');
});

// ------------------------------------------------------------------ shutdown
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let closing = false;
async function shutdown(why: string): Promise<void> {
  if (closing) return;
  closing = true;
  stopping = true;
  pad.stop();
  const wasActive = state === 'active';
  state = 'stopping';
  console.log(`[shutdown] ${why}`);
  // Finish the current step, at most 7s so it fits Docker's default 10s grace. Being cut off is safe too:
  // every signature is on disk before it is sent, and the next server resolves it first.
  const idleNow = Promise.allSettled([...inFlight]).then(() => true);
  const clean = await Promise.race([idleNow, wait(7000).then(() => false)]);
  if (clean) lock?.release();
  console.log(`[shutdown] worker ${!wasActive ? 'was standby' : clean ? 'handed over' : 'cut off, the next server will resolve it'}`);
  // Keep answering while the proxy moves traffic.
  if (clean) await wait(1500);
  server.close();
  server.closeIdleConnections();
  await wait(400);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('message', (m) => { if (m === 'shutdown') void shutdown('message'); });
