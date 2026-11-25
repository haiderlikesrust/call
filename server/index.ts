import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { PUMP_DECIMALS, config, mode, rules } from './config.ts';
import { Engine } from './engine.ts';
import { PumpApi } from './pumpApi.ts';
import { SolanaChain } from './chain.ts';
import { DemoChain, DemoSource, DemoWorld } from './demo.ts';
import { LeaderLock } from './leader.ts';
import { rewardFor, score } from './rewards.ts';
import { Store } from './store.ts';
import { snapshot } from './view.ts';

const demo = mode === 'demo';
// The demo plays the same movie faster: 8s to mature instead of 10 minutes.
if (demo) Object.assign(rules, { holdMinutes: 8 / 60, cooldownMinutes: 0.5, potFloor: 5_000 });

const store = new Store(demo ? ':memory:' : config.dbPath);
const world = new DemoWorld();
// Before launch nothing calls these; the demo stand-ins just sit idle over the real, empty ledger.
const idle = demo || mode === 'prelaunch';
const real = idle ? null : new SolanaChain();
if (real?.treasury) config.excludeWallets.add(real.treasury.toBase58());
const source = idle ? new DemoSource(world) : new PumpApi();
const chain = real ?? new DemoChain(world);
const startedAt = () => Number(store.get('start') ?? 0) || Date.now();
const engine = new Engine({
  store, source, chain, rules, mode, burnMode: config.burnMode, minBurn: config.minBurn, exclude: config.excludeWallets,
  start: () => (demo ? 0 : startedAt()),
});
engine.setMaxListeners(0);

// ------------------------------------------------------------------ worker
type State = 'standby' | 'active' | 'stopping' | 'failed';
let state: State = 'standby';
const inFlight = new Set<Promise<unknown>>();
const loop = (ms: () => number, fn: () => Promise<unknown>) => {
  const tick = async () => {
    if (engine.stopping) return;
    const run = fn().catch((e) => console.error('[loop]', e));
    inFlight.add(run);
    await run;
    inFlight.delete(run);
    if (!engine.stopping) setTimeout(tick, ms());
  };
  void tick();
};
/** Never poll faster than the daily allowance can sustain until midnight UTC. */
let used = 0;
let day = new Date().toISOString().slice(0, 10);
const pace = () => {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) { day = today; used = 0; }
  const left = Math.max(1, config.dailyBudget * 0.85 - used);
  const msLeft = Date.parse(`${day}T24:00:00Z`) - Date.now();
  return Math.max(config.pollMs, Math.min(60_000, msLeft / left));
};

function runDemo(): void {
  for (let i = 14; i > 0; i--) world.callout(Date.now() - i * 9000);
  world.treasury = 1_400_000n * 10n ** BigInt(PUMP_DECIMALS);
  loop(() => 2600 + Math.random() * 4200, async () => world.callout());
  let n = 0;
  // Fees come in bursts, and every few minutes trading goes quiet so the queue is visible.
  loop(() => 6000, async () => {
    n++;
    if (n % 30 >= 22) world.treasury = store.pots().burn + 2_000n * 1_000_000n;
    else world.treasury += BigInt(Math.round(8_000 + Math.random() * 70_000)) * 1_000_000n;
  });
  loop(() => 1000, () => engine.poll());
  loop(() => 1500, () => engine.mature());
  loop(() => 4000, () => engine.payCycle());
}

function runReal(): void {
  if (mode === 'prelaunch') return;
  if (!store.get('start')) store.set('start', String(config.rewardsStart ? Date.parse(config.rewardsStart) : Date.now()));
  if (mode === 'live' && !store.get('live_since')) {
    store.dropRehearsal();
    store.set('live_since', String(Date.now()));
    store.set('start', String(config.rewardsStart ? Date.parse(config.rewardsStart) : Date.now()));
  }
  loop(pace, async () => { used++; await engine.poll(); });
  loop(() => 300_000, async () => { used += 6; await engine.sweep(); });
  loop(() => 20_000, () => engine.mature());
  let lastClaim = 0;
  loop(() => 10_000, async () => {
    const claim = Date.now() - lastClaim > config.claimEveryMs;
    if (claim) lastClaim = Date.now();
    await engine.payCycle({ claim });
  });
  loop(() => 600_000, async () => store.purge(Date.now()));
}

// One server owns the worker. During an update the new one stands by, already serving the site from the
// shared ledger, and takes over the moment the old one lets go (or dies).
const lock = demo ? null : new LeaderLock(join(dirname(config.dbPath), 'leader.lock'));
function takeOver(): void {
  if (engine.stopping || state !== 'standby') return;
  try {
    if (lock && !lock.tryAcquire()) { setTimeout(takeOver, 250); return; }
  } catch (e) {
    state = 'failed';
    console.error('[leader]', e);
    return;
  }
  state = 'active';
  console.log('[leader] active');
  if (demo) runDemo(); else runReal();
}

