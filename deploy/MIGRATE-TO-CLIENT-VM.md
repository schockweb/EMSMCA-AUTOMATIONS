# Standing the portal up on the client's Azure VM

**Written 2026-08-06. Revised 2026-08-06 — no data is carried over.**

This builds a **clean instance** on the client's Azure subscription. The current
VM (`172.209.218.22`) holds pilot data only, and by decision none of it moves.
The new system starts with an empty database, an empty uploads volume, and
freshly generated keys.

## What is NOT carried over — explicitly

| From the current VM | Carried? | |
|---|---|---|
| Database (PRFs, cases, claims, patients) | **No** | Pilot/test data. New database starts empty. |
| Uploads volume (PRF attachments) | **No** | Belongs to the pilot records. Starts empty. |
| User, crew and provider accounts | **No** | Recreated deliberately — see 2.9 and 3.1. |
| `ENCRYPTION_KEY` / `SECRET_KEY` | **No** | **Newly generated.** See 0.2. |
| Backup archives / dumps | **No** | Nothing to restore. Backups start fresh on the new box. |
| TLS certificate files | **Yes** | The only thing copied. Not data — see 2.5. |

There is therefore **no dump, no restore, no row-count reconciliation and no
cutover freeze** in this procedure. Everything that used to make this a migration
is gone; what is left is an install plus a DNS change.

> **The pilot data is not merely unnecessary — it must be kept out.** The last
> known contamination of the live database was 19 rows written by a test run on
> 2026-07-28. A fresh instance whose first PRF is a real one is a materially
> better position than the current VM is in, and that advantage is lost the
> moment anything is copied across "just in case".

## What this buys, beyond a clean database

The previous version of this document carried one irreversible mistake: reusing
the original `ENCRYPTION_KEY` on the new box. A **wrong** key does not error — it
produces a perfectly working application in which every patient identifier reads
back empty. That entire failure mode disappears when there is nothing encrypted
to read. **Generate new keys.**

## The one thing that is not on the VM

`portal.emsmca.co.za` stays the same hostname, so **the browser origin does not
change** — and the crew app keeps state in that origin, on the device:

- the offline outbox (IndexedDB `ems-offline` / `outbox`), which
  `services/offlineDb.ts` states plainly is *"not cleared on End Shift or
  logout"*, and whose `dead` entries are never deleted;
- PRF drafts and `crew_profile` / `crew_token` in `localStorage`;
- the PWA service worker's cached app shell.

A device that was used during the pilot can therefore still hold queued pilot
PRFs. When that device next gets a working crew session — against the **new**
server — `syncEngine` drains the outbox, and because the new database has no such
row, its 404 self-heal **creates** the PRF. Pilot data would arrive in the clean
production database through the front door, correctly authorised, on day one.

**So the device purge in 3.1 is not housekeeping. It is the step that makes "no
data carried over" actually true.** The VM side of this is easy; the device side
is the part that gets forgotten.

## The point of no return

**The first real PRF written by a crew on the new system.** Until then, rolling
back is repointing DNS at the old VM. After it, rolling back loses that record.

Everything before Phase 3 is reversible by walking away.

---

## Phase 0 — Days before. No downtime, no Azure changes.

**0.1 Lower the DNS TTL.** Currently 1199 s (~20 min). Set it to **300 s** at
least a day ahead, so the cutover propagates in five minutes instead of twenty.

**0.2 Generate the new keys** and put them in the password manager *before* they
are used anywhere:

```bash
python -c "import secrets; print('SECRET_KEY=' + secrets.token_urlsafe(48))"
```

```bash
python -c "from cryptography.fernet import Fernet; print('ENCRYPTION_KEY=' + Fernet.generate_key().decode())"
```

> `ENCRYPTION_KEY` is set **once and never changed** — it protects patient
> identifiers at rest. It is now the only irreversible value in the build, and
> losing it after go-live is unrecoverable in a way that losing it today is not.
> Escrow it the day you generate it, not the week after.
>
> A new `SECRET_KEY` invalidates every token ever issued by the old system. That
> is intended: every crew and admin signs in again after cutover. Expect 401s
> from devices that were logged in during the pilot — that is the guard working,
> not a fault.

**0.3 Create the healthchecks.io check** and keep the ping URL. This becomes
`HEALTHCHECK_URL`.

**0.4 Create the backup storage container and a SAS token.** Permissions must be
**Create + Write + List, and NOT Delete** — so a compromised VM cannot erase the
off-site copies using the credential stored on it. This becomes `AZURE_SAS_URL`.

