# Callout

Holders call out the coin on pump.fun. Creator fees (in $PUMP) go 80% to them, 20% to burning supply.

## Run

```
npm install
npm run build
npm start          # http://127.0.0.1:8787, demo data until .env is filled
npm test           # reward maths and engine
npm run doctor     # read-only check of your setup
```

Modes: **demo** (no API key), **dry-run** (real callouts, nothing sent), **live** (`LIVE_PAYOUTS=true` plus the treasury key).

## Going live

1. Launch the coin paired with **$PUMP** as its quote. That is what makes creator fees arrive in $PUMP. Do not add fee sharing unless the treasury is a recipient.
2. Apply for a key at https://developers.pump.fun. Describe exactly this use: reading callouts and follower counts on one coin to pay its holders. The API terms tie the key to the approved purpose. Ask developers@pump.fun for the 1M/day tier if you want 1-second polling.
3. Copy `.env.example` to `.env`. Run dry-run first with `TREASURY_PUBKEY`, then `npm run doctor`.
4. Use a fresh creator wallet. All $PUMP in it counts as fee income and is split 80/20, so keep personal $PUMP elsewhere. Keep some SOL in it: each first-time recipient costs about 0.002 SOL for their token account.
5. Use a paid RPC. Run exactly one server process per `data/callout.db`, and back that file up: it is the payout ledger.

## The reward

```
reward = reward pot x 2.5% x bag x reach x queue weight
bag    = min(1, share of supply / 1%) ^ 0.75
reach  = 0.1 + 0.9 x min(1, log10(1 + followers) / log10(100,001))
burn   = reward x 20/80, from the burn pot
```

* A share of the pot can never overdraw it. One callout takes at most 2.5% (5% with full queue weight).
* Bag and reach multiply, so neither a whale nobody follows nor an influencer with dust gets a big cut. 0.75 keeps small bags worth something while making bag splitting a losing trade at realistic sizes (see `test/rewards.test.ts`).
* Below `MIN_PAYOUT_PUMP`, or while the pot is below `POT_FLOOR_PUMP`, a callout waits in the queue. Oldest first. Each hour adds 5% weight up to 2x. Someone whose share is still too small does not block the people behind. Tickets expire after 7 days, or at once if the holder sells.

## Guards

Holding is read from the chain, sampled through the hold window, and re-read just before paying; the lowest value counts. One wallet or pump.fun account can earn again every 10 minutes (`COOLDOWN_MINUTES`), with one callout in progress at a time. Dev, squad, low-quality and under-10-follower accounts are refused; new accounts are fine.

Every payout's signature is saved before broadcast and only retried once its blockhash is provably dead, so a crash cannot pay twice. The buyback swap is simulated and refused if it would spend too much, return too little, or change any token authority.

pump.fun data (names, avatars, text, follower counts) is dropped after 24 hours, as the API terms require. The ledger keeps wallets and amounts.
