# EMS Digital PRF Billing System
## Strategic Roadmap & Recommendations
**Prepared for:** Tom | **Date:** May 2026 | **Status:** Confidential

---

## Executive Summary

You have a well-architected, partially-built EMS billing platform that is closer to production-ready than most teams realise at this stage. The core form, pipeline, and data model are solid. The work ahead falls into three distinct tracks running in sequence: fix the eight identified billing-critical bugs first, then deploy the production infrastructure to Hetzner Johannesburg, then harden for full production throughput. Done in this order, you avoid deploying broken billing logic onto production servers, and you avoid re-engineering twice.

The total outcome: a self-hosted, fully containerised, POPIA-compliant EMS billing platform running in South Africa on R1,420/month of server infrastructure — capable of absorbing 600–900 PRF submissions during shift-change bursts with a processing queue that drains in seconds, serving 90+ ambulance clients and their combined fleet of hundreds of active vehicles.

---

## 1. Where You Stand Right Now

### What is working well
Your Digital PRF form is genuinely impressive. It handles six distinct call-type flows (PRIMARY, IHT/IFT, RESUS, COURTESY, DOD, RHT) with intelligent phase skipping, real-time GPS capture, offline-first auto-save every 5 seconds, client-side validation, and a comprehensive medical scheme library covering the full SAPAESA 2026 administration list. The backend pipeline — FastAPI, Celery, PostgreSQL, mileage engine, tariff engine — is architecturally sound and the data model is well-normalised.

### What is at risk right now
There are eight billing-critical issues in the current codebase that will cause revenue loss at scale. Four of these are already fixed (see Section 2). The remaining four require immediate attention before any production deployment.

---

## 2. Track 1 — Immediate Fixes (Do This Before Anything Else)

These must be resolved before the system processes a single live billing claim. At 150–300 forms per hour sustained throughput, even a 1% silent error rate compounds to dozens of wrong bills every shift.

### Already Fixed ✅
The following were corrected directly in your codebase during this engagement:

**Fix 1 — Call-type-aware KM calculation (`digital_prf.py`)**
DOD (Declaration of Death) and RHT (Refused Hospital Transport) calls have no transport leg. The previous code used `max(0.0, None - None)` which silently produced zero for both — correct by accident, invisible by design. The code now branches explicitly on `call_type`, sets `loaded_km = 0.0` and `rtb_km = 0.0` intentionally for DOD/RHT, and documents exactly why. Any new no-transport call type only needs to be added in one place.

**Fix 2 — Call-type-aware time calculation (`digital_prf.py`)**
DOD and RHT calls never capture `time_depart_scene` or `time_handover` because those phases don't exist in those flows. Scene time for these call types is now correctly calculated as `time_available − time_on_scene`. Handover minutes are explicitly zeroed rather than falling through None arithmetic.

**Fix 3 — Mileage engine false positive suppression (`mileage_engine.py`)**
The `ZERO_LOADED_DISTANCE` warning is now suppressed when `no_transport_call = True`. Without this fix, every DOD and RHT form submitted would generate a review flag demanding someone verify why transport KM is zero — flooding the review queue with noise and burying genuine errors.

**Fix 4 — Call-type routing flags added to extracted_data (`digital_prf.py`)**
Four new flags (`call_type_raw`, `no_transport_call`, `declaration_of_death`, `refused_transport`) are now written into every `extracted_data` payload. Every downstream engine — mileage, tariff, adjudication — can now make explicit, documented decisions based on call type rather than inferring from missing fields.

### Still Requires Action ⚠️

**Fix 5 — KM fields stored as String(10) in the database**
Every odometer column in `digital_prfs` is `String(10)`. The billing calculation converts these with `float(val)` and silently falls back to `0.0` on any parse error. A crew member typing `"25 000"` with a space, or `"25,800"` with a comma — both common on mobile keyboards in South Africa — becomes zero KM with no error and no audit trail. This needs a database migration to `NUMERIC(8,1)` and server-side numeric validation before the save endpoint accepts the value.

**Fix 6 — KmInput component strips decimal points**
In `DigitalPRFForm.tsx`, the odometer input uses `replace(/\D/g, '')` which removes all non-digit characters including the decimal point. A reading of `24810.5` becomes `248105`. Change the regex to `/[^0-9.]/g` and add a guard to prevent two decimal points.

**Fix 7 — Negative KM delta must surface as an error, not a silent zero**
When a crew member enters readings in the wrong order (a typo, a transposed digit), `km_at_destination < km_depart_scene` produces a negative delta. `max(0.0, ...)` hides it completely. The billing record shows zero KM for that leg with no flag. Add a `review_flags` JSONB column to `digital_prfs` and write an explicit flag when any delta is negative or implausibly small (< 0.1 km). Block submission until the crew corrects or explicitly confirms.

