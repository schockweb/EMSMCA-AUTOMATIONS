# What is left to get this system running properly

**Prepared 2026-08-03** · portal.emsmca.co.za · production `842029c` · origin `98da1d3`

Everything in this document was verified against the running system on the date
above, not recalled. Where I could not verify something, it says so.

> **Revision, later on 2026-08-03.** Section B is closed. A2 and A4 are closed
> and, unusually, *rehearsed*. D2 has been replaced by measured numbers. One new
> section (H) was added because the load test surfaced something nobody had
> looked at. The changes are summarised under "What changed today".

> **Revision, 2026-08-06 — the move to the client's Azure VM carries no data.**
> The current VM holds pilot data only, and by decision **none of it moves**: no
> database dump, no uploads volume, no accounts, no backup archives, and new
> `SECRET_KEY` / `ENCRYPTION_KEY`. The new instance starts empty and its first
> PRF is a real one. The only thing copied is the TLS certificate, which is a
> file for a domain the client owns, not data. Procedure:
> `deploy/MIGRATE-TO-CLIENT-VM.md`.
>
> Two consequences worth carrying into the rest of this document. **A4's
> encryption-key gate no longer applies to the move** — a wrong key is only
> catastrophic when there is something already encrypted to read, and there is
> not. And **the pilot data does not live only on the VM**: the crew app's
> offline outbox is kept in the browser origin, the hostname is unchanged, and
> `services/offlineDb.ts` states it is not cleared on End Shift or logout — so an
> unpurged tablet will sync pilot PRFs into the clean database and the server will
> correctly accept them. Purging the devices is a required step, not tidying.

---

## How to read this

Items are grouped by what they block, not by how hard they are. **Section A is
the only section that blocks running unattended around the clock.** Everything
else is important but can proceed while the platform is in service.

Effort bands: **Minutes** · **Hours** · **A day** · **A week** · **Longer /
third party**.

A caution about "perfect": the useful target is not a system with no remaining
work. It is a system where you find out *before your customers do* when something
breaks, where a bad change can be undone quickly, and where the claims you make
to a medical scheme are all true.

A second caution, earned today: **"written" and "works" are different claims, and
the gap between them is larger than it feels.** Every single thing that was
exercised for the first time today turned out to be broken in some way — the
restore checker, the rollback script, and my own load harness twice. None of
those defects were visible by reading the code. Where this document says
something is *rehearsed*, that word is load-bearing.

---

## What changed today

| | |
|---|---|
| **A2 rollback** | Built and **rehearsed on production**: back in 36 s, forward in 29 s, health 200 throughout. Four defects found on first real use. |
| **A4 restore rehearsal** | Run. It **failed**, correctly, and the failure was in the checker's premise rather than the backup. Fixed and fault-tested. |
| **A5 single VM** | `rebuild-vm.sh` written with a `--check` mode. Still a decision, but now a documented procedure rather than a memory exercise. |
| **B2–B9** | All eight closed, deployed and verified against production. |
| **D2 load** | No longer a projection. Measured: **500 concurrent = 188 req/s, zero errors.** |
| **H (new)** | The claims path — 1,716 lines that decide what a scheme gets billed — has **no tests at all**. |

---

## Where things stand

Verified on 2026-08-03:

| | |
|---|---|
| Production | `842029c`, health 200 |
| origin/main | `98da1d3` — ahead by the load-test harness only, no application code |
| Backend tests | **539 collected** |
| Frontend tests | **415 passing** |
| Database schema | alembic head `c2f9a48d61be`, matches code |
| Rollback points | 6 tagged releases, images present |
| Backups | restore rehearsed today; content proven to match production |
| Patient identifiers | encrypted at rest; **independently re-proven today** — all 9 field types round-trip on real records |
| Load ceiling | 500 concurrent → 188 req/s, 0 errors, 230% of a 400% CPU budget |
| Database connections | `max_connections` **859** (the "200" in older notes was wrong) |
| TLS | valid to 11 October 2026, auto-renewing |
| Disk | 18 GB of 123 GB used (15%) |

---

## Section A — Blocks running 24/7

### A1. Nothing tells anyone when something breaks · **Hours** · *needs a URL from you* · **OPEN**