**0.5 Decide the PostgreSQL networking mode and write it down.**

> **IRREVERSIBLE.** Public access vs VNet integration is fixed at server creation
> and cannot be changed afterwards without a full migration. Choose **VNet
> integration**.

**0.6 Tell the crews.** They need to know that (a) they will be signed out and
must log in again, and (b) any PRF still sitting unsynced on a device at cutover
is a pilot record and will be discarded with the rest. If a device is holding
something a crew actually wants, it has to sync **before** Phase 3, to the old
system, and be exported from there — it will not survive the purge.

---

## Phase 1 — Provision Azure. No downtime.

Run as the client-subscription Contributor. Region: **South Africa North**.

```bash
az group create --name rg-ems-prod --location southafricanorth
```

**1.1 Network** — a VNet with a subnet delegated to PostgreSQL:

```bash
az network vnet create --resource-group rg-ems-prod --name vnet-ems --location southafricanorth --address-prefix 10.20.0.0/16 --subnet-name snet-app --subnet-prefix 10.20.1.0/24
```

```bash
az network vnet subnet create --resource-group rg-ems-prod --vnet-name vnet-ems --name snet-pg --address-prefix 10.20.2.0/24 --delegations Microsoft.DBforPostgreSQL/flexibleServers
```

**1.2 PostgreSQL Flexible Server.** General Purpose, 2 vCore, VNet-integrated,
PostgreSQL 18 to match the current server:

```bash
az postgres flexible-server create --resource-group rg-ems-prod --name ems-db-client --location southafricanorth --tier GeneralPurpose --sku-name Standard_D2ds_v5 --version 18 --storage-size 128 --backup-retention 35 --geo-redundant-backup Enabled --vnet vnet-ems --subnet snet-pg --admin-user emsadmin
```

> **Do NOT set `max_connections` to 200.** `infra/DEPLOY-AZURE.md:155` contains
> that command and it is wrong: the application opens up to 200 connections from
> the web tier alone (4 workers × pool 20 + overflow 30) before Celery, and Azure
> reserves ~15 for management. Leave the tier default (859).

**1.3 The VM.** Note `--os-disk-type Premium_LRS` — this is what lifts the
single-VM SLA from 99.5% to 99.9%, and it is the cheapest availability
improvement available:

```bash
az vm create --resource-group rg-ems-prod --name vm-ems-prod --location southafricanorth --image Ubuntu2404 --size Standard_B4s_v2 --os-disk-size-gb 128 --os-disk-type Premium_LRS --zone 1 --public-ip-sku Standard --admin-username azureuser --ssh-key-values ~/.ssh/ems_vm.pub
```

**1.4 Firewall.** 80 and 443 to the world; **22 to your address only**:

```bash
az vm open-port --resource-group rg-ems-prod --name vm-ems-prod --port 80,443 --priority 1000
```

```bash
az network nsg rule create --resource-group rg-ems-prod --nsg-name vm-ems-prodNSG --name ssh-admin-only --priority 900 --protocol Tcp --destination-port-ranges 22 --source-address-prefixes "$(curl -s -4 ifconfig.me)/32" --access Allow
```

**1.5 Azure Backup on the VM.** Not optional — the uploads volume lives on this
disk and the backend has no Blob SDK, so from the first real attachment onward
this disk is the only copy of it until `AZURE_SAS_URL` is armed.

---

## Phase 2 — Build the new VM in parallel. Still no downtime.

The old system keeps serving throughout Phase 2.

**2.1 Readiness check:**

```bash
ssh -i ~/.ssh/ems_vm azureuser@<NEW_IP> "sudo bash /opt/ems/deploy/ops/rebuild-vm.sh --check"
```

(It will report the repo is absent — that is expected on a bare VM. Run it again
after 2.3.)

**2.2 Docker, 2.3 clone, 2.4 configuration.** `rebuild-vm.sh --run` performs
these, or do them by hand. Build `.env.prod` from `.env.prod.template` — **not**
from the old VM's file — and fill in every `CHANGE_ME`, including:

- `DATABASE_URL` → the **new** PostgreSQL host
- `SECRET_KEY`, `ENCRYPTION_KEY` → **the new values from 0.2**
- `APP_ENV=production` — this also stops the mock scheme server (which answers
  unauthenticated and always approves) from being mounted

