# Deploy callonpump.now on Dokploy (zero-downtime updates)

The app is one Docker image (the [`Dockerfile`](../Dockerfile) at the repo root): a Node server for the site, the API and the payout worker. The ledger is a SQLite file on a Docker volume, so there is no database service to run.

Deploy it as a Dokploy **Application**, not a Compose service. Compose stops the old server before it starts the new one. An Application is a Swarm service, which can start the new one first.

## What happens on an update

1. **Build.** Dokploy builds and type-checks the new image while the old version keeps serving. If that fails, nothing changes.
2. **Standby.** The new container starts and serves the site straight away from the shared ledger. It does not touch money: exactly one server holds the worker lock (`data/leader.lock`), and the old one still has it. Its health check counts standby as healthy.
3. **Hand-over.** Swarm stops the old container. It finishes the step it is on (7 seconds at most), releases the lock, keeps answering while traffic moves, then closes. The new server takes the lock within a quarter of a second.
4. **Open pages keep working.** Live streams reconnect to the new server by themselves. Old scripts stay downloadable from the shared static volume. Pages offer an **Update** button, or reload themselves while in the background.
5. **Rollback.** If the new version does not become healthy, Swarm puts the previous one back.

Payouts are safe even if the old server is killed outright. The kernel releases the lock when a process dies, every signature is on disk before it is broadcast, and the new server settles anything in flight before it sends something new.

## Set up

1. **Application.**
   - **Create Service → Application**, name it `callout`.
   - **General:** provider GitHub, `haiderlikesrust/call`, branch `main`.
   - **Build Type:** Dockerfile. **Dockerfile Path** `Dockerfile`, **Docker Context Path** `.`.
2. **Volumes.** In **Advanced → Volumes**, add two **Volume Mounts** before the first deploy:

   | Volume name | Mount path | Holds |
   |---|---|---|
   | `callout-data` | `/app/data` | The payout ledger and the worker lock. **Without it, every update erases who was paid.** |
   | `callout-static` | `/app/web/dist/assets` | Scripts and styles from this and earlier builds |

   Both must be local volumes on one node. The lock does not work over NFS or other network storage. If your Swarm has more than one node, pin the service in **Cluster Settings → Swarm Settings → Placement**:
   ```json
   { "Constraints": ["node.role==manager"] }
   ```
   (or a `node.hostname==` constraint if you have several managers).
3. **Environment.** Paste [`deploy/dokploy.env.example`](../deploy/dokploy.env.example). It can stay empty for the first deploy. These are runtime values: never put them in **Build-time Arguments**.
4. **Domain.** In **Domains**, add `callonpump.now`, path `/`, container port **3000**, HTTPS with Let's Encrypt. Point the domain's DNS A record at the VPS first. For `www`, add it the same way plus a "www to non-www" redirect under **Advanced → Redirects**.
5. **Zero-downtime settings.** In **Advanced → Cluster Settings**:
   - **Replicas:** `1`.
   - **Swarm Settings → Update Config:**
     ```json
     { "Parallelism": 1, "Delay": 0, "FailureAction": "rollback", "Monitor": 60000000000, "MaxFailureRatio": 0, "Order": "start-first" }
     ```
   - **Swarm Settings → Rollback Config:**
     ```json
     { "Parallelism": 1, "Delay": 0, "FailureAction": "pause", "Monitor": 60000000000, "MaxFailureRatio": 0, "Order": "start-first" }
     ```
   - **Swarm Settings → Health Check** (the same one is built into the image; paste it so an update never starts without it):
     ```json
     { "Test": ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"], "Interval": 5000000000, "Timeout": 3000000000, "StartPeriod": 60000000000, "Retries": 3 }
     ```
   - Durations are in nanoseconds (5000000000 = 5 s).
6. **Deploy**, then open `https://callonpump.now/api/health`. It should show `"ok": true`, `"state": "active"`, `"mode": "prelaunch"`.
7. **Backups.** Schedule a volume backup of `callout-data` to S3. It is the record of who was paid.
8. **Optional:** turn on **Autodeploy** so every push to `main` deploys the same way.

## Check an update yourself

Leave this running while you click **Deploy**. It should print only `200`:

```bash
while true; do curl -s -o /dev/null -w '%{http_code} %{time_total}s\n' https://callonpump.now/api/state; sleep 0.3; done
```

The new container logs `[leader] standby`, then `[leader] active`. The old one logs `[shutdown] worker handed over`.

## Go live

1. **Rehearsal.** Set `COIN_MINT`, `PUMP_API_KEY`, `RPC_URL` and `TREASURY_PUBKEY`, redeploy. Callouts are real, nothing is sent. Compare the site with the coin's page on pump.fun.
2. In the application's terminal: `npm run doctor`. Fix anything marked `FIX`.
3. Set `TREASURY_SECRET_KEY` and `LIVE_PAYOUTS=true`, redeploy. Callouts collected during the rehearsal are dropped on the first live start, so nobody is paid for those.
4. Start with a small pool and check the first receipts on Solscan.

To stop payouts, set `LIVE_PAYOUTS=false` and redeploy. The queue keeps everyone's place.

## Rules that keep updates seamless

- **One replica.** A second would only stand by.
- **Ledger changes must be additive.** Both versions share the file during an update, and a rollback runs old code on the new schema. Add columns or tables; don't rename or drop in the same release.
- **Never mount `callout-data` into another app.**
- **Settings are read at start,** so a change needs a redeploy, which goes through the same hand-over.