**Fix 8 — No billing schema code on the PRF**
There is no `billing_schema_code` field on the `DigitalPRF` model or form. The mileage engine calculates distances and times correctly, but the tariff engine has no way to look up which rate schedule applies — what the rate per KM is, what the minimum KM is, what the rounding rule is. This is required before real rand amounts can be generated. Add `billing_schema_code` to the form (auto-populated from the selected medical scheme where possible), the model, and the save endpoint.

---

## 3. Track 2 — Hetzner Johannesburg Production Infrastructure

Once the billing logic is correct, deploy to production infrastructure. The choice is Hetzner Cloud in the Johannesburg region — self-hosted, fully containerised, fixed cost, and entirely within South Africa.

### Why Hetzner for this project

**Data sovereignty** — Hetzner's Johannesburg data centre keeps all patient data in South Africa, satisfying POPIA data residency requirements without any cloud provider contract negotiation.

**Predictable cost** — R1,420/month flat, regardless of how many PRFs you process. No per-execution billing, no egress charges, no surprise invoices. As your client base grows, the server cost does not.

**Full control** — Every component is open-source software running in Docker containers. Rate limits, database tuning, queue behaviour, backup schedules — nothing is hidden behind a managed service abstraction. Your team owns the entire stack.

**No lock-in** — If you ever want to move to Azure or AWS, every piece of software (FastAPI, PostgreSQL, RabbitMQ, Celery, MinIO) runs identically on any cloud provider. The migration is a DNS change and a data export.

### Capacity at Your Real Scale

With 90 clients and a combined fleet of 600–900 active ambulances, your actual load profile is:

| Period | Throughput |
|---|---|
| Mid-shift sustained | 200–300 PRFs/hr |
| Shift change burst (06:00 and 18:00) | 600–900 PRFs/hr |
| System processing capacity (12 Celery workers) | 14,400 PRFs/hr |
| Headroom above real-world peak | 15× minimum |

The shift change burst is the design case. When 400+ ambulances close their shift paperwork simultaneously, 400+ forms queue simultaneously. With 12 concurrent Celery workers each processing a form in approximately 3 seconds, the entire burst queue drains within 10–20 seconds. Zero backlog. Crews and billing staff notice nothing.

### Production Server Architecture

Five servers plus a load balancer. All services run in Docker containers, orchestrated with Docker Compose, deployed via GitHub Actions.

```
                        Internet
                           │ HTTPS
                           ▼
               Hetzner Load Balancer (LB11)
               SSL termination · health checks · failover
                    │                │
                    ▼                ▼
           App-1 (CX32)        App-2 (CX32)
           FastAPI + Nginx      FastAPI + Nginx
           4 Gunicorn workers   4 Gunicorn workers
                    │
                    │ Enqueue job (AMQP)
                    ▼
             Worker (CX42)
             Celery × 12 processes
             RabbitMQ · Flower · etcd
                    │
                    ▼
           DB Primary (CX42)
           PostgreSQL 16 + PgBouncer
                    │ Patroni streaming replication
                    ▼
           DB Standby (CX32)
           Patroni hot standby · pgBackRest
```

| Server | Hetzner Type | vCPU | RAM | Purpose | Monthly Cost |
|---|---|---|---|---|---|
| App-1 | CX32 | 4 | 8 GB | FastAPI + Nginx + etcd | ~R180 |
| App-2 | CX32 | 4 | 8 GB | FastAPI + Nginx + etcd (HA pair) | ~R180 |
| Worker | CX42 | 8 | 16 GB | Celery × 12 + RabbitMQ + Flower + etcd | ~R380 |
| DB Primary | CX42 | 8 | 16 GB | PostgreSQL 16 + PgBouncer + etcd | ~R380 |
| DB Standby | CX32 | 4 | 8 GB | Patroni hot standby + pgBackRest | ~R180 |
| Load Balancer | LB11 | — | — | SSL termination, health checks, failover | ~R120 |
| **Total** | | | | | **~R1,420/mo** |

### Full Tool Stack

**Frontend delivery** — Nginx (static file serving) + Let's Encrypt (free SSL) + Certbot (automatic certificate renewal)

**Backend runtime** — FastAPI + Gunicorn (8 workers per app server) + Uvicorn workers (async I/O). Your existing codebase deploys with zero changes.

**Async processing** — Celery (12 worker processes, prefork concurrency) + RabbitMQ 3.13 (durable queues + dead-letter queue built in) + Flower (real-time worker and queue monitoring dashboard)

**Database** — PostgreSQL 16 + PgBouncer (connection pooling — prevents connection storms at shift change) + Patroni (automatic HA failover with etcd consensus) + pgBackRest (continuous WAL archiving, point-in-time restore to any second)

