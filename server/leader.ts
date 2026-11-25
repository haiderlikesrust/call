// Exactly one server may move money. The winner holds an exclusive lock on a tiny SQLite file for as
// long as it lives. The kernel drops that lock when the process ends for any reason, a crash included,
// so there is no lease to expire and no way for two servers to think they own the treasury.
// Works across containers that share a local Docker volume. Not for network file systems.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class LeaderLock {
  private readonly path: string;
  private db: DatabaseSync | null = null;
  held = false;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.path = path;
  }

  tryAcquire(): boolean {
    if (this.held) return true;
    this.db ??= new DatabaseSync(this.path, { timeout: 0 });
    try {
      this.db.exec('BEGIN EXCLUSIVE');
      this.held = true;
    } catch (e) {
      const code = (e as { errcode?: number }).errcode ?? 0;
      if ((code & 0xff) !== 5 && (code & 0xff) !== 6) throw e; // anything but BUSY / LOCKED is a real fault
    }
    return this.held;
  }

  release(): void {
    this.held = false;
    this.db?.close();
    this.db = null;
  }
}
