# What is left to get this system running properly

**Prepared 2026-08-03** · portal.emsmca.co.za · code state `9f166cb`

Everything in this document was verified against the running system on the date
above, not recalled. Where I could not verify something, it says so.

---

## How to read this

Items are grouped by what they block, not by how hard they are. **Section A is
the only section that blocks running unattended around the clock.** Everything
else is important but can proceed while the platform is in service.

Effort bands: **Minutes** · **Hours** · **A day** · **A week** · **Longer /
third party**.

A caution about "perfect": the useful target is not a system with no remaining
work. It is a system where you find out *before your customers do* when
something breaks, where a bad change can be undone quickly, and where the claims
you make to a medical scheme are all true. That target is close.

---

## Where things stand today

Verified on 2026-08-03:

| | |
|---|---|
| Local, origin and production | all on `9f166cb` |
| Backend tests | 503 passing (run twice consecutively), 4 skipped |
| Frontend tests | 410 passing, typecheck clean |
| Database schema | alembic head `f7c1a9e35b84`, matches code |
| Production health | HTTP 200; fault sweep 10 checks, 9 healthy, 0 faults |
| Anonymous access | 401 on every gated route probed |
| Login timing oracle | closed — 254 ms known vs 254 ms unknown, 0 ms delta |
| Patient identifiers | encrypted at rest, 10 keys across 3 stores, prod + dev |
| Backups | 15 consecutive daily dumps, no gaps; one restored from scratch today |
| TLS | valid to 11 October 2026, auto-renewing |
| Disk | 18 GB of 123 GB used (15%) |
| Reboot survival | all containers `unless-stopped`, Docker enabled at boot |

What landed in the last two days: 24 confirmed security findings closed, patient
identifiers encrypted across every store, PHI reads and record changes audited,
bulk session revocation, and a fault-detection engine with gated self-healing.

---

## Section A — Blocks running 24/7

### A1. Nothing tells anyone when something breaks · **Hours** · *needs a URL from you*

`HEALTHCHECK_URL` is unset, so the dead-man's switch on backups is inert. The
fault monitor writes to a database table and a web page — at 03:00 nobody is
looking at a web page. Today the monitor caught three real faults, and with no
alerting it would have caught them silently.

This is the single highest-value item in this document and the cheapest.

**To close:** create a free healthchecks.io (or UptimeRobot) account, send me the
ping URL. I wire it to the backup switch, the fault sweep, and a keyword check on
`/health` from outside the VM so it survives the VM dying.

### A2. There is no quick rollback for the backend · **Hours**

`ems_nginx` has tagged rollback images. `ems_backend`, `ems_celery_worker` and
`ems_celery_beat` are `:latest` only. A bad deploy at 02:00 means git-reset and
rebuild — several minutes of downtime — instead of an image swap in seconds.

**To close:** tag each image with the commit on build, keep the last five, and
add a documented one-line rollback to the runbook.

### A3. Backups exist only on this VM · **Minutes** · *needs a value from you*

`AZURE_SAS_URL` is unset, so nothing leaves the box. Less severe than it sounds
because the live database is Azure-managed with point-in-time recovery — losing
the VM does not lose patient data. But the 7-year archive is single-copy.

**To close:** create a storage container, paste the SAS URL into
`/etc/default/ems-backup`. Encrypt the dumps before upload (`age -R`) in the same
change.

### A4. The restore rehearsal cannot be confirmed to be running · **Minutes**

The `ems-restore-test` cron exists; `/var/log/ems-restore-test.log` is empty. A
restore you have not rehearsed is a hope, not a backup. I restored one manually
today and it was clean, so the capability works — what is unproven is that the
weekly check is actually firing.

**To close:** run it once by hand, confirm it writes to the log, and add its
result to the alerting from A1.

### A5. One virtual machine, no failover · **Longer** · *a decision, not a task*

If the VM dies you are down until someone rebuilds it. For ambulances running at
03:00 that may or may not be acceptable — but it should be a decision you have
made, not one you discover.