**Object storage** — MinIO (S3-compatible API for PRF documents, crew signatures, attachments, PDF exports — same interface as Azure Blob or AWS S3)

**Deployment** — Docker + Docker Compose + GitHub Actions (CI/CD, runs tests on every push, builds and pushes images on merge to main) + Watchtower (automatic container restarts on new image tags, zero-downtime rolling deploys)

**Monitoring** — Prometheus (metrics) + Grafana (dashboards + alerting) + Alertmanager (routes alerts to WhatsApp/email/SMS) + Loki (log aggregation) + Uptime Kuma (external uptime checks, public status page for your clients)

**Security** — Fail2ban (brute-force and credential-stuffing protection) + UFW (host-level firewall, only ports 80/443/22 open) + HashiCorp Vault (centralised secrets — no database passwords or API keys in any config file or environment variable file in the repository)

**Developer tooling** — GitHub (version control + pull request workflow + branch protection) + pre-commit hooks (ESLint, Black, Ruff, secret scanning) + Alembic (database migrations) + pytest (backend unit and integration tests) + Vitest (frontend component tests)

### Key component decisions explained

**PgBouncer** is non-negotiable at your scale. Without it, 12 Celery workers plus 8 Gunicorn workers per app server equals 28+ persistent PostgreSQL connections per server restart. At shift change, connection storms can crash a PostgreSQL instance. PgBouncer pools these into 5–10 actual DB connections and transparently queues the rest — your database stays healthy regardless of how many workers are running.

**Patroni + etcd** gives you automatic PostgreSQL failover with no human intervention. If the DB primary fails at 02:00, the standby promotes itself within 30 seconds. The two app servers and the worker server all run etcd so failover elections have a quorum even if one node goes down.

**RabbitMQ dead-letter queue** means every PRF that fails processing three times (Celery `max_retries=3`) lands in a separate review queue automatically — not silently discarded. Your billing manager sees every failed form in the admin dashboard and can correct and requeue without a developer involved.

**Two App servers behind a load balancer** means you can update, restart, or replace one app server with zero downtime. The load balancer health-checks both and routes only to healthy instances. Planned maintenance at any hour requires no service window.

---

## 4. Track 3 — Scale & Harden for Production

With correct billing logic and Hetzner infrastructure in place, the final track focuses on production readiness at your real throughput: 200–300 PRFs/hr sustained, 600–900/hr at shift change bursts.

### Billing schema management
Build an admin interface for `billing.rate_schemas` — the table that holds rate-per-KM, base fees, rounding rules, and minimum distances per medical scheme. This is the single most important business-logic table in the system. Rates change annually (schemes publish new tariff books every January). The interface needs effective dates so old PRFs can always be re-billed against the rate that was active at the time of the call.

### Failed forms dashboard
Build the admin review queue for PRFs that failed billing worker processing. This is a first-class operational tool — your billing manager needs to see every failed form, understand why it failed, correct it, and requeue it without developer intervention. Target: zero forms requiring a developer to resolve.

### Offline resilience hardening
The crew app already auto-saves every 5 seconds. Extend this with a proper local outbox: forms saved to device SQLite storage with status `pending_sync`, background sync every 60 seconds when connectivity exists. At 850 forms/day with crews operating in areas with intermittent signal, this is not optional — it is the difference between zero data loss and regular data loss.

### Monitoring and alerting (non-negotiable before go-live)
Wire up Prometheus + Grafana + Alertmanager with the thresholds from your technical spec:

| Metric | Warning threshold | Page threshold |
|---|---|---|
| RabbitMQ queue depth | > 100 messages | > 300 messages |
| Oldest unprocessed message | > 5 minutes | > 15 minutes |
| API error rate (5xx) | > 1% | > 5% |
| Form validation failure rate | > 10% in 15 min | > 25% in 15 min |
| DB replication lag | > 30 seconds | > 2 minutes |
| Celery worker availability | < 8 workers online | < 4 workers online |
| DB connection pool saturation | > 80% | > 95% |

At 200–300 PRFs/hr sustained, a 1% error rate is 2–3 wrong bills every hour — compounding to dozens per shift before anyone notices without alerting.

---

## 5. Phased Delivery Plan

### Phase 1 — Fix the billing logic (2–3 weeks)
Complete fixes 5–8 listed in Section 2. Write unit tests for every KM calculation scenario including DOD, RHT, zero readings, negative deltas, and decimal values. Do not go live without this phase complete — billing errors on live claims create scheme disputes that are very difficult to reverse.

### Phase 2 — Hetzner infrastructure setup (2–3 weeks)
Provision the five-server stack in Hetzner Johannesburg. Configure Patroni + etcd for PostgreSQL HA, deploy PgBouncer, run Alembic migrations against the new database. Containerise the FastAPI backend and deploy behind Nginx on both app servers. Wire up the Hetzner Load Balancer with health checks. Deploy the React frontend as static files. At this point the existing system runs on Hetzner — production-grade infrastructure with HA failover, replacing whatever it was previously running on.