`HEALTHCHECK_URL` is unset, so the dead-man's switch on backups is inert. The
fault monitor writes to a database table and a web page — at 03:00 nobody is
looking at a web page.

**Still the single highest-value item in this document, and the cheapest.**

**To close:** create a free healthchecks.io (or UptimeRobot) account, send me the
ping URL. I wire it to the backup switch, the fault sweep, and a keyword check on
`/health` from outside the VM so it survives the VM dying.

### A2. Quick rollback for the backend · **DONE 2026-08-03, rehearsed**

`deploy/ops/tag-release.sh` stamps the image each container is *using* — not
`:latest`, not a fresh build of current source; those three differ and only one is
serving requests — together with the commit and the Alembic revision the database
was at. `deploy/ops/rollback.sh` swaps the tags back.

**Measured on production: 36 s back, 29 s forward, health 200 throughout.** No
rebuild, no network. Wired into the runbook and the deploy workflow, before and
after.

It refuses three things, each for a reason: images already pruned, a checkout
with hand edits (`git checkout` would destroy them), and a database ahead of the
target — where it lists the exact migrations the old code has never seen and
demands `--accept-schema-drift`. **Code rolls back; schema does not.**
`alembic downgrade` is deliberately not automated.

*Four defects the rehearsal found that reading had not: a health probe that could
never pass (nginx 301s plain HTTP — the same bug was in CI, which would have
failed every deploy); a script that deleted itself mid-run (it lives in the tree
it checks out, and bash reads scripts incrementally by file offset); a comparison
against git HEAD rather than the running images; and `. .env.prod` truncating a
password at a `$`.*

### A3. Backups exist only on this VM · **Minutes** · *needs a value from you* · **OPEN**

`AZURE_SAS_URL` is unset, so nothing leaves the box.

**One correction to the earlier wording, and it matters.** This was described as
"less severe than it sounds" because the database is Azure-managed with
point-in-time recovery. That is true of the *database*. It is **not** true of the
uploads volume — PRF attachments, photos, provider logos — which is a local
Docker volume backed up to `/opt/backups` **on the same VM**. If that VM is lost
today, every attachment is lost with it.

**To close:** create a storage container, paste the SAS URL into
`/etc/default/ems-backup`. Encrypt the dumps before upload (`age -R`) in the same
change. The SAS must be Create+Write+List and **not** Delete, so a compromised VM
cannot erase the off-site copies with the credential stored on it.

### A4. Restore rehearsal · **DONE 2026-08-03** — *and it failed, usefully*

Run by hand. It reported **70 of 81 finalised PRFs altered** and refused to call
the backup trustworthy.

It was right that they had changed and wrong about what that meant. The second
patient-identifier encryption pass had rewritten those records by direct UPDATE,
after the 03:09 dump, without touching `updated_at`. Decrypting **both** sides
showed **81 of 81 identical, 0 undecryptable** — which independently re-proved
that every encrypted field type round-trips correctly on real production data.

The checker's premise — that a finalised PRF is byte-immutable forever — was
wrong, because an at-rest encryption migration legitimately rewrites them. That
is the worst kind of alarm: narrowly true, badly wrong in its conclusion, and
fired by planned work. **An alarm that cries wolf on a migration trains its
reader to dismiss it, which is exactly how the 2026-07-18 backup failure went
unnoticed for eight days.**

Now: the content fingerprint excludes the identifier fields and those are checked
separately for *presence* — ciphertext may change, an identifier may not vanish.
Fault-tested both ways, and the two checks proven independent.

### A5. One virtual machine, no failover · **Longer** · *a decision, not a task*

Now with a written procedure: `deploy/ops/rebuild-vm.sh --check | --run`.
`--check` reports recovery readiness in seconds; `--run` performs the rebuild and
stops rather than guessing at DNS, escrow or the database firewall.

**What survives the VM:** the database. Azure-managed, off-box, with PITR.
Losing the VM does not lose a single PRF record.
**What does not:** the uploads volume (see A3), and `.env.prod` — which is not in
the repository and whose `ENCRYPTION_KEY` cannot be regenerated. Without it every
patient identifier in the database is permanently unreadable.

