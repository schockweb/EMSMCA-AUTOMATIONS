# Migrating the live portal onto the client's Azure VM

**Written 2026-08-06.** This moves a RUNNING system carrying real patient records
— it is not a fresh install. For a brand-new instance with no data, use
`CLIENT-VM-INSTALL.md` instead.

## The shape of this migration

The whole build happens **in parallel, with zero downtime**, and the only
interruption is a short cutover window at the end. Three properties make that
possible:

- **The TLS certificate is a set of files and can be copied.** The current one is
  valid to 11 October 2026. Copying it means nginx starts on the new VM
  immediately, which removes the usual deadlock where the certificate needs DNS
  to point at the new server and the server needs the certificate to start.
- **The database is 46 MB and uploads are 524 KB.** Moving the data takes
  seconds, not hours.
- **The crew app is offline-first.** During the cutover window crews keep
  working; PRFs queue on the device and sync when the new server answers. A
  30-minute server outage is invisible to a crew at a roadside. This is the
  single biggest reason this migration is low-risk.

## The point of no return

**The first PRF written on the NEW system.** Until then, rolling back is
repointing DNS at the old VM. After it, rolling back loses that record.

Everything before Phase 3 is reversible by walking away.

---

## Phase 0 — Days before. No downtime, no Azure changes.

**0.1 Lower the DNS TTL.** Currently 1199 s (~20 min). Set it to **300 s** at
least a day ahead, so the cutover propagates in five minutes instead of twenty.

**0.2 Get `ENCRYPTION_KEY` where you can reach it.** From escrow / the password
manager, into a place you can paste from during the window.

> This is the one irreversible mistake available in this whole procedure. A
> **different** key does not error — it produces a perfectly working application
> in which every patient identifier reads back **empty**. Phase 2.8 verifies it
> before any of this matters.

**0.3 Create the healthchecks.io check** and keep the ping URL. This becomes
`HEALTHCHECK_URL`.

**0.4 Create the backup storage container and a SAS token.** Permissions must be
**Create + Write + List, and NOT Delete** — so a compromised VM cannot erase the
off-site copies using the credential stored on it. This becomes `AZURE_SAS_URL`.

**0.5 Decide the PostgreSQL networking mode and write it down.**

> **IRREVERSIBLE.** Public access vs VNet integration is fixed at server creation
> and cannot be changed afterwards without a full migration. Choose **VNet
> integration**.

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
disk and the backend has no Blob SDK, so this disk is the only copy of every PRF
attachment until `AZURE_SAS_URL` is armed.

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
these, or do them by hand. `.env.prod` comes from escrow and needs two edits:

- `DATABASE_URL` → the **new** PostgreSQL host
- `ENCRYPTION_KEY` → **the original value, unchanged**

**2.5 Copy the TLS certificate from the old VM.** This is what removes the
DNS/certificate deadlock:

```bash
ssh -i ~/.ssh/ems_vm azureuser@172.209.218.22 "sudo docker run --rm -v ems_certbot_certs:/c alpine tar czf - -C /c ." > certs.tar.gz
```

```bash
cat certs.tar.gz | ssh -i ~/.ssh/ems_vm azureuser@<NEW_IP> "sudo docker volume create ems_certbot_certs >/dev/null && sudo docker run --rm -i -v ems_certbot_certs:/c alpine tar xzf - -C /c"
```

**2.6 Copy the uploads volume** (first pass — repeated in the window):

```bash
ssh -i ~/.ssh/ems_vm azureuser@172.209.218.22 "sudo docker run --rm -v ems_upload_data:/d alpine tar czf - -C /d ." > uploads.tar.gz
```

```bash
cat uploads.tar.gz | ssh -i ~/.ssh/ems_vm azureuser@<NEW_IP> "sudo docker volume create ems_upload_data >/dev/null && sudo docker run --rm -i -v ems_upload_data:/d alpine tar xzf - -C /d"
```

**2.7 Render nginx for the domain** — `nginx.conf` hardcodes the hostname in
`server_name` **and** in both `ssl_certificate` paths, so on an unrendered config
nginx exits at startup and the cause is buried in a container log:

```bash
ssh -i ~/.ssh/ems_vm azureuser@<NEW_IP> "cd /opt/ems && sudo PORTAL_DOMAIN=portal.emsmca.co.za PORTAL_HOST_IP=<NEW_IP> PORTAL_ADMIN_EMAIL=admin@emsmca.co.za bash deploy/scripts/render-nginx.sh"
```

**2.8 Restore a recent dump — the rehearsal.** Take last night's dump from the old
VM, restore into the new database, and then run **the check that matters**:

```bash
ssh -i ~/.ssh/ems_vm azureuser@<NEW_IP> "sudo docker exec -e PYTHONPATH=/app ems_backend python encrypt_patient_ids.py --verify"
```

> **This is the gate.** It proves `ENCRYPTION_KEY` is the original by decrypting
> real records. If it reports mismatches, **STOP** — the key is wrong, and every
> patient identifier on the new system would read back blank. Nothing after this
> point is safe until it passes.

