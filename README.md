# Holler

A pump.fun launchpad. Anyone can launch a coin here; it trades on pump.fun against SOL. Its creator fees are claimed in SOL, swapped to USDC, and paid to the holders who call it out on pump.fun. Some of every fee buys the coin back and burns it, and a share goes to the callers of the platform coin.

## Run

```
npm install
npm run build
npm start          # http://127.0.0.1:8787, demo coins until .env is filled
npm test           # reward maths, money accounting, engine, rolling updates
npm run doctor     # read-only check of your setup
```

Modes: **demo** (no `LAUNCHPAD_SECRET_KEY` outside production, or `DEMO=true`), **dry-run** (real coins and callouts, nothing sent; launches open once the key is set), **live** (`LIVE_PAYOUTS=true` plus the key).

## How the money moves

```
creator fees (SOL)  ->  launchpad wallet, per coin, from its own pump.fun fee-sharing vault
                        |- PLATFORM_PCT (30%)  -> credited to the platform coin
                        '- the rest            -> swapped SOL -> USDC through Jupiter
                                                  |- CALLER_PCT share -> the coin's reward pot (USDC)
                                                  '- BURN_PCT share   -> buys the coin back, burns it
```

* Every coin is created paired with SOL, with a fee-sharing config whose vault pays the launchpad wallet, so each coin's fees are claimed on their own.
* All coins share one wallet. `server/launchpad/registry.ts` keeps them apart: a coin can only swap the SOL its own claims brought in, and only pay out the USDC its own swaps made. SOL in a swap is written down before it is sent, so it is never swapped twice; USDC counts once the swap confirms.
* The platform coin (`PLATFORM_MINT`) is launched through the site like any other. It keeps all of its own fees and is credited `PLATFORM_PCT` of everyone else's. Until it is set, those shares wait in the wallet.
* Every claim, swap, payout and burn is measured from its own confirmed transaction. Every signature is saved before broadcast and retried only once its blockhash is provably dead, so a crash cannot pay twice. Jupiter swaps are simulated and refused if they would change any token account's authority, spend more than allowed or return less than quoted.

## The reward

```
reward = coin's reward pot x 2.5% x min(1, 0.2 + 0.5 x bag x streak + 0.3 x reach) x queue weight
bag    = min(1, share of supply / 2%) ^ 0.75   (0.1% of supply needed to qualify)
reach  = min(1, log(pump.fun followers / 10) / log(10,000 / 10))
streak = min(3, 1.1 ^ paid callouts in a row that kept the bag)
```

Paid in USDC. Below `MIN_PAYOUT_USDC`, or while the pot is below `POT_FLOOR_USDC`, a callout waits in line, oldest first, gaining weight each hour. Launchers cannot earn from their own coin.

## Guards

Holding is read from the chain, sampled through the 2-minute hold, and re-read just before paying; the lowest value counts. One wallet or pump.fun account earns at most every 10 minutes, with one callout in line at a time. Dev, squad, low-quality and under-10-follower accounts are refused.

pump.fun data (names, avatars, text, follower counts) is dropped after 24 hours. The ledgers keep wallets and amounts.

## Going live

See [docs/DOKPLOY.md](docs/DOKPLOY.md). In short: a fresh launchpad wallet with ~0.1 SOL, a paid RPC, a Jupiter API key, `npm run doctor`, launch the platform coin through the site and set `PLATFORM_MINT`, then `LIVE_PAYOUTS=true`. Back up the `data/` folder: it is the payout ledger.