**Options, cheapest first:** accept it and document the recovery time · keep a
warm rebuild script and a tested restore (a few hours of downtime) · a second VM
behind a load balancer (real money, real complexity).

### A6. There is no on-call arrangement · **Process**

It is you. With no alerting (A1), you *are* the monitoring system. A1 changes
that; a second pair of hands changes it more.

---

## Section B — Security backlog

Nine items, in the order I would do them. None is an emergency; all are real.

### B1. The facility email has no recipient allowlist · **A day** · *highest consequence*

`POST /api/digital-prf/.../email-facility` will send a complete patient PRF to
any syntactically valid email address on the internet, from the provider's own
mailbox. The entire recipient check is a regular expression that the address
contains an `@` and a dot.

Two realistic failures: a crew member mistypes a hospital address on a tablet
and a full clinical record goes to a stranger — a notifiable breach, faithfully
recorded in the audit log as a successful delivery. Or a back-office admin loops
every case and mails the lot out. It is audited, which is worth something, but
auditing is detection and this is the highest-consequence action in the product.

**To close:** a per-provider facility list managed in Client Settings; the
endpoint takes a facility ID rather than a free-text address, with a
"other address" path that needs a second confirmation and a distinct audit
action. Cheaper interim: a per-provider allowed-domain list and a daily cap.

### B2. Permission checks pass when permissions are unset · **Hours**

`has_permission` returns `True` when a user's `permissions` column is `NULL`.
That was a deliberate call, but `require_permission` is now the *only* guard on
several routers, so any account with a `NULL` column holds every permission
regardless of role — including rows created by scripts or migrations.

**To close:** one migration to populate `NULL` rows, make the column `NOT NULL`
defaulting to `[]`, and drop the fail-open branch.

### B3. Idempotency keys are chosen by the caller and shared across tenants · **A day**

Three problems in one function on the scheme submission proxy:

- **Cross-tenant replay** — the `Idempotency-Key` header is the primary key of a
  global table with no tenant component. Send the same key as another tenant and
  you are handed their cached scheme response, with no ownership check.
- **Permanent lockout** — a row stuck `IN_PROGRESS` (worker killed mid-flight)
  rejects that claim forever; nothing ages it out.
- **Unbounded growth of patient data** — nothing ever deletes from the table, and
  the rows contain scheme response bodies.

**To close:** key on (actor, path, client key); reclaim stale in-progress rows
after a timeout; add a purge to the scheduled jobs.

### B4. Two password endpoints sit outside the strict rate limits · **Hours**

`/api/crew/portal-unlock` and `/api/providers/{slug}/portal-login` both verify
the shared company password that unlocks every tablet at an ambulance service,
and both land in the ordinary API bucket rather than the strict auth one. The
strict list is a set of exact strings, which structurally cannot express a
parameterised path — which is why it was missed.

Per-source throttling covers them today, but that degrades to per-worker memory
when Redis is down, and the rate limiter fails open under the same condition.

**To close:** make the match a prefix/pattern, add the matching nginx location,
and decide deliberately whether the shared-password paths should fail *closed*
when Redis is unavailable.

### B5. The audit log is append-only in name only · **A day**

The model calls it an immutable POPIA ledger. Nothing enforces that: the app's
database role can update and delete it, there are 31 write sites and **zero read
sites**, and it has no retention rule. It is the fastest-growing table in the
system and the one you would need during a breach — and today it can only be
read with `psql` on production.

**To close:** a database trigger (or an append-only role) that refuses UPDATE and
DELETE; an admin-gated read API with actor/entity/date filters; a retention
decision recorded in writing by the responsible party.

### B6. The content security policy allows inline scripts · **Hours**

Checklist item 8 is marked done on the basis that a strict CSP compensates for
storing tokens in `localStorage`. The policy contains `'unsafe-inline'` in
`script-src`, which means it stops almost none of the injection cases that would
read those tokens — so the compensating control is currently inert.

**To close:** remove `'unsafe-inline'`; a Vite production build needs no inline
scripts. Hash any bootstrap snippet that remains. One line and a smoke test.