**2.9 Start the stack and verify on the IP, not the domain** (DNS still points at
the old VM, which is the point):

```bash
ssh -i ~/.ssh/ems_vm azureuser@<NEW_IP> "cd /opt/ems && sudo docker compose -f docker-compose.prod.yml up -d --build && sudo docker compose -f docker-compose.worker.yml up -d --build && sudo docker restart ems_nginx && sleep 10 && curl -sk -o /dev/null -w 'health: %{http_code}\n' https://localhost/health"
```

**2.10 Security probes** — each corresponds to something that was once broken:

```bash
ssh -i ~/.ssh/ems_vm azureuser@<NEW_IP> "for p in /api/mock-scheme/oauth/token /docs /openapi.json /api/metrics; do printf '%-32s %s\n' \$p \$(curl -sk -o /dev/null -w '%{http_code}' https://localhost\$p); done"
```

Expect 403/404 on every one.

**2.11 Ops cover, before go-live not after:**

```bash
ssh -i ~/.ssh/ems_vm azureuser@<NEW_IP> "sudo bash /opt/ems/deploy/ops/install-ops-crons.sh && echo 'AZURE_SAS_URL=<url>' | sudo tee -a /etc/default/ems-backup"
```

Add `HEALTHCHECK_URL=<url>` to `.env.prod`. Then prove the backup path works
end-to-end **before** you depend on it:

```bash
ssh -i ~/.ssh/ems_vm azureuser@<NEW_IP> "sudo bash /opt/ems/backup_ems.sh && sudo bash /opt/ems/deploy/ops/restore-test.sh"
```

**2.12 Tag the release**, so there is a rollback point from minute one:

```bash
ssh -i ~/.ssh/ems_vm azureuser@<NEW_IP> "sudo bash /opt/ems/deploy/ops/tag-release.sh"
```

**At the end of Phase 2 you have a complete, working, verified parallel system
and have changed nothing for users.** If anything above failed, you stop here and
nobody is affected.

---

## Phase 3 — Cutover. The only downtime. Budget 30 minutes.

Pick a low-volume hour. Crews keep working throughout — the PWA queues on device.

**3.1 Stop writes on the OLD system.** This is what makes the final dump
authoritative:

```bash
ssh -i ~/.ssh/ems_vm azureuser@172.209.218.22 "cd /opt/ems && sudo docker compose -f docker-compose.prod.yml stop ems_backend ems_nginx"
```

**3.2 Final database dump** from the old server, **3.3 final uploads copy**
(repeat 2.6), **3.4 restore both** onto the new system.

**3.5 Verify before you commit to it** — row counts and content, not just "it
restored":

```bash
ssh -i ~/.ssh/ems_vm azureuser@<NEW_IP> "sudo docker exec -e PYTHONPATH=/app ems_backend python encrypt_patient_ids.py --verify && sudo docker exec -e PYTHONPATH=/app ems_backend python -c \"
import asyncio
from sqlalchemy import text
from app.database import engine
async def m():
    async with engine.connect() as c:
        for t in ('digital_prfs','cases','claims','crew_members','service_providers','users'):
            print(f'  {t:20}', (await c.execute(text(f'select count(*) from {t}'))).scalar())
asyncio.run(m())\""
```

Compare those counts against the old system. They must match exactly.

**3.6 Migrations** (expected to be a no-op — the dump carries the schema):

```bash
ssh -i ~/.ssh/ems_vm azureuser@<NEW_IP> "cd /opt/ems && sudo docker compose -f docker-compose.prod.yml exec -T ems_backend python -m alembic upgrade head"
```

**3.7 Restart the new stack and confirm health 200.**

**3.8 Repoint DNS** — the A record for `portal.emsmca.co.za` → `<NEW_IP>`. With
TTL at 300 s this takes about five minutes.

**3.9 Verify from outside**, not from the VM:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://portal.emsmca.co.za/health
```

Then log in as a real user and open a real PRF. **Do not declare success on a
health endpoint.**

---

## Phase 4 — After

- **Keep the old VM stopped but intact for 7 days.** Rollback is repointing DNS
  back and starting it. That option is only real while the new system has taken
  no writes you would miss.
- Watch `CPU Credits Remaining` on the new VM for the first week — it is the one
  burstable signal that in-guest tools cannot see.
- Confirm the first automated backup and the first Sunday restore rehearsal both
  fire and report to healthchecks.io.
- Only then decommission the old VM.

---

## If it goes wrong

| Symptom | Cause | Action |
|---|---|---|
| nginx exits at startup | config not rendered, or certificate missing | re-run 2.7, confirm 2.5 copied the volume |
| Backend cannot reach the database | Azure firewall / VNet not allowing the VM | the most common failure on this path |
| Patient identifiers all blank | **wrong `ENCRYPTION_KEY`** | STOP. Restore the correct key. Do not write anything. |
| Connection errors under load | `max_connections` pinned to 200 | remove the pin (1.2) |
| Everything 502s but containers are healthy | nginx cached the old backend IP | `docker restart ems_nginx` |
| Site down after DNS change | propagation, or the new stack was not actually up | repoint DNS to the old IP, start the old stack |