> The backend refuses to start in production if either key is a placeholder or
> shorter than 32 characters. That guard exists because neither key fails loudly
> on its own — an instance installed from the template unedited would have worked
> perfectly, signing tokens with a key published in our own example file.

**2.5 Copy the TLS certificate from the old VM.** This is the only thing taken
from the old box. It is a certificate for a domain the client owns, not data, and
copying it removes the deadlock where the certificate needs DNS to point at the
new server and nginx needs the certificate to start:

```bash
ssh -i ~/.ssh/ems_vm azureuser@172.209.218.22 "sudo docker run --rm -v ems_certbot_certs:/c alpine tar czf - -C /c ." > certs.tar.gz
```

```bash
cat certs.tar.gz | ssh -i ~/.ssh/ems_vm azureuser@<NEW_IP> "sudo docker volume create ems_certbot_certs >/dev/null && sudo docker run --rm -i -v ems_certbot_certs:/c alpine tar xzf - -C /c"
```

> Valid to 11 October 2026; certbot on the new VM renews it from then on.
>
> **If you would rather take nothing at all from the old VM**, skip this and
> issue a fresh certificate with `deploy/CLIENT-VM-INSTALL.md` §4 — but that
> can only run *after* DNS points at the new IP, which means the site is
> unreachable over HTTPS for the few minutes in between, and it moves the whole
> verification step in 2.10 to after the cutover instead of before it. Copying
> the certificate is the lower-risk option; issuing fresh is the cleaner one.

**2.6 Nothing to copy.** The uploads volume starts empty and Docker creates it on
first run. *(This step is retained deliberately, so its absence reads as a
decision rather than an omission.)*

**2.7 Render nginx for the domain** — `nginx.conf` hardcodes the hostname in
`server_name` **and** in both `ssl_certificate` paths, so on an unrendered config
nginx exits at startup and the cause is buried in a container log:

```bash
ssh -i ~/.ssh/ems_vm azureuser@<NEW_IP> "cd /opt/ems && sudo PORTAL_DOMAIN=portal.emsmca.co.za PORTAL_HOST_IP=<NEW_IP> PORTAL_ADMIN_EMAIL=admin@emsmca.co.za bash deploy/scripts/render-nginx.sh"
```

**2.8 Create the schema on the empty database:**

```bash
ssh -i ~/.ssh/ems_vm azureuser@<NEW_IP> "cd /opt/ems/backend && sudo docker compose -f ../docker-compose.prod.yml run --rm ems_backend python bootstrap_schema.py"
```

```bash
ssh -i ~/.ssh/ems_vm azureuser@<NEW_IP> "cd /opt/ems/backend && sudo docker compose -f ../docker-compose.prod.yml run --rm ems_backend python bootstrap_schema.py --apply"
```

> **Do not run `alembic upgrade head` first.** It cannot build this schema from
> nothing: the initial revision was autogenerated against an already-populated
> database and committed with an empty body, so on an empty database the chain
> dies on the first `ALTER` with `relation "cases" does not exist`.
> `bootstrap_schema.py` creates the tables from the ORM models and stamps Alembic
> at head; it refuses to touch a database that already has tables. After this,
> every future release upgrades normally.
>
> This replaces the old 2.8, which restored a dump and then verified the
> encryption key against real records. There is nothing to restore and nothing
> encrypted yet, so that gate no longer exists.

**2.9 Create the accounts, in this order.** Seeding is disabled outside
development, so there is no default account and no default password to change.
This whole sequence was rehearsed end to end against an empty database on
2026-08-06 and every step below is what actually worked:

```bash
cd /opt/ems/backend && ADMIN_PASSWORD='<chosen>' python create_admin.py --email admin@<client> --from-env
```

Then, through the application rather than the database:

1. **Provider** — including `portal_login_email` and `portal_login_password`.
   That password is the company-wide device unlock; **without it no crew can
   start a shift**, and the error message is the same whether it is wrong or
   unset, so a crew guessing gets no diagnostic.
2. **`prf_start_number`** — see the warning below. Set it *before* the first
   call, not after.
3. **Crew members** — HPCSA number is the identifier and must be unique per
   provider.
4. **Vehicles** — one record per ambulance that will actually run. A second
   crew cannot start a shift on a fleet of one; the shift wizard only lists
   vehicles the server returns.

> **PRF numbering starts at 1 on an empty database.** The next number is
> `max(highest existing, prf_start_number) + 1`, and it is baked into the case
> number, so it appears on the clinical document itself. If the provider is
> carrying on from a paper book that ended at 23, set `prf_start_number` to 23
> and the first digital PRF is 24. Get this wrong and the correction is not
> retrospective — issued numbers stay issued.

