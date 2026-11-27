// A real update: two server processes, one ledger, traffic the whole way through.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LeaderLock } from '../server/leader.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dir = () => mkdtempSync(join(tmpdir(), 'holler-'));
const start = (port: number, data: string): ChildProcess =>
  fork('server/index.ts', { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], env: { ...process.env, NODE_ENV: 'production', DEMO: '', LAUNCHPAD_SECRET_KEY: '', PLATFORM_MINT: '', HOST: '127.0.0.1', PORT: String(port), DATA_DIR: data } });
const health = async (port: number) => {
  try { return (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()) as { ok: boolean; state: string; mode: string }; } catch { return null; }
};
const until = async (port: number, state: string, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if ((await health(port))?.state === state) return Date.now();
  throw new Error(`port ${port} never became ${state}: ${JSON.stringify(await health(port))}`);
};
const exit = (c: ChildProcess) => new Promise<number | null>((r) => c.once('exit', (code) => r(code)));

test('only one holder of the lock, and it frees on release', () => {
  const path = join(dir(), 'leader.lock');
  const a = new LeaderLock(path);
  const b = new LeaderLock(path);
  assert.equal(a.tryAcquire(), true);
  assert.equal(b.tryAcquire(), false);
  a.release();
  assert.equal(b.tryAcquire(), true);
  b.release();
});

test('rolling update: the new server serves while standing by, then takes over, with no failed request', async () => {
  const data = dir();
  const a = start(18787, data);
  await until(18787, 'active');
  const b = start(18788, data);
  await until(18788, 'standby');
  const h = (await health(18788))!;
  assert.equal(h.ok, true, 'standby is healthy, so Swarm may retire the old one');
  assert.equal(h.mode, 'dry-run', 'production without keys never shows invented data');

  // Like the proxy: old server first, new one as soon as the old refuses.
  let ok = 0;
  const bad: string[] = [];
  let run = true;
  const traffic = Promise.all(Array.from({ length: 4 }, async () => {
    while (run) {
      let done = false;
      for (const port of [18787, 18788]) {
        try {
          const r = await fetch(`http://127.0.0.1:${port}/api/coins`);
          await r.text();
          if (r.status === 200) { done = true; break; }
          bad.push(`${port} ${r.status}`);
        } catch { /* closed: try the other */ }
      }
      if (done) ok++; else bad.push('no server answered');
      await sleep(10);
    }
  }));
  await sleep(300);
  const gone = exit(a);
  const asked = Date.now();
  a.send('shutdown');
  const took = (await until(18788, 'active')) - asked;
  assert.ok(took < 1500, `hand-over took ${took}ms`);
  assert.equal(await gone, 0, 'old server exits cleanly');
  await sleep(300);
  run = false;
  await traffic;
  assert.deepEqual(bad, []);
  assert.ok(ok > 50, `${ok} requests`);
  const bye = exit(b);
  b.send('shutdown');
  await bye;
});

test('a killed server loses the lock at once and the standby takes over', async () => {
  const data = dir();
  const a = start(18789, data);
  await until(18789, 'active');
  const b = start(18790, data);
  await until(18790, 'standby');
  a.kill('SIGKILL');
  await until(18790, 'active', 3000);
  const bye = exit(b);
  b.send('shutdown');
  await bye;
});