### B7. The encryption key has no version and cannot be rotated · **A day**

Three related problems: a wrong key silently produces a valid cipher object
rather than an error; decryption failures return "absent" rather than raising, so
a mistyped key makes every patient ID, passport number and SMTP credential read
as blank with no log line; and ciphertext carries no key id, so re-keying needs a
bespoke one-shot script with no way to run two keys at once.

If that key is ever disclosed, there is currently no remediation available.

**To close:** log loudly when the configured key is not a valid Fernet key;
distinguish "not encrypted" from "cannot decrypt" at call sites; prefix new
tokens with a key id and accept a `MultiFernet` of current plus previous.

### B8. The database connection is encrypted but the server is not verified · **Hours**

`DB_SSL_MODE=require` under asyncpg performs no certificate or hostname
validation. The boot guard proves the connection is encrypted, not that it
terminates at your Azure database.

**To close:** `verify-full` plus the DigiCert Global Root CA bundle.

### B9. No secret scanning in CI · **Minutes**

CI gates `pip-audit` and `npm audit`. There is no gitleaks step. This repository
was public for two months with a plaintext super-admin password and database
dumps in it — this targets a failure the project has actually had.

### Also tracked, lower priority

- **Production Redis has no password.** Needs `REDIS_PASSWORD` *and* `REDIS_URL`
  changed in `.env.prod` in the same edit or the backend cannot authenticate.
  Mitigated: no published port, no on-disk persistence, and cached patient
  records are now encrypted before they reach Redis.
- **JWTs in `localStorage`.** The robust fix is httpOnly cookies, which is a real
  refactor with CSRF implications across both auth systems. B6 is the interim.
- **The emailed PDF is client-supplied** and never compared to the stored record,
  so the audit trail proves a transmission happened and to whom, but not what it
  contained. Fixing it properly means rendering the PDF server-side.

---

## Section C — Finishing the monitoring

**Live now:** ten probes, sweeping every five minutes. Three can repair
themselves; seven only report. Unattended repair is **off** and should stay off
for about two weeks while you watch what it *would* have done.

A full inventory of 36 detectable faults exists. The ten built are the ones that
need nothing but the application itself.

### C1. A host-level agent · **A week**

Roughly a third of the remaining remedies are "restart a container" or "reload
nginx" — which a container cannot do for itself. The obvious shortcut, mounting
the Docker socket into the worker, is **not acceptable**: it grants root on a
machine holding patient records to a container that runs OCR on
attacker-supplied PDFs.

The right shape is a small agent on the host that polls a job table for a fixed
allowlist of commands. That unlocks the highest-value remaining probes:

- **A worker attached to the broker but consuming nothing** — the silent
  critical one. `/health` returns "healthy" with zero consumers, and every PRF
  submitted meanwhile is heading for the failed queue.
- **nginx serving 502 while the backend is healthy** — the cached-upstream trap;
  last occurrence ran about four minutes.
- **Scheduled jobs missing or drifted after a deploy.**

### C2. Beat liveness · **Hours**

"Beat is fine" and "beat has been dead a week" currently produce identical
evidence. A heartbeat task makes the difference observable and is a prerequisite
for trusting several other checks.

### C3. Dead-letter queue and unregistered-task checks · **Hours**

Every message in the dead-letter queue is a task that will never run and about
which nothing else will ever tell you. The unregistered-task fault has already
happened once in this system.

### C4. Turn on unattended repair · **A decision**

After two weeks of observation, and only for the probes that pass every safety
gate. Nothing that touches patient data will ever be in that set.

---

## Section D — Scale and resilience

### D1. Uploads live on a local Docker volume · **A week**

This is what prevents running more than one backend host. Moving to Azure Blob
is the unlock for any horizontal scaling.

### D2. Load is modelled, not observed · **A week**

Production has one active user and 82 patient report forms. The 105 providers and
1500 crew figure is a projection. A load rehearsal against a copy would tell you
where it actually bends.

### D3. Disk is not a near-term risk

