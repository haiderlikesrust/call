// Stand-ins for pump.fun and Solana so the site runs before the coin exists.
// They drive the real engine with the real reward maths; only the inputs are invented.
import { randomBytes } from 'node:crypto';
import bs58 from 'bs58';
import type { Chain, OnSigned, Outcome } from './chain.ts';
import type { Listed, Row, Source } from './pumpApi.ts';
import { UNIT } from './rewards.ts';

const pick = <T>(a: readonly T[]): T => a[Math.floor(Math.random() * a.length)]!;
const id = (n = 32) => bs58.encode(randomBytes(n));
const NAMES = ['demo_moss', 'demo_kiosk', 'demo_lantern', 'demo_pickle', 'demo_tugboat', 'demo_quartz', 'demo_biscuit', 'demo_static', 'demo_orchid', 'demo_rivet', 'demo_gumdrop', 'demo_falcon', 'demo_wicker', 'demo_turbine', 'demo_clover', 'demo_marble', 'demo_saffron', 'demo_pylon'] as const;
const LINES = ['getting paid to say what i was going to say anyway', 'every callout feeds the furnace. i like the furnace', 'bought, held, called it out. that is the whole strategy', 'queue is moving again, pot just refilled', 'small bag, loud mouth, still got a drop', 'fees in $PUMP, rewards in $PUMP, supply goes down', 'my followers asked what i am holding. this', 'ten minutes of not selling is the easiest job i have had'] as const;
const SUPPLY = 1_000_000_000n * UNIT;

interface Person { wallet: string; name: string; followers: number; bag: bigint; born: number }

export class DemoWorld {
  supplyNow = SUPPLY;
  treasury = 0n;
  readonly people: Person[] = NAMES.map((name) => ({
    wallet: id(), name, followers: Math.round(10 ** (1 + Math.random() * 4)),
    bag: (SUPPLY * BigInt(Math.round(10 ** (Math.random() * 2.3)))) / 10_000n, born: Date.now() - (2 + Math.random() * 400) * 86_400_000,
  }));
  readonly rows: Row[] = [];
  readonly swaps = new Map<string, bigint>();

  callout(at = Date.now()): void {
    const p = Math.random() < 0.4 ? pick(this.people) : this.newcomer();
    this.rows.unshift({
      calloutId: id(12), wallet: p.wallet, userId: p.wallet, username: p.name, avatar: null, thesis: pick(LINES), likes: 0, followers: p.followers,
      accountCreatedAt: p.born, createdAt: at, isDev: false, isGroup: false, isPumpUser: true, lowQuality: false,
    });
    this.rows.length = Math.min(this.rows.length, 120);
    if (Math.random() < 0.05) p.bag = 0n;
  }
  private newcomer(): Person {
    const p: Person = { wallet: id(), name: `${pick(NAMES)}${Math.floor(Math.random() * 90 + 10)}`, followers: Math.round(10 ** (0.7 + Math.random() * 3.6)), bag: (SUPPLY * BigInt(Math.round(10 ** (Math.random() * 2.1)))) / 10_000n, born: Date.now() - Math.random() * 200 * 86_400_000 };
    this.people.push(p);
    if (this.people.length > 300) this.people.splice(0, 100);
    return p;
  }
}

export class DemoSource implements Source {
  health = { ok: true, note: 'demo data', remaining: null };
  readonly everyMs = 1000;
  private readonly w: DemoWorld;
  constructor(w: DemoWorld) { this.w = w; }
  async callouts() {
    return this.w.rows.map((r) => ({ calloutId: r.calloutId, wallet: r.wallet, createdAt: r.createdAt, thesis: r.thesis, likes: r.likes, username: r.username, avatar: r.avatar, followers: r.followers }));
  }
  async account(l: Listed) {
    const p = this.w.people.find((x) => x.wallet === l.wallet);
    return { calloutId: l.calloutId, wallet: l.wallet, userId: l.wallet, isDev: false, isGroup: false, username: l.username, avatar: null, followers: p?.followers ?? 100, isPumpUser: true, banned: false };
  }
  async exists() { return Math.random() > 0.02; }
  async followers(wallet: string) { return this.w.people.find((p) => p.wallet === wallet)?.followers ?? 100; }
}

export class DemoChain implements Chain {
  readonly canSign = true;
  private readonly w: DemoWorld;
  constructor(w: DemoWorld) { this.w = w; }
  async treasuryBalance() { return this.w.treasury; }
  async supply() { return this.w.supplyNow; }
  async holding(wallet: string) { return this.w.people.find((p) => p.wallet === wallet)?.bag ?? 0n; }
  async holders() { return { at: Date.now(), balances: new Map(this.w.people.filter((p) => p.bag > 0n).map((p) => [p.wallet, p.bag])) }; }
  async solOk() { return true; }
  async claim() { return null; }
  async resolve(): Promise<Outcome> { return 'confirmed'; }
  async pay(items: { wallet: string; amount: bigint }[], onSigned: OnSigned): Promise<Outcome> {
    onSigned(id(64), 0);
    for (const i of items) this.w.treasury -= i.amount;
    return 'confirmed';
  }
  async buyback(pumpIn: bigint, onSigned: OnSigned): Promise<Outcome> {
    const sig = id(64);
    onSigned(sig, 0);
    this.w.treasury -= pumpIn;
    this.w.swaps.set(sig, pumpIn * 9n);
    return 'confirmed';
  }
  async bought(sig: string) { return this.w.swaps.get(sig) ?? 0n; }
  async burn(which: 'pump' | 'coin', amount: bigint, onSigned: OnSigned): Promise<Outcome> {
    onSigned(id(64), 0);
    if (which === 'pump') this.w.treasury -= amount;
    else this.w.supplyNow -= amount;
    return 'confirmed';
  }
}
