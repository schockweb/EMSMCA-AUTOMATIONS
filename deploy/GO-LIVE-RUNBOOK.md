# 🚦 portal.emsmca.co.za — Go-Live Runbook

> ## ✅ STATUS: infrastructure go-live is COMPLETE (since 2026-07-13)
> The site serves valid HTTPS today: DNS resolves to 172.209.218.22, the
> Let's Encrypt certificate is live and auto-renewing, and the 443 block in
> `nginx/nginx.conf` is active.
>
> **Sections 1–4 below are a HISTORICAL record of how that was done. Do not
> re-run them on the live VM.** Step 1 would re-issue a certificate that already
> exists (Let's Encrypt rate-limits this), and step 2 tells you to un-comment a
> 443 block that is already un-commented.
>
> They are kept because they are the rebuild procedure: if this VM is ever lost
> and rebuilt from scratch, follow them in order.
>
> **For routine work go to "Manual deploy procedure" and "Operations" below.**

---

### Corrections to earlier versions of this document (2026-07-28)

- The old warning that auto-deploy "points at the wrong folder
  (`/opt/ems-claims`)" is **stale** — `.github/workflows/deploy.yml` has used
  `DEPLOY_DIR: /opt/ems` for some time.
- Auto-deploy is nonetheless **still broken, for a different reason**: the
  workflow connects as `DEPLOY_USER: deploy`, and **that user does not exist on
  the VM** (`id deploy` → no such user; there is no `/home/deploy/.ssh`). Only
  `azureuser` exists. So every automated deploy fails at the SSH step.
- That failure is the *only* reason production survived a landmine: until
  2026-07-28 the workflow passed `--remove-orphans` to both compose files, which
  share one project name, so a successful run would have deleted every app
  container and not recreated them. The flag is gone now — but **fix the deploy
  user before re-enabling auto-deploy**, and watch the first run.
- A line in the manual deploy procedure used to copy an HTTP-only
  `nginx.conf.bak-2026-07-12` over the live config, which would have taken the
  site off TLS. Removed.

---

## 0. Pre-flight (laptop)
```powershell
nslookup portal.emsmca.co.za 8.8.8.8
```
- ✅ expect: `Address: 172.209.218.22` (**172**, not 127). If still 127 → DNS not fixed, stop.

SSH into the VM:
```powershell
ssh -i $HOME\.ssh\ems_vm azureuser@172.209.218.22
```
(All VM commands below need `sudo` for docker.)

---

## 1. Issue the SSL certificate
The port-80 server already answers the ACME challenge, so this just works once DNS is right:
```bash
cd /opt/ems
sudo docker compose -f docker-compose.prod.yml run --rm ems_certbot \
  certonly --webroot -w /var/www/certbot \
  -d portal.emsmca.co.za --agree-tos -m admin@emsmca.co.za --no-eff-email
```
- ✅ expect: `Successfully received certificate` at `/etc/letsencrypt/live/portal.emsmca.co.za/`.
- ❌ if it fails on "challenge did not pass": DNS not propagated yet, or port 80 blocked in the Azure NSG. Fix that, retry.

---

## 2. Turn HTTPS on in nginx
Edit `/opt/ems/nginx/nginx.conf`:
- **Un-comment** the whole `server { listen 443 ssl ... }` block at the bottom.
- (Optional but recommended) change the port-80 block's `location / { try_files ... }`
  to a redirect so http→https:  `return 301 https://$host$request_uri;`
  — but KEEP the `/.well-known/acme-challenge/` location above it for renewals.

Then reload:
```bash
sudo docker compose -f docker-compose.prod.yml restart ems_nginx
sudo docker logs ems_nginx --tail 20
```
- ✅ expect: no errors, nginx stays up. (The old "unhealthy" healthcheck should now pass too.)

---

## 3. Fix CORS / frontend URL for the domain (CRITICAL — or API calls break)
Edit `/opt/ems/.env.prod` and change:
```
FRONTEND_URL=https://portal.emsmca.co.za
CORS_ORIGINS=https://portal.emsmca.co.za
```
(You may keep the IP too during transition: `CORS_ORIGINS=https://portal.emsmca.co.za,http://172.209.218.22`)

Restart the backend so it re-reads the env:
```bash
sudo docker compose -f docker-compose.prod.yml up -d ems_backend
```
- ✅ expect: `ems_backend` recreates and comes back `healthy`.

---

## 4. Verify go-live (from your laptop)
```powershell
curl -I https://portal.emsmca.co.za            # ✅ 200, valid cert, no warning
curl -s https://portal.emsmca.co.za/health     # ✅ all healthy
```
Open `https://portal.emsmca.co.za` in a browser:
- ✅ padlock closed, EMS Claims Portal loads, **login works**, Digital PRF opens and submits.
- ✅ `http://` redirects to `https://` (if you added the redirect in Step 2).

---

## 5. After go-live (same day, not urgent)
- Restrict the **Google Maps API key** by HTTP referrer to `portal.emsmca.co.za` (Google Cloud Console).
- Cert auto-renews via the `ems_certbot` container (runs `certbot renew` every 12h) — no action.
- Optional cleanup: the crash-looping `ems_flower` (Flower isn't installed in the image) and the
  cosmetic "unhealthy" healthchecks — safe to leave, or fix later. They do NOT affect the app.

---

### Rollback (if HTTPS breaks the site)
```bash
sudo docker compose -f docker-compose.prod.yml logs --tail=50 ems_nginx   # read the error
# re-comment the 443 block in nginx.conf, then:
sudo docker compose -f docker-compose.prod.yml restart ems_nginx
```
Back to working HTTP while you diagnose. Send Claude the nginx logs.

---

## Manual deploy procedure (used 2026-07-12; repeat whenever deploying by hand)
After pushing from the laptop, on the VM:
```bash
cd /opt/ems
sudo git fetch origin main && sudo git reset --hard origin/main
# NOTE: a line here used to copy nginx.conf.bak-2026-07-12 over the live config.
# That backup is HTTP-ONLY (it predates HTTPS going live on 2026-07-13), so
# following this runbook verbatim would have taken the site off TLS. Removed
# 2026-07-28. The live config is nginx/nginx.conf from the repo — do not
# overwrite it from any .bak file.
sudo VITE_GOOGLE_MAPS_KEY="$(sudo grep -oP '(?<=VITE_GOOGLE_MAPS_KEY=).*' /opt/ems/.env.prod)" docker compose -f docker-compose.prod.yml up -d --build --force-recreate
sudo docker compose -f docker-compose.prod.yml exec -T ems_backend python -m alembic upgrade head   # ⚠️ MANDATORY — code + database must update together
sudo docker compose -f docker-compose.worker.yml up -d --build
curl -s http://localhost/health   # uptime_seconds must be small
```
- ⚠️ NEVER pass `--remove-orphans` to the **worker** compose command — it deletes the app containers (shared project name).
- Docker network `ems_db_net` must exist (`sudo docker network create ems_db_net` — already created 2026-07-12).
- Browser check needs Ctrl+F5, possibly Service-Worker unregister (PWA caching).

---

## Operations — backups, restore and the unattended safety net

Everything below is installed by one idempotent script. Re-run it after any
deploy; it is safe to run repeatedly:

```bash
sudo bash /opt/ems/deploy/ops/install-ops-crons.sh
```

It installs `/opt/ems/backup_ems.sh` **from version control** (the live copy had
previously been edited in place and drifted from the repo) and these jobs:

| When | Job | What it guarantees |
|---|---|---|
| 02:00 daily | `backup_ems.sh` | DB dump + uploads tarball; 14-day daily, 7-year monthly retention |
| 02:30 daily | `backup-offsite.sh` | Copies them to Azure Blob — **dormant until armed**, see below |
| 07:30 daily | `backup-verify.sh` | Asserts last night's backup exists, is fresh, non-trivial and valid |
| 04:17 daily | `nginx-cert-reload.sh` | Reloads nginx when certbot renews; warns under 14 days |
| Sun 05:00 | `restore-test.sh` | Actually restores the newest dump and compares it to production |
| Sun 03:40 | docker prune | Reclaims build cache so the root filesystem cannot fill |

### Arming the off-site copy (the one remaining data-loss risk)

Until this is done, every copy of the data — nightly dumps, the 7-year POPIA
archive, and every PRF attachment — exists only on this VM's disk.

1. Create a storage account and a **private** container (e.g. `ems-backups`).
2. Generate a **container SAS** with `Create + Write + List` and **not Delete**.
   A compromised VM must not be able to erase the off-site copies using the
   credential stored on it. Give it a long expiry — a SAS that quietly expires
   is a silent backup failure.
3. Add it to `/etc/default/ems-backup` (mode 600):
   ```
   AZURE_SAS_URL="https://ACCOUNT.blob.core.windows.net/ems-backups?sv=...&sig=..."
   ```
4. Prove it: `sudo /opt/ems/deploy/ops/backup-offsite.sh` — expect one
   `sent ... (verified)` line per file, then `OK: N file(s) verified off-site`.

### Alerting (backups can fail silently — they already did)

On 2026-07-18/19 the nightly backup produced no file *and no error line*, and
nobody noticed for 8 days. A script that never starts cannot report its own
failure, so the alert has to come from outside.

Create a free check at healthchecks.io and add its URL to the same file:
```
HEALTHCHECK_URL=https://hc-ping.com/your-uuid-here
```
`backup-verify.sh` and `backup-offsite.sh` both ping it on success and
`/fail` on failure. Because healthchecks.io alerts on a *missing* ping, this
also catches the VM being down entirely.

### Reading the results

```bash
sudo tail -20 /var/log/ems-backup-verify.log    # nightly backup health
sudo tail -30 /var/log/ems-restore-test.log     # weekly restore proof
sudo tail -20 /var/log/ems-backup-offsite.log   # off-site copy
```

`restore-test.sh` is the one that matters most. It restores into a throwaway
container on `--network none` (it cannot reach production) and only ever reads
live with SELECT. Its verdicts:
- `LOST <table>` — **emergency**: the backup has rows production is missing.
- `EMPTY <table>` — the dump has no rows for a table that live populates.
- `drift <table>` — normal; crews added records after the dump was taken.
- `content fingerprint MISMATCH` — finalised (non-DRAFT) PRFs differ between
  backup and live. Those are immutable, so this means either a corrupt dump or
  altered patient records. Proven to catch a single changed character.

## Known drift to resolve later (not needed for go-live)
- `deploy.yml` connects as `DEPLOY_USER: deploy`, which **does not exist** on the
  VM — fix before re-enabling auto-deploy (see corrections at the top).
- `ems_flower` crash-loops (Flower isn't installed in the image). Cosmetic; it is
  a monitoring UI, not part of the request path.
- nginx and celery_worker report `unhealthy` in `docker ps`. **These flags are
  false** — verify reality with `curl https://portal.emsmca.co.za/` (expect 200)
  and `docker exec ems_celery_worker celery -A app.tasks.celery_app inspect ping`
  (expect `pong`).

## ⚠️ Rebuilding the worker stack takes the SITE down until nginx is restarted

`docker compose -f docker-compose.worker.yml up -d --build` recreates the shared
`ems_shared_net`, which reassigns the BACKEND container a new IP. nginx resolves
its upstream once at startup and caches it, so it keeps proxying to the old
address and every request returns **502 Bad Gateway** — even though the backend
is up and healthy. This caused a ~4 minute production outage on 2026-07-28.

ALWAYS finish a worker-stack rebuild with:

```bash
sudo docker restart ems_nginx
curl -sk -o /dev/null -w "%{http_code}
" https://portal.emsmca.co.za/health   # expect 200
```

The same applies to anything that recreates the backend container or the shared
network. If you ever see a 502 while `docker ps` shows the backend healthy, this
is the cause and restarting nginx is the fix.