> `PARAMEDIC` is the default role for a new account and has no
> provider-administration access. Grant `SUPER_ADMIN` to one or two people only,
> and create a **second** administrative account — a day-one lockout on a single
> credential leaves the system unadministrable during a live shift.

**Verify the whole chain before you trust it**, in this order: device unlock
returns a grant → the crew and vehicle lists come back non-empty → a shift
starts → a PRF creates, saves and submits. Each step gates the next, so testing
only the last one tells you nothing about why it failed.

> **`/health` returns 503 until a Celery worker is attached** — it reports
> `celery_workers: no active workers` and the whole endpoint goes amber. Bring
> up `docker-compose.worker.yml` before treating a 503 as a fault. This also
> matters for the record itself: **submit hands off to Celery**, so with no
> worker a PRF submits successfully and no case, claim or document is ever
> created. The 202 response does not mean the billing pipeline ran.

**2.10 Start the stack and verify on the IP, not the domain** (DNS still points at
the old VM, which is the point):

```bash
ssh -i ~/.ssh/ems_vm azureuser@<NEW_IP> "cd /opt/ems && sudo docker compose -f docker-compose.prod.yml up -d --build && sudo docker compose -f docker-compose.worker.yml up -d --build && sudo docker restart ems_nginx && sleep 10 && curl -sk -o /dev/null -w 'health: %{http_code}\n' https://localhost/health"
```

**2.11 Prove the database is clean.** With no migration, the check inverts: the
counts must be **zero**, not equal to the old system.

```bash
ssh -i ~/.ssh/ems_vm azureuser@<NEW_IP> "sudo docker exec -e PYTHONPATH=/app ems_backend python -c \"
import asyncio
from sqlalchemy import text
from app.database import engine
async def m():
    async with engine.connect() as c:
        for t in ('digital_prfs','cases','claims','patients','documents'):
            print(f'  {t:20}', (await c.execute(text(f'select count(*) from {t}'))).scalar())
asyncio.run(m())\""
```

Every one of those must read **0**. Anything non-zero means something was
imported or something was run against this database that should not have been.

> **Never point the test suite at this database.** `conftest.py` refuses a
> non-local `DATABASE_URL` for exactly this reason — a test run against
> production wrote 19 rows into the live patient database on 2026-07-28. That
> guard is the only reason the number above can be trusted.

**2.12 Security probes** — each corresponds to something that was once broken:

```bash
ssh -i ~/.ssh/ems_vm azureuser@<NEW_IP> "for p in /api/mock-scheme/oauth/token /docs /openapi.json /api/metrics; do printf '%-32s %s\n' \$p \$(curl -sk -o /dev/null -w '%{http_code}' https://localhost\$p); done"
```

Expect 403/404 on every one.

**2.13 Ops cover, before go-live not after:**

```bash
ssh -i ~/.ssh/ems_vm azureuser@<NEW_IP> "sudo bash /opt/ems/deploy/ops/install-ops-crons.sh && echo 'AZURE_SAS_URL=<url>' | sudo tee -a /etc/default/ems-backup"
```

Add `HEALTHCHECK_URL=<url>` to `.env.prod`. Then prove the backup path works
end-to-end **before** you depend on it:

```bash
ssh -i ~/.ssh/ems_vm azureuser@<NEW_IP> "sudo bash /opt/ems/backup_ems.sh && sudo bash /opt/ems/deploy/ops/restore-test.sh"
```

> On an empty database this proves the *mechanism* — dump, upload, restore,
> compare — and nothing about content, because there is no content. Re-run it
> once real PRFs exist; that is the run that actually means something.

**2.14 Tag the release**, so there is a rollback point from minute one:

```bash
ssh -i ~/.ssh/ems_vm azureuser@<NEW_IP> "sudo bash /opt/ems/deploy/ops/tag-release.sh"
```

**At the end of Phase 2 you have a complete, working, verified parallel system
and have changed nothing for users.** If anything above failed, you stop here and
nobody is affected.

---

## Phase 3 — Cutover. Budget 30 minutes.

Pick a low-volume hour. There is no database freeze and no final copy — the work
here is the device purge and a DNS change.

**3.1 Purge the crew devices — AFTER 3.4, not before.** Full instructions for
whoever holds the tablets: `CREW-DEVICE-RESET.md`.

