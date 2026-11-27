# Deploy Holler on Dokploy (zero-downtime updates)

The app is one Docker image (the [`Dockerfile`](../Dockerfile) at the repo root): a Node server for the site, the API and the payout worker. The coin registry and each coin's payout ledger are SQLite files on a Docker volume, so there is no database service to run.

Deploy it as a Dokploy **Application**, not a Compose service. Compose stops the old server before it starts the new one. An Application is a Swarm service, which can start the new one first.

## What happens on an update

1. **Build.** Dokploy builds and type-checks the new image while the old version keeps serving. If that fails, nothing changes.
2. **Standby.** The new container starts and serves the site straight away from the shared ledger. It does not touch money: exactly one server holds the worker lock (`data/leader.lock`), and the old one still has it. Its health check counts standby as healthy.
3. **Hand-over.** Swarm stops the old container. It finishes the step it is on (7 seconds at most), releases the lock, keeps answering while traffic moves, then closes. The new server takes the lock within a quarter of a second.
4. **Open pages keep working.** Pages poll the API and pick up the new server by themselves. Old scripts stay downloadable from the shared static volume. Pages offer an **Update** button, or reload themselves while in the background.
5. **Rollback.** If the new version does not become healthy, Swarm puts the previous one back.

Payouts are safe even if the old server is killed outright. The kernel releases the lock when a process dies, every signature is on disk before it is broadcast, and the new server settles anything in flight before it sends something new.

## Set up

1. **Application.**
   - **Create Service → Application**, name it `holler`.
   - **General:** provider **Git**, `https://github.com/haiderlikesrust/call.git`, branch `holler-launchpad` (or `main` once it is merged). For deploys on push, use the **GitHub** provider instead, after giving the Dokploy GitHub app access to this repository.
   - **Build Type:** Dockerfile. **Dockerfile Path** `Dockerfile`, **Docker Context Path** `.`.
2. **Volumes.** In **Advanced → Volumes**, add two **Volume Mounts** before the first deploy:

   | Volume name | Mount path | Holds |
   |---|---|---|
   | `holler-data` | `/app/data` | The coin registry, every coin's payout ledger, hosted coin metadata and the worker lock. **Without it, every update erases who was paid.** |
   | `holler-static` | `/app/web/dist/assets` | Scripts and styles from this and earlier builds |

   Both must be local volumes on one node. The lock does not work over NFS or other network storage. If your Swarm has more than one node, pin the service in **Cluster Settings → Swarm Settings → Placement**:
   ```json
   { "Constraints": ["node.role==manager"] }
   ```
   (or a `node.hostname==` constraint if you have several managers).
3. **Environment.** Paste [`deploy/dokploy.env.example`](../deploy/dokploy.env.example). It can stay empty for the first deploy. These are runtime values: never put them in **Build-time Arguments**.
4. **Domain.** In **Domains**, add `holler.lol` (and set `SITE_URL=https://holler.lol`), path `/`, container port **3000**, HTTPS with Let's Encrypt. Point the domain's DNS A record at the VPS first. For `www`, add it the same way plus a "www to non-www" redirect under **Advanced → Redirects**.
5. **Zero-downtime settings.** In **Advanced → Cluster Settings**:
   - **Replicas:** `1`.
   - **Swarm Settings** (forms in Dokploy 0.31; older versions take the same values as JSON):

     | Section | Parallelism | Delay | Failure action | Monitor | Max failure ratio | Order |
     |---|---|---|---|---|---|---|
     | Update Config | 1 | 0 | Rollback | 60000000000 | 0 | **Start First** |
     | Rollback Config | 1 | | Pause | 60000000000 | | Start First |

   - **Health Check:** leave empty. The image has its own.
   - Durations are in nanoseconds (60000000000 = 60 s).
6. **Deploy**, then open `https://holler.lol/api/health`. It should show `"ok": true`, `"state": "active"`, `"mode": "dry-run"`.
7. **Backups.** Schedule a volume backup of `holler-data` to S3. It is the record of who was paid.
8. **Autodeploy** only fires with the GitHub provider. Think twice before using it once the launchpad key is in the environment: a push to `main` would then run on the server that holds the wallet.

## Check an update yourself

Leave this running while you click **Deploy**. It should print only `200`:

```bash
while true; do curl -s -o /dev/null -w '%{http_code} %{time_total}s\n' https://holler.lol/api/coins; sleep 0.3; done
```

The new container logs `[leader] standby`, then `[leader] active`. The old one logs `[shutdown] worker handed over`.

## Go live

1. **Launchpad wallet.** Create a new wallet, fund it with about 0.1 SOL, set `LAUNCHPAD_SECRET_KEY`, `RPC_URL` and `JUPITER_API_KEY`, keep `LIVE_PAYOUTS=false`, redeploy. Launches open; callouts on launched coins are recorded, nothing is paid.
2. **Platform coin.** Launch it through the site's own Launch page, then set `PLATFORM_MINT` to its mint and redeploy.
3. In the application's terminal: `npm run doctor`. Fix anything marked `FIX` (wallet SOL, the SOL to USDC route, the platform coin).
4. Set `LIVE_PAYOUTS=true`, redeploy. Callouts collected during the rehearsal are dropped on the first live start, so nobody is paid for those. Fees are claimed in SOL, swapped to USDC, and paid out from there.
5. Check the first claim, swap and payout receipts on Solscan.

To stop payouts, set `LIVE_PAYOUTS=false` and redeploy. The queue keeps everyone's place.

## When an update does not take

If the site still shows the old version after a deploy (for example launches still closed after setting `LAUNCHPAD_SECRET_KEY`), the new container stopped and Swarm kept the old one: the Docker Terminal lists it as **exited**. Open its logs. A bad setting is named on the `[settings]` lines, for example `RPC_URL must be a full URL starting with https://`. Fix it in **Environment**, save, and deploy again. Secret keys are never printed there.

## Rules that keep updates seamless

- **One replica.** A second would only stand by.
- **Ledger changes must be additive.** Both versions share the file during an update, and a rollback runs old code on the new schema. Add columns or tables; don't rename or drop in the same release.
- **Never mount `holler-data` into another app.**
- **Settings are read at start,** so a change needs a redeploy, which goes through the same hand-over.
