# Infrastructure handover — EMSMCA claims portal

**Prepared 2026-08-07.** For the hosting provider taking on infrastructure,
security and backup responsibility for `portal.emsmca.co.za`.

## What this system is

A South African emergency medical services claims platform. Ambulance crews
complete Patient Report Forms on tablets; the platform adjudicates and submits
the resulting insurance claims.

It holds **patient health information**: identifiers, clinical observations,
treatment and medication administered. It is subject to **POPIA**. Patient
identifiers are encrypted at rest at the application layer.

Two consequences worth stating up front:

- **Availability is clinical, not commercial.** Crews capture records at the
  roadside. The app is offline-first, so a short outage is survivable — forms
  queue on the device — but a prolonged one blocks handover documentation.
- **A data loss is a reportable event**, not merely an inconvenience.

---

## The environment as handed over

Azure subscription `a6f0c604-accb-4f57-9270-21e82b198c3e`, region **South
Africa North**, resource group **`rg-ems-prod`**.

| Component | Detail |
|---|---|
| VM | `vm-ems-prod`, Standard_D4as_v5 (4 vCPU / 16 GB), Ubuntu 24.04 LTS, Zone 1 |
| OS disk | 128 GB **Premium_LRS** — this is what carries the 99.9% single-VM SLA rather than 99.5% |
| Database | `ems-db-client`, PostgreSQL **Flexible Server 18.4**, Standard_D2ds_v5, General Purpose |
| Database network | **VNet-integrated, no public endpoint.** Reachable only from `snet-pg` |
| Database backups | 35-day retention, **geo-redundant**, configured at creation |
| Network | VNet `vnet-ems` (10.20.0.0/16); `snet-app` for the VM, `snet-pg` delegated to PostgreSQL |
| Runtime | Docker containers: nginx, FastAPI backend, Celery worker, Celery beat, Redis, RabbitMQ, certbot |
| TLS | Let's Encrypt, `portal.emsmca.co.za`, **expires 11 October 2026** |

Deliberately **not** burstable: a B-series VM throttles once CPU credits are
exhausted, and Azure does not expose the Linux steal clock, so the throttling
is invisible from inside the guest. A constant-performance SKU removes a
failure mode that cannot be observed.

---

## What has already been done

Verified on the VM as handed over, not assumed:

**Network**
- NSG: 80 and 443 open to the internet; **22 restricted to a single admin IP**
- Backend application port is not published to the host — only nginx is
- Database has no public endpoint at all

**Host**
- SSH: **key-only** (`passwordauthentication no`), **root login disabled**,
  `MaxAuthTries 3`, X11 forwarding off
- `fail2ban` active — 1 hour ban after 4 failed SSH attempts
- Outstanding security updates applied; no reboot pending at handover
- Docker log rotation bounded (50 MB × 5) so a runaway container log cannot
  fill the disk

**Application**
- `APP_ENV=production`, which also un-mounts a mock scheme API used in
  development
- API documentation endpoints (`/docs`, `/redoc`, `/openapi.json`) and
  `/api/metrics` return 403
- Freshly generated signing and encryption keys — nothing reused from any
  previous environment
- Database connection requires TLS; the application refuses to start in
  production without it
- Rate limiting on authentication and API endpoints

**Recovery**
- Release images are tagged per deployment; a rollback is an image tag swap
  measured in seconds (`deploy/ops/rollback.sh`). Note there is currently only
  **one** tagged release, so there is nothing earlier to roll back to yet
- Nightly database dump, weekly restore rehearsal, off-site copy and
  certificate reload are installed as scheduled jobs (`/etc/cron.d/ems-*`)
- A first dump has been taken and **restored** — the weekly rehearsal was run
  by hand and reported
  `OK: ...sql.gz restores cleanly and its records match production`. That is
  the only evidence that distinguishes a backup from a file, and it is the one
  claim here that has actually been exercised end to end

> **Expect `backup-verify` to FAIL nightly until real data exists — this is
> not a fault.** The job refuses any dump under 100 KB as a truncation guard.
> The current dump is legitimately ~15 KB because the database is nearly
> empty, so the check reports:
> `FAIL: newest dump is only 14716 bytes (min 102400) — truncated`
>
> It will start passing on its own once the database carries real records. We
> are calling it out because it is the first thing you will see, and an alarm
> that cries wolf on day one teaches everyone to ignore the channel that
> matters. If it is still failing once the platform is carrying live claims,
> that IS a real fault and should be escalated.

