/**
 * Runs before the server starts (deploy/start.sh). Copies this build's scripts, styles and fonts (all named
 * by content hash) into web/dist/assets. With a Dokploy volume mounted there, earlier builds' files stay, so
 * a page from either version can load its files from either server during an update.
 * Files that no build has shipped for 30 days are removed.
 */
import { copyFile, mkdir, readdir, rename, rm, stat, utimes } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

const FROM = process.argv[2] ?? 'static-build';
const TO = process.argv[3] ?? 'web/dist/assets';
const MAX_AGE_MS = 30 * 86_400_000;
const files = async (dir) => (await readdir(dir, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));

const now = new Date();
let added = 0;
let removed = 0;
await mkdir(TO, { recursive: true });
for (const source of await files(FROM)) {
  const target = join(TO, relative(FROM, source));
  // Already there from an earlier build: mark it as in use again.
  if (await utimes(target, now, now).then(() => true, () => false)) continue;
  // Copy then rename, so a server reading the folder never sees half a file.
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, `${target}.${process.pid}.tmp`);
  await rename(`${target}.${process.pid}.tmp`, target);
  added++;
}
for (const file of await files(TO)) {
  const age = now.getTime() - (await stat(file).catch(() => ({ mtimeMs: now.getTime() }))).mtimeMs;
  if (age > MAX_AGE_MS) { await rm(file, { force: true }); removed++; }
}
console.log(`[static] ${added} files added, ${removed} older than 30 days removed`);
