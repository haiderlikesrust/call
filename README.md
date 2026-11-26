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

Modes: **demo** (no `COIN_MINT`), **dry-run** (real callouts, nothing sent), **live** (`LIVE_PAYOUTS=true` plus the treasury key).

## Going live

1. Launch the coin paired with **$PUMP** as its quote. That is what makes creator fees arrive in $PUMP. Do not add fee sharing unless the treasury is a recipient.
2. No API key is needed. Every 10 seconds (`GMGN_POLL_MS`) the server reads the coin's callouts from gmgn and its holders from the chain. Callouts from holders with at least 0.1% go first, smallest bag up; everyone below is turned away on the spot, so buying in after calling out never counts. Each one is then judged on what pump.fun itself says: the callout (`/callout/{id}`: dev flag, account id, person or squad) and the author (`/users/{wallet}/overview`: followers, pump user, banned). gmgn's follower counts are often stale or zero, so they never decide anything; if pump.fun doesn't answer, the callout waits for the next read (it stays listed for a day). Both sites only answer browser-like clients, so requests carry Chrome's TLS fingerprint (the `impit` package).
3. Copy `.env.example` to `.env`. Run dry-run first with `TREASURY_PUBKEY`, then `npm run doctor`.
4. Use a fresh creator wallet. All $PUMP in it counts as fee income and is split 80/20, so keep personal $PUMP elsewhere. Keep some SOL in it: each first-time recipient costs about 0.002 SOL for their token account.
5. Use a paid RPC: the holder list is one `getProgramAccounts` call every 30 seconds, which the public RPC often refuses. Run exactly one server process per `data/callout.db`, and back that file up: it is the payout ledger.

## The reward

```
reward = reward pot x 2.5% x min(1, 0.2 + 0.5 x bag x streak + 0.3 x reach) x queue weight
bag    = min(1, share of supply / 2%) ^ 0.75   (0.1% of supply needed to qualify)
reach  = min(1, log(pump.fun followers / 10) / log(10,000 / 10))
streak = min(3, 1.1 ^ paid callouts in a row that kept the bag)
burn   = reward x 20/80, from the burn pot
```

* A share of the pot can never overdraw it. One callout takes at most 2.5% (5% with full queue weight).
* Every qualifying callout starts at 0.2 (`BASE_SCORE`): 0.5% of the pot, $5 per $1,000. A full bag adds 0.5 (`BAG_WEIGHT`) and full reach the other 0.3, each on its own, so more followers pay at any bag size.
* Holding compounds. Each paid callout in a row where the wallet held at least what it held at its last one grows the bag part 10% (`HOLD_STREAK_RATE`), up to 3x (`HOLD_STREAK_CAP`). A callout dropped for selling, or a smaller bag than last time, restarts it. The streak is worked out from the ledger, so it needs no new columns.
* The base and reach are paid per callout, so splitting one bag across several pump.fun accounts earns more than holding it in one. The entry rules (0.1% held, 10 followers), the 10-minute hold and the per-account cooldown are what limit that. Lower `BASE_SCORE` if farming shows up.
* Below `MIN_PAYOUT_PUMP`, or while the pot is below `POT_FLOOR_PUMP`, a callout waits in the queue. Oldest first. Each hour adds 5% weight up to 2x. Someone whose share is still too small does not block the people behind. Tickets expire after 7 days, or at once if the holder sells.

## Guards

Holding is read from the chain, sampled through the hold window, and re-read just before paying; the lowest value counts. One wallet or pump.fun account can earn again every 10 minutes (`COOLDOWN_MINUTES`), with one callout in progress at a time. Dev, squad, low-quality and under-10-follower accounts are refused; new accounts are fine.

Every payout's signature is saved before broadcast and only retried once its blockhash is provably dead, so a crash cannot pay twice. The buyback swap is simulated and refused if it would spend too much, return too little, or change any token authority.

pump.fun data (names, avatars, text, follower counts) is dropped after 24 hours, as the API terms require. The ledger keeps wallets and amounts.