> **Order corrected 2026-08-06.** The purge must happen **after DNS moves** and
> before the first crew login, with the app kept CLOSED on every device in
> between. Purging the night before looks tidier and is wrong: the device then
> caches the OLD server's bundle and comes up one build behind on the new one.
> The asset hash differs between the two (`index-v3t07HlH.js` on the old build,
> `index-Ey6WBrVW.js` on the new), which is exactly the staleness the purge was
> meant to remove. Purging after the cutover clears the old outbox AND fetches
> the current app in one action.
>
> "Closed" is doing real work in that sentence. A device merely *opened* against
> the new server before being purged has already drained its outbox — the purge
> afterwards is too late.

Do this on **every** device that was used during the pilot, before it is allowed
to reach the new system. Until a device is purged, keep it signed out.

On the device, in the browser: **Settings → Site settings →
`portal.emsmca.co.za` → Delete data** (Chrome/Android), or **Settings → Safari →
Advanced → Website Data → remove `portal.emsmca.co.za`** (iOS). For an installed
PWA, uninstall it and reinstall after 3.4.

This clears the IndexedDB outbox, the drafts, the crew session and the service
worker cache in one action. Confirm on the device afterwards, before the shift:

```text
Application → Storage → IndexedDB → ems-offline   (must be absent)
```

> Skipping this on a single tablet is enough to put a pilot PRF into the clean
> production database — see "The one thing that is not on the VM" above. A device
> that cannot be purged should not be used until it has been.

**3.2 Stop the old stack.** Not to freeze writes — there is nothing to preserve —
but so that a device that slips past 3.1 has nothing to sync to, and so a stale
DNS cache fails visibly rather than silently accepting work into a system that is
about to be discarded:

```bash
ssh -i ~/.ssh/ems_vm azureuser@172.209.218.22 "cd /opt/ems && sudo docker compose -f docker-compose.prod.yml stop ems_backend ems_nginx"
```

**3.3 Confirm the new stack is healthy** on its IP (repeat 2.10's health check)
and that 2.11 still reads zero.

**3.4 Repoint DNS** — the A record for `portal.emsmca.co.za` → `<NEW_IP>`. With
TTL at 300 s this takes about five minutes.

**3.5 Verify from outside**, not from the VM:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://portal.emsmca.co.za/health
```

**3.6 Then log in as a real user and complete one real PRF end to end.** Sign in
on a purged device, create it, submit it, and confirm it appears in the admin
queue with the correct provider. **Do not declare success on a health endpoint.**

That PRF is the point of no return.

---

## Phase 4 — After

- **Keep the old VM stopped but intact for 7 days.** Rollback is repointing DNS
  back and starting it — worth having while DNS and certificates settle, even
  though there is no data on it worth recovering.
- **Re-check the clean-database count after the first day** (2.11 again). It
  should equal the number of real calls, and nothing more. A jump that nobody can
  account for is an unpurged device.
- Watch `CPU Credits Remaining` on the new VM for the first week — it is the one
  burstable signal that in-guest tools cannot see.
- Confirm the first automated backup and the first Sunday restore rehearsal both
  fire and report to healthchecks.io, and re-run `restore-test.sh` once there are
  real PRFs so the content comparison means something.
- **Then decommission the old VM and delete its disks and backups.** Its data is
  pilot data; leaving copies of it lying around only creates something else to
  have to account for.

---

## If it goes wrong

| Symptom | Cause | Action |
|---|---|---|
| nginx exits at startup | config not rendered, or certificate missing | re-run 2.7, confirm 2.5 copied the volume |
| Backend cannot reach the database | Azure firewall / VNet not allowing the VM | the most common failure on this path |
| `relation "cases" does not exist` | `alembic upgrade head` was run on the empty database | drop and recreate the database, then use `bootstrap_schema.py` (2.8) |
| PRFs appear that nobody created | an unpurged device drained its pilot outbox | purge it (3.1); delete those PRFs before they reach a claim |
| Everyone is signed out after cutover | new `SECRET_KEY` — expected | sign in again |
| Connection errors under load | `max_connections` pinned to 200 | remove the pin (1.2) |
| Everything 502s but containers are healthy | nginx cached the old backend IP | `docker restart ems_nginx` |
| Site down after DNS change | propagation, or the new stack was not actually up | repoint DNS to the old IP, start the old stack |
| Patient identifiers read back blank | `ENCRYPTION_KEY` was changed **after** go-live | restore the key from escrow. It is set once, in 0.2, and never again. |