// ------------------------------------------------------------------ http
const clients = new Set<ServerResponse>();
let dirty = true;
let cached = '';
const DIST = resolve('web/dist');
const build = existsSync(join(DIST, 'index.html')) ? createHash('sha256').update(readFileSync(join(DIST, 'index.html'))).digest('hex').slice(0, 10) : 'dev';
const current = () => {
  if (dirty || !cached) { cached = JSON.stringify(snapshot(engine, mode, startedAt(), build)); dirty = false; }
  return cached;
};
let timer: NodeJS.Timeout | null = null;
const broadcast = () => {
  dirty = true;
  timer ??= setTimeout(() => {
    timer = null;
    const msg = `data: ${current()}\n\n`;
    for (const c of clients) c.write(msg);
  }, 400);
};
engine.on('change', broadcast);
// Not the owner (standby, or draining): the other server writes the ledger, so look for its changes.
setInterval(() => { if (state !== 'active') broadcast(); }, 1500).unref();
setInterval(() => { for (const c of clients) c.write(': keep-alive\n\n'); }, 20_000).unref();

const hits = new Map<string, { n: number; t: number }>();
const limited = (ip: string): boolean => {
  const now = Date.now();
  const h = hits.get(ip);
  if (hits.size > 10_000) hits.clear();
  if (!h || now - h.t > 60_000) { hits.set(ip, { n: 1, t: now }); return false; }
  return ++h.n > 20;
};
/** Behind a reverse proxy set TRUST_PROXY=true so limits apply per visitor, not to the proxy. */
const clientIp = (req: IncomingMessage): string =>
  (process.env.TRUST_PROXY === 'true' && String(req.headers['x-forwarded-for'] ?? '').split(',').pop()?.trim()) || req.socket.remoteAddress || '';
const send = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};
const walletCache = new Map<string, { at: number; body: unknown }>();

async function wallet(addr: string, res: ServerResponse): Promise<void> {
  const hit = walletCache.get(addr);
  if (hit && Date.now() - hit.at < 60_000) return send(res, 200, hit.body);
  const [balance, supply, followers] = await Promise.all([chain.holding(addr), chain.supply(), source.followers(addr)]);
  const s = score(balance, supply, followers ?? 0, rules);
  const body = {
    wallet: addr, followers, holdPct: supply > 0n ? Number((balance * 1_000_000n) / supply) / 10_000 : 0, score: s,
    estimate: Number(rewardFor(store.pots().reward, s, 1, rules)) / 1e6,
    holds: balance > 0n && balance * 1_000_000n >= supply * BigInt(Math.round(rules.minHoldBps * 100)),
    reach: (followers ?? 0) >= rules.minFollowers,
  };
  if (walletCache.size > 2000) walletCache.clear();
  walletCache.set(addr, { at: Date.now(), body });
  send(res, 200, body);
}

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

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (engine.stopping) res.setHeader('connection', 'close');
  let path: string;
  try { path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname); } catch { return send(res, 400, { error: 'bad request' }); }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
  if (path === '/api/health') {
    // Docker's health check. Standby counts as healthy: that is what lets Swarm retire the old server.
    let ok = state !== 'failed';
    try { store.get('start'); } catch { ok = false; }
    return send(res, ok ? 200 : 503, { ok, state, mode, build });
  }
  if (path === '/api/state') return send(res, 200, current());
  if (path === '/api/stream') {
    if (clients.size > 5000) return send(res, 503, { error: 'busy' });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(`retry: 600\ndata: ${current()}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  const w = /^\/api\/wallet\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(path);
  if (w) {
    if (mode === 'prelaunch') return send(res, 409, { error: 'Wallet checks open when the coin launches.' });
    if (limited(clientIp(req))) return send(res, 429, { error: 'Too many lookups. Try again in a minute.' });
    wallet(w[1]!, res).catch(() => send(res, 502, { error: 'Could not read that wallet right now. Try again shortly.' }));
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
  engine.stopping = true;
  const wasActive = state === 'active';
  state = 'stopping';
  console.log(`[shutdown] ${why}`);
  // Finish the current step, at most 7s so it fits Docker's default 10s grace. Being cut off is safe too:
  // every signature is on disk before it is sent, and the next server resolves it first.
  const idleNow = Promise.allSettled([...inFlight]).then(() => true);
  const clean = await Promise.race([idleNow, wait(7000).then(() => false)]);
  if (clean) lock?.release();
  console.log(`[shutdown] worker ${!wasActive ? 'was standby' : clean ? 'handed over' : 'cut off, the next server will resolve it'}`);
  // Keep answering while the proxy moves traffic, then send live streams to the new server.
  if (clean) await wait(1500);
  for (const c of clients) c.end();
  server.close();
  server.closeIdleConnections();
  await wait(400);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('message', (m) => { if (m === 'shutdown') void shutdown('message'); });