An earlier estimate suggested backups would outgrow the disk. Measured: the
uploads archive is 456 KB and a database dump is 12 MB, so full seven-year
retention is about **1.2 GB** against 106 GB free. Revisit when uploads grow.

---

## Section E — Legal and compliance

**Not engineering, and currently the larger exposure.** The platform already
holds real patient records, so these obligations are live now.

| Item | Status | Effort |
|---|---|---|
| Operator agreements (POPIA s21) with each provider | none exist | Attorney, weeks |
| Registered Information Officer | not registered | Days |
| PAIA manual, published | does not exist | Days |
| Sub-processor register | not drafted — **I can draft this** | Hours |
| AI vendor terms (retention / no-training) | none signed | Weeks |
| Cross-border transfer decisions | **awaiting your call** | A conversation |
| Cyber liability insurance | none | Days |
| Breach response plan (72-hour) | not written | Days |

Two cross-border transfers are still live and are decisions only you can make:
incident-scene GPS is sent to a geocoding service in Europe on every Mark Time,
and crews dictating clinical narrative send audio to Google or Apple.

---

## Section F — Things to buy

| Item | Why | Rough |
|---|---|---|
| SAMA CPT, NRPL, NAPPI, ICD-10 licences | the code sets are in the repo unlicensed | Annual fees |
| Penetration test | every scheme officer asks; internal audits are not a substitute | Once-off |
| Cyber liability cover | see Section E | Annual |
| ISO 27001 or SOC 2 | only when a scheme makes it a condition | Significant |

The tariff engine is disabled in both environments, so nothing is billing on the
unlicensed code sets today.

---

## Section G — Deliberately not doing

These are decisions, not omissions. Each one looks like an easy win and is not.

- **Multi-factor authentication** — deferred by your decision. Worth knowing it
  is the first control a scheme's officer asks about.
- **Auto-applying migrations** — a migration rewrites the schema of a live
  medical-records database, and several in this project rewrite rows. "The
  numbers do not match" does not tell you whether to roll the schema forward or
  the image back.
- **Auto-running the encryption backfill** — if the process holds a wrong key
  when it fires, it encrypts every remaining identifier under a key nobody has.
  Unrecoverable.
- **Auto-replaying the dead-letter queue** — those payloads re-run the billing
  pipeline. A message is in that queue precisely because something abnormal
  happened to it.
- **Auto-unlocking a locked account** — the attacker is the party causing the
  lock, so an auto-unlocker is indistinguishable from having no lockout.
- **Trimming the audit log to save space** — it is the record of who opened which
  patient's file. No correct automatic deletion exists.
- **Forcing the crew app to reload after a deploy** — a tablet may be mid-form at
  a roadside with a patient present.
- **Mounting the Docker socket into a container** — see C1.

---

## Suggested sequence

**This week**
1. Alerting (A1) — highest value, lowest cost, needs one URL from you.
2. Off-site backups (A3) and confirm the restore rehearsal (A4).
3. Rollback image tags (A2).
4. Secret scanning (B9) and the CSP fix (B6) — both quick.

**Next two weeks**
5. Permission fail-open (B2) and the rate-limit path coverage (B4).
6. Watch the fault monitor; decide on unattended repair (C4).
7. Start the facility allowlist design (B1) — it is a product change, not a patch.
8. Get an attorney onto the operator agreements (Section E) in parallel.

**The month after**
9. Idempotency keys (B3), audit log read API and retention (B5).
10. Encryption key versioning (B7), database certificate verification (B8).
11. Host agent and the remaining probes (C1–C3).
12. Decide on the single-VM question (A5).

---

## One honest note on process

Three times in the last two days a control was written correctly in one place and
not carried to the second route into the same thing — including twice in work I
had just finished and described as complete. The pattern is consistent enough to
plan around: when a security control is added, the question to ask is not "does
this work?" but "what is the *other* door into this, and does it have the same
lock?"

Two of the tests I wrote in that period also passed for the wrong reasons. Both
are fixed, and both were found by deliberately breaking the code to check the
test noticed. That step is worth keeping.
