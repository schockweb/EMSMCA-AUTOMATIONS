# 🚦 portal.emsmca.co.za — Go-Live Runbook (matches the LIVE VM)

Verified against the running VM on 2026-07-12. Deploy dir is **`/opt/ems`** (NOT
`/opt/ems-claims`). The live nginx already serves HTTP-only with the 443 block
commented out, so nothing crashes — we just issue the cert and switch HTTPS on.

Do this **in order** tomorrow, after the hosting company fixes the DNS typo.
Run each step, check its "✅ expect", and stop if anything looks different.

> ⚠️ Go live **MANUALLY** using the steps below. Do NOT rely on the GitHub
> auto-deploy — it points at the wrong folder (`/opt/ems-claims`) and would fail.
> Also don't push to `main` mid-go-live.

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

## Known drift to resolve later (not needed for go-live)
- Laptop repo (`8d42d1c`) ≠ VM (`76228d3`). Reconcile before pushing Digital PRF changes.
- `deploy.yml` `DEPLOY_DIR` is `/opt/ems-claims` but the real dir is `/opt/ems` — fix or the pipeline fails.
- `/opt/ems` is cluttered with one-off `fix_*.js` / `patch.*` / DB dumps — clean up when convenient.