> **Corrected 2026-08-07, and worth reading as a warning.** An audit of this VM
> found that the nightly backup job had never been installed. The installer
> creates the backup *script*, the off-site copy job, the verification job and
> the weekly restore rehearsal — but not the cron that actually **takes** the
> backup. Every job policing backups was running; the job making them was not,
> and each of those jobs reported healthy because it had nothing to complain
> about. The previous server only worked because that cron file had been
> created by hand months earlier.
>
> It is fixed here, and a first dump has been produced and confirmed. We are
> flagging it because it is the exact failure mode this handover is meant to
> prevent: **a monitoring stack that is green because it is measuring nothing.**
> Please treat "the backup job reported success" as a claim to verify rather
> than accept — check that a dated file actually exists and grows.

---

## Open items — these are the handover asks

Listed in the order we would do them.

### 1. Off-site backup copy — the highest-value item

Backups currently exist **only on the VM's own disk**. The database itself is
safe: Azure-managed, off-box, geo-redundant. But the **uploads volume**, which
holds PRF attachments, exists nowhere else. If the VM is lost today, those
attachments are lost permanently.

What is needed:

- A **private storage container** for backups
- A **container SAS token** with **Create + Write + List — and NOT Delete**

That last point is deliberate and we would ask you not to simplify it. The
credential is stored on the VM. Without Delete, an attacker who compromises the
VM can add backups but cannot erase the off-site copies. With Delete, the
off-site copy protects against hardware failure but not against an intruder.

Enable **soft-delete and versioning** on the container so an overwrite is
recoverable.

Once you provide the SAS URL, arming and *proving* it is one command on the VM:

```
sudo bash /opt/ems/deploy/ops/arm-monitoring.sh --sas '<url>'
```

It writes a probe blob, reads it back, lists the container, and then attempts a
delete **that must fail**. If the delete succeeds, the SAS is over-permissioned
and it says so.

### 2. Azure Backup on the VM

Not currently configured. The uploads volume lives on this disk, so disk-level
backup is the second line of defence behind item 1.

### 3. Alerting — nothing currently alerts on anything

A failed backup, a failed restore rehearsal, or the site going down produces no
notification today. We would like you to own this. Either your own monitoring,
or an external uptime check whose ping URL we wire in:

```
sudo bash /opt/ems/deploy/ops/arm-monitoring.sh --healthcheck '<url>'
```

The application exposes `https://portal.emsmca.co.za/health`, which returns
JSON reporting the API, database, message broker, worker and queue state. It
returns non-200 if any dependency is unhealthy, so it is suitable as an uptime
probe.

### 4. Certificate renewal

The certificate was copied from the previous server and expires **11 October
2026**. A certbot container and a reload job are present, but renewal has not
yet been observed to succeed on this VM. Please verify a renewal actually
completes well before October — a silent failure takes the whole site down.

### 5. OS patching and reboot policy

Unattended security updates are available but a patching cadence and a reboot
window are a policy decision. Kernel updates require a reboot, which is a brief
outage — it should be scheduled deliberately, at a low-volume hour, not left to
fire unattended.

### 6. Access management

At handover, SSH is restricted to one administrator IP and one key. Please take
ownership of who holds access, and rotate the key if staff change. We would ask
that SSH access is never widened to the internet, even temporarily.

### 7. Worth considering

- **Azure DDoS protection / WAF** in front of the site
- **Log retention** off the VM for incident investigation
- **A second availability zone or warm standby.** Today this is a single VM: a
  zone failure costs availability, though not records, because the database is
  managed and off-box

---

## Division of responsibility, as we understand it

| Area | Owner |
|---|---|
| Application code, deployments, database schema | **EMSMCA** |
| Application authentication, roles, encryption keys | **EMSMCA** |
| Application security patching, dependency updates | **EMSMCA** |
| VM, OS patching, host hardening | **Hosting provider** |
| Network, firewall, NSG rules | **Hosting provider** |
| Backups, off-site copies, restore testing | **Hosting provider** |
| Monitoring, alerting, incident response | **Hosting provider** |
| TLS certificate lifecycle | **Hosting provider** |
| DNS | **Hosting provider** |

Encryption keys stay with EMSMCA and are held in escrow. `ENCRYPTION_KEY`
protects patient identifiers at rest and **cannot be regenerated** — if it is
lost, every patient identifier in the database becomes permanently unreadable.
It is not stored anywhere outside the VM's configuration file and our escrow.

---

## Two things we would ask you to read before changing anything

**Restarting containers is not free.** Crews may be mid-shift. The application
tolerates it — the tablets queue and re-sync — but please schedule restarts
rather than treating them as routine.

**A backup that has never been restored is not a backup.** A restore rehearsal
job is installed and runs weekly. Please treat a failure of that job as a real
incident rather than noise; it is the only thing that distinguishes a backup
from a file.

---

## Contact and escalation

Application faults, deployment questions, anything inside the containers →
EMSMCA. Host, network, backup and certificate matters → hosting provider.

For anything touching patient data — suspected access, loss, or exposure —
please contact EMSMCA immediately regardless of which side the cause sits on.
POPIA notification timelines start when the incident is discovered, not when it
is diagnosed.