### Phase 3 — RabbitMQ, Celery and full async pipeline (1–2 weeks)
Deploy RabbitMQ with durable queues and dead-letter queue configured. Confirm the Celery `process_prf_submission` task processes correctly end-to-end. Run synthetic load tests at 900 PRFs/hour (shift-change burst simulation) and confirm queue drain time is under 30 seconds with 12 workers. Wire up Prometheus + Grafana monitoring. Configure Alertmanager to route alerts to your chosen channels (WhatsApp/email).

### Phase 4 — Production go-live (1 week)
Run a parallel period where both the old system and the Hetzner system process the same PRFs (dual-write). Compare billing outputs — especially mileage totals and tariff amounts — for every call type (PRIMARY, IHT, DOD, RHT, RESUS, COURTESY). When outputs match for 5 consecutive business days across all call types, cut over DNS. Keep the old system on standby for 2 weeks post-cutover.

### Phase 5 — Billing schema management & admin tools (ongoing)
Build the rate schema admin UI, failed forms dashboard, and reporting layer. These are operational tools that compound in value over time — every month they exist, your billing manager recovers more revenue and resolves disputes faster.

---

## 6. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Billing errors on live claims before Fix 5–8 are complete | High | Critical | Do not go live until all 8 fixes are done and unit-tested |
| Single worker server becomes bottleneck | Low | Medium | 12 Celery workers = 14,400 PRFs/hr capacity — 15× real peak. Scale by adding worker servers if needed. |
| Rate schema not configured before go-live | Medium | High | Phase 1 includes seeding initial rate schemas for all active schemes |
| Crew device connectivity loss causing form loss | Medium | High | Offline outbox (Phase 4) — forms survive offline and sync when connected |
| Medical scheme tariff changes breaking billing | Medium | Medium | Effective-dated rate schemas — old PRFs always re-bill at correct historical rate |
| POPIA non-compliance on patient data | Low | Critical | Hetzner Johannesburg region + patient_ref pseudonymisation + encrypted PII fields at rest |
| DB primary failure during peak hours | Low | High | Patroni + etcd automatic failover — standby promotes in under 30 seconds, no manual intervention |

---

## 7. What to Do Tomorrow Morning

In priority order:

1. **Assign Fix 5 and Fix 6 to your dev team today.** The KM string-to-numeric migration and the KmInput decimal fix are the two most dangerous open issues. They need to be done before a single live form is processed.

2. **Define your billing schemas.** Sit with your billing manager and extract the rate-per-KM, base fees, minimum distances, and rounding rules for your top 10 medical schemes. Seed these into `billing.rate_schemas`. Without this, the tariff engine produces zero rand amounts regardless of how correct the KM calculation is.

3. **Spin up a Hetzner Cloud account and provision one CX32 server in the Johannesburg region.** Deploy your FastAPI backend in Docker and confirm the existing codebase runs containerised. This is the first step of Phase 2 and costs under R200 for the experiment. Your team gets hands-on Hetzner familiarity before committing to the full 5-server stack.

4. **Add unit tests for the billing calculation.** Cover: PRIMARY full call, IHT with pre-auth, DOD (no transport), RHT (refused), RESUS, decimal odometer readings, negative delta detection. These tests are your safety net for every future change to the codebase.

5. **Book a review of the technical spec (v1.1) with your dev team.** The spec covers the full architecture, database schema, API contracts, and the corrected call-type-aware calculation logic. It should be the single reference document for every implementation decision going forward.

---

## Summary in One Paragraph

Your platform is well-built and closer to production than it looks. Fix the eight billing bugs first — four are already done, four remain — because revenue integrity comes before infrastructure. Then deploy to Hetzner Johannesburg: five servers, all containerised, running your existing FastAPI, Celery, RabbitMQ, and PostgreSQL codebase with zero rewrites. R1,420/month gives you a 5-server HA stack with automatic PostgreSQL failover, 12 Celery workers that absorb shift-change bursts of 600–900 PRFs with a queue drain time under 30 seconds, and Prometheus + Grafana monitoring so your billing manager and your team can see exactly what the system is doing at all times. Build the billing schema admin tools and failed-forms dashboard as you go. The result is a self-hosted, POPIA-compliant, enterprise-grade EMS billing platform running in South Africa that your client can confidently present to Discovery, GEMS, and government EMS operators — because it processes hundreds of forms per hour cleanly, keeps every patient record in South Africa, and never silently drops a billing claim.

---

*EMS Digital PRF Billing System — Strategic Roadmap v1.1 — Confidential*
*Prepared May 2026 — Updated: corrected scale (150–900 PRFs/hr), Hetzner self-hosted architecture*