**Three options, in the order I would consider them.** *Accept it* and publish a
recovery time — realistically 2–4 hours, now that the rebuild is scripted rather
than remembered; this is my recommendation at current load, but it should be a
decision you have made, not one you discover at 03:00. *Warm standby* — a second
VM kept current but idle, roughly 15 minutes to switch, about double the hosting
cost. *Active-active* behind a load balancer — the only zero-downtime option, and
it requires D1 (uploads off local disk) first.

**Not yet rehearsed on a fresh VM.** Until it is, the 2–4 hours is an estimate,
and this document has spent today demonstrating what estimates are worth.

### A6. There is no on-call arrangement · **Process** · **OPEN**

It is you. With no alerting (A1), you *are* the monitoring system.

---

## Section B — Security backlog · **B2–B9 CLOSED**

### B1. The facility email has no recipient allowlist · **A day** · **OPEN — highest consequence in this document**

`POST /api/digital-prf/.../email-facility` will send a complete patient PRF to any
syntactically valid email address on the internet, from the provider's own
mailbox. The entire recipient check is a regular expression for an `@` and a dot.

Two realistic failures: a crew member mistypes a hospital address on a tablet and
a full clinical record goes to a stranger — a notifiable breach, faithfully
recorded in the audit log as a successful delivery. Or a back-office admin loops
every case and mails the lot out.

**To close:** a per-provider facility list managed in Client Settings; the
endpoint takes a facility ID rather than free text, with an "other address" path
needing a second confirmation and a distinct audit action. Cheaper interim: a
per-provider allowed-domain list and a daily cap.

### Closed on 2026-08-03 — all verified against production

| | | Evidence on production |
|---|---|---|
| **B2** | Permission checks no longer pass when permissions are unset | `permissions` NOT NULL, default `'[]'`; fail-open branch deleted |
| **B3** | Idempotency keys scoped to an actor, reclaimable, purged | `scope` + `path` columns present; purge task registered |
| **B4** | Both shared-password endpoints under the strict auth limit | `401 401 401 401 401 401 503 503` on `/api/crew/portal-unlock` |
| **B5** | Audit log append-only in fact, and readable | trigger installed; `/api/audit-logs` 401 anonymous |
| **B6** | No inline scripts in the CSP | `script-src 'self' https://maps.googleapis.com` |
| **B7** | Encryption key rotatable, and fails loudly | MultiFernet; fingerprint `70f73a53f6e3` |
| **B8** | Database certificate actually verified | `check_hostname=True`, `verify_mode=CERT_REQUIRED` |
| **B9** | Secret scanning in CI | gitleaks clean across 303 commits |

Two notes worth keeping. **B8 was not what the audit said**: the code already
built a verifying context, but production set `?ssl=require` in the connection
URL instead of `DB_SSL_MODE`, and asyncpg's string form encrypts *without*
checking the certificate — the boot guard accepted the weaker spelling. **B9's
nine hits were all false positives**, verified by inspecting value shapes rather
than printing them.

### Also tracked, lower priority

- **Production Redis has no password.** Needs `REDIS_PASSWORD` *and* `REDIS_URL`
  changed in `.env.prod` in the same edit or the backend cannot authenticate.
  Mitigated: no published port, no on-disk persistence, and cached patient
  records are encrypted before they reach Redis.
- **JWTs in `localStorage`.** The robust fix is httpOnly cookies — a real refactor
  with CSRF implications across both auth systems. B6 is no longer merely an
  interim: with `'unsafe-inline'` gone, the compensating control actually works.
- **The emailed PDF is client-supplied** and never compared to the stored record,
  so the audit trail proves a transmission happened and to whom, but not what it
  contained. Fixing it properly means rendering the PDF server-side.

---

## Section C — Finishing the monitoring

**Live now:** ten probes, sweeping every five minutes. Three can repair
themselves; seven only report. Unattended repair is **off** and should stay off
for about two weeks while you watch what it *would* have done.

### C1. A host-level agent · **A week**

Roughly a third of the remaining remedies are "restart a container" or "reload
nginx" — which a container cannot do for itself. The obvious shortcut, mounting
the Docker socket into the worker, is **not acceptable**: it grants root on a
machine holding patient records to a container that runs OCR on
attacker-supplied PDFs.

The right shape is a small agent on the host polling a job table for a fixed
allowlist of commands. That unlocks the highest-value remaining probes:

- **A worker attached to the broker but consuming nothing** — the silent critical
  one. `/health` returns "healthy" with zero consumers, and every PRF submitted
  meanwhile is heading for the failed queue.
- **nginx serving 502 while the backend is healthy** — the cached-upstream trap.
- **Scheduled jobs missing or drifted after a deploy.**

### C2. Beat liveness · **Hours**

"Beat is fine" and "beat has been dead a week" currently produce identical
evidence.

### C3. Dead-letter queue and unregistered-task checks · **Hours**

Every message in the dead-letter queue is a task that will never run and about
which nothing else will ever tell you.

### C4. Turn on unattended repair · **A decision**

After two weeks of observation, and only for probes that pass every safety gate.
Nothing that touches patient data will ever be in that set.

---

## Section D — Scale and resilience

### D1. Uploads live on a local Docker volume · **A week** · **OPEN**

This is what prevents running more than one backend host, and — see A3 — it is
also the one category of application data that a VM loss actually destroys. It is
the unlock for any horizontal scaling and the fix for the biggest data-loss risk
at the same time.

### D2. Load · **MEASURED 2026-08-03** — no longer a projection

Harness in `loadtest/` + `docker-compose.loadtest.yml`: isolated stack, the
production image, gunicorn with 4 workers pinned to the same 4 vCPU / 2 GB as the
VM, seeded to **105 providers / 1,470 crew / 10,000 PRFs / 1 GB**.

**Headline: 500 concurrent request streams → 188 req/s, zero errors**, autosave
p50 76 ms, backend at 230% of a 400% CPU budget.

**And the framing that matters more than the number.** The PRF runs *on the
crew's device*. Crews do not hold a server session through a call — the form is
local and syncs. 500 crew autosaving every ~25 s generate roughly **20 req/s**,
not 188. **500 crew is comfortably within capacity**; it took four separate
driver containers to even stress the server.

Four cliffs, measured:

| Finding | Measured | Why it matters |
|---|---|---|
| **Login capped at 15/min per client IP** | 200-crew storm → **75% rejected (429)**, p50 2.6 s | Crews on one base WiFi or carrier CGNAT present as one IP. **This is the one that will bite, at shift change.** |
| **PRF create serialises per provider** | p50 254 ms, **p95 6.6 s** at 500 concurrent | A `SELECT … FOR UPDATE` on the provider row held for the whole transaction. Softened because crews create offline. Fix: a per-provider sequence rather than `max()+1` under a lock. |
| **Search costs 59× what it should** | **146 ms vs 2.5 ms** with the blob clause removed, on a provider with 559 PRFs | `cast(form_data, Text).ilike` detoasts every record. At 5,000 PRFs/provider ≈ 1.3 s *per keystroke*, on a 400 ms debounce with no minimum term length. |
| **Sync burst survives** | 500 devices flushing at once: create p50 9.4 s, **0.04% errors** | Latency degrades badly; nothing is lost. The correct failure mode for offline-first. |

**Not bottlenecks:** CPU (52.5 of a possible 252 core-seconds, zero cgroup
throttling), database locks (1 active connection, no lock waits), or connections
(`max_connections` is 859).

*Two ways this nearly produced confident nonsense, both caught by checking the
server while the client complained. The first runs reported **148-second**
responses while the backend sat at 0.5% CPU — that was Docker Desktop's Windows
port proxy, not the platform. And the first seed built narratives by repeating one
sentence, so compression squashed 31 KB rows to 1.5 KB on disk, **230× less I/O
than production**, which averages 150 KB logical and 340 KB on disk per PRF. Real
PRFs are mostly incompressible base64. The remaining test bed is still ~1.5×
lighter than production, so the results above are mildly optimistic.*

### D3. Disk is not a near-term risk

Measured: the uploads archive is 456 KB and a database dump is 12 MB, so full
seven-year retention is about **1.2 GB** against 106 GB free.

---

## Section H — The claims path has no tests · **NEW, and the largest unexamined risk**

Everything this month has been infrastructure, security and operations. The code
that decides **whether a claim is valid and what it is worth** has no test file
referencing it at all:

| Module | Lines | Test files referencing it |
|---|---|---|
| `adjudication_engine.py` | 864 | **0** |
| `edi_generator.py` | 495 | **0** |
| `claims_pipeline.py` | 357 | **0** |
| `ocr_extraction.py` | 743 | 2 |
| `tariff_engine.py` | 1,501 | 2 |

That is **1,716 lines on the money path with nothing exercising them.** A defect
there does not crash anything and does not page anyone. It quietly under-bills a
provider, or sends a scheme something wrong, and it surfaces at reconciliation —
weeks later, in someone else's spreadsheet.

Given that every component exercised for the first time today was broken, I would
not assume this code is correct because it has not complained. It has never been
asked a question it could fail.

**Mitigation in place:** the tariff engine is disabled in both environments, so
nothing is billing on it today. That is a reason this is not an emergency, not a
reason it is fine.

**To close:** `backend/golden_claims_replay.py` already replays real claims
through the live pipeline and diffs five checkpoints. Point it at the adjudication
path, add fault injection, and build out unit coverage from whatever it catches.
Estimate: **a week**, and the highest-value week left in this document once A1 and
A3 are done.

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

One thing that got materially easier today: **B5 means breach scoping is now
possible without a database client.** `/api/audit-logs/patient/{id}` answers "who
has seen this patient's file" directly — which is the POPIA s22 question, asked
the way it actually arrives, under a 72-hour clock.

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

These are decisions, not omissions. Each looks like an easy win and is not.

- **Multi-factor authentication** — deferred by your decision. Worth knowing it is
  the first control a scheme's officer asks about.
- **Auto-applying migrations** — a migration rewrites the schema of a live
  medical-records database, and several in this project rewrite rows.
- **Auto-running the encryption backfill** — if the process holds a wrong key when
  it fires, it encrypts every remaining identifier under a key nobody has.
- **Auto-replaying the dead-letter queue** — those payloads re-run the billing
  pipeline.
- **Auto-unlocking a locked account** — the attacker is the party causing the lock.
- **Trimming the audit log to save space** — it is the record of who opened which
  patient's file.
- **Forcing the crew app to reload after a deploy** — a tablet may be mid-form at a
  roadside with a patient present.
- **Mounting the Docker socket into a container** — see C1.
- **Automatic `alembic downgrade` during a rollback** — new today. An unattended
  schema downgrade of a database holding patient records is a worse failure than
  the outage it would be fixing.

---

## Suggested sequence

**This week**
1. **Alerting (A1)** — highest value, lowest cost, needs one URL from you.
2. **Off-site backups (A3)** — needs one value from you, and until it is set a VM
   loss destroys every PRF attachment.
3. **The login rate limit** (D2) — small change, and the difference between a
   shift starting and a whole base locked out a minute at a time.

**Next two weeks**
4. **Tests for the claims path (H)** — the largest unexamined risk in the system.
5. Start the facility allowlist design (B1) — a product change, not a patch.
6. Watch the fault monitor; decide on unattended repair (C4).
7. Get an attorney onto the operator agreements (Section E) in parallel.

**The month after**
8. Uploads to Azure Blob (D1) — closes the attachment data-loss risk permanently
   and unlocks horizontal scaling.
9. Denormalise the PRF search columns (D2) and put a minimum term length in the UI.
10. Per-provider PRF numbering sequence (D2).
11. Host agent and the remaining probes (C1–C3).
12. Rehearse `rebuild-vm.sh` on a throwaway VM, then decide A5 with a real number.

---

## One honest note on process

The previous edition of this document recorded that three times in two days a
control was written correctly in one place and not carried to the second route
into the same thing. That pattern held again today: the same wrong health probe
existed in both the rollback script and CI.

Today added a sharper version of the same lesson. **Four separate pieces of
tooling were exercised for the first time, and all four were broken** — the
restore checker, the rollback script, and the load harness in two independent
ways. Not one of those defects was visible by reading the code; every one of them
appeared within seconds of the thing actually running.

Two of those failures would have been worse than silence, because they came with
a number attached: a restore check confidently reporting that finalised patient
records had been altered in production, and a load test confidently reporting
148-second response times for a server that was 99.5% idle. **A wrong measurement
is more dangerous than no measurement.**

So the question to ask of anything in this document marked "done" is not "does the
code look right?" — it is "has it been run, and did anyone check the server while
the client was complaining?"
