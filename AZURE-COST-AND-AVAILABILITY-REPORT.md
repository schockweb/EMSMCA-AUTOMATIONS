# Azure cost and 24/7 availability report

**Prepared 2026-08-06** · portal.emsmca.co.za · for the client-subscription migration

Two questions are answered here, both directly:

1. **Can the recommended build carry more than 1500 concurrent users?** Yes, with
   large margin, and the evidence is measurement rather than estimation.
2. **Will it be up 24/7?** Not as quoted. The build as specified carries a
   contractual floor of **99.4%** — about **4 hours 19 minutes of permitted
   downtime every month** — and two cheap changes take that to **48 minutes**.

Every figure below is either measured on the running system, or taken from
Microsoft's published SLA and the Azure Retail Prices API (South Africa North,
ZAR, retrieved 2026-08-06).

---

## 1. A correction to something I told you earlier today

I reported that the production VM shows **0.0000% CPU steal time** and presented
that as evidence the burstable VM has never been throttled.

**That evidence was worthless, and I should not have offered it.** Azure's
hypervisor does not implement the Linux paravirtualised steal clock, and B-series
credit throttling is a quota cap rather than scheduler contention in any case.
`top`, `vmstat`, `sar` and `node_exporter` are all blind to it. A B-series VM
that is being actively throttled reads **0.00% steal**, exactly like one that is
not.

The conclusion I drew happens to still hold — the load figures below show the VM
is nowhere near its baseline — but it holds for a different reason, and the only
authoritative signal is the Azure Monitor metric **`CPU Credits Remaining`**.
That metric is not currently being watched.

---

## 2. Cost summary

### As quoted

| Line | ZAR/month |
|---|---|
| Compute — B4as v2 (4 vCPU, 16 GB, burstable) | 2,884.56 |
| Azure SQL Database (Gen5, 1–4 vCore, 32 GB) | 16,490.25 |
| VPN Gateway VpnGw1AZ | 2,828.00 |
| Microsoft Defender for Cloud | 546.05 |
| Storage account — Blob, 1 TB | 436.64 |
| Managed disk — Standard SSD E10 (128 GB) | 262.25 |
| Azure Backup | 251.20 |
| Static public IP | 67.33 |
| **Total** | **23,766.28** |

≈ USD 1,444/month ≈ **USD 47/day**, against the **USD 10/day** the current system costs.

### Recommended

| Line | Change | ZAR/month |
|---|---|---|
| Compute — keep **B4s_v2** burstable (the SKU already in production) | keep | ~2,343 |
| **PostgreSQL Flexible Server**, General Purpose D2ds_v5, 2 vCore / 8 GiB, no HA | replaces Azure SQL | 2,823.71 |
| PostgreSQL storage, 128 GB Premium SSD | new line — see §5 | ~318 |
| Managed disk — **Premium SSD P10** (128 GB) | upgrade from Standard SSD | ~500 |
| Azure Backup | keep | 251.20 |
| Defender for Servers **Plan 1** | downgrade from the bundle | 80.74 |
| Static public IP | keep | 67.33 |
| Blob storage, right-sized to ~100 GB | down from 1 TB | ~50 |
| Monitoring + alerting (see §6) | new | ~40 |
| Private DNS zone | new | 8.23 |
| VPN Gateway | **dropped** | 0 |
| **Total** | | **≈ 6,482** |

≈ USD 394/month ≈ **USD 13/day**. A saving of **R17,284/month (~R207,000/year)**
against the quote, while *improving* the availability floor.

On a 1-year reservation for compute and database this falls to roughly
**USD 8/day** — cheaper than today, with a larger database.

**One caveat on the quote itself:** its `B4as v2` line reads R2,884.56 where
Azure's published ZAR list is R2,343.08 — about 23% high, consistent with pricing
in USD and converting at ~R20.3 rather than Azure's own ZAR sheet at ~R16.46.
Every line is likely inflated by roughly that much.

---

## 3. Can it carry 1500+ concurrent users?

**Yes — by a factor of roughly three, and this is measured, not modelled.**

The Patient Report Form is an offline-first PWA running on the crew's phone. A
crew on an active call syncs about once every 25 seconds; they do not hold a
server connection. So concurrency converts to request rate by dividing by the
sync cadence, not by a click-think-time of 1–8 seconds.

| | |
|---|---|
| 1500 concurrent crew | **60 requests/second** |
| Measured capacity, same CPU budget as the VM | **188 req/s, zero errors** |
| CPU cost per request (measured) | ~12 ms |
| Throughput per saturated vCPU | ~82 req/s |
| **Headroom at 1500 crew** | **3.1×** |
| Crew needed to actually reach 188 req/s | ~4,700 — three times the target workforce |

Measured live on the production VM today: **load average 0.09 / 0.05 / 0.05** on
4 vCPU (~1.3%), **2.7 GB of 15 GB** memory in use.

### The burstable question, answered properly

`Standard_B4s_v2` guarantees a baseline of **40% of the VM = 1.6 vCPU** sustained,
free, forever. Above that it spends banked credits.

- Projected steady state at 1500 crew: **0.72 vCPU = 18% of the VM.**
- That is *below* baseline, so the VM **banks ~53 credits/hour** and sits pinned
  at its 2,304 cap rather than draining.
- Even with the bank fully empty, the throttled floor of 1.6 vCPU still serves
  **~133 req/s** against the 60 req/s required — a **2.2× margin**.

**Burstable is a genuine fit for this workload, not a corner being cut.** The
risk is not capacity; it is detection (see §1 and §6). The escape hatch — resize
to `D4as_v5` — is a reboot, not a migration.

### Where it would actually bend first

| Cliff | Measured | Status |
|---|---|---|
| Sign-in rate limit | 200 crew from one IP → 75% rejected | **Fixed** 2026-08-03 |
| PRF search cost | 146 ms → 6 ms | **Fixed** 2026-08-03 |
| Redis outage browning out the API | ~3 s → 267 ms per login | **Fixed** 2026-08-04 |
| Connection pool ceiling | p99 5–13 s past ~100 concurrent *streams* | Not reached at 60 req/s |
| `max_connections` pinned to 200 in `infra/DEPLOY-AZURE.md` | app peak is 200 from the web tier alone | **MUST FIX — see §7** |

---

## 4. Will it be up 24/7?

**Not as quoted.** Here is the arithmetic, using Microsoft's published SLA.

| Configuration | SLA | Permitted downtime / month |
|---|---|---|
| Single VM, **Standard SSD** (the quoted E10) | 99.5% | **216 min (3 h 36 m)** |
| Single VM, **Premium SSD** | 99.9% | 43.2 min |
| PostgreSQL Flexible Server, no HA | 99.9% | 43.2 min |
| PostgreSQL, zone-redundant HA | 99.99% | 4.3 min |

Both tiers must be up to serve a request, so the SLAs multiply:

| Build | Composite | Downtime / month |
|---|---|---|
| **As quoted** (Standard SSD + no DB HA) | 99.4005% | **259 min — 4 h 19 m** |
| + database HA only (**+R2,824/mo**) | 99.4901% | 220 min — *saves 39 min* |
| + **Premium disk only** (**+~R240/mo**) | 99.8001% | 86 min — *saves 173 min* |
| + both | 99.8900% | **48 min** |

**The single most cost-effective availability change in this entire report is
upgrading the OS disk from Standard SSD to Premium SSD.** It recovers 4.4× more
downtime than database HA for roughly a twelfth of the price. The VM contributes
**83%** of the quoted build's downtime budget, and the disk tier is what caps it.

Do the disk first. Do not buy database HA yet.

### What actually interrupts it

- **VM host maintenance:** over 90% is now rebootless — sub-10-second pauses with
  15 minutes' notice. Realistic planning figure: **1–3 reboot-causing events per
  year.** The VM is not the frequent interrupter.
- **PostgreSQL without HA:** Microsoft documents impactful maintenance downtime
  roughly **monthly — ~12 planned outages a year.** This is the dominant source of
  interruption in the recommended build, and it is the honest counter-argument to
  "don't buy HA yet".
- **Availability-zone failure:** single-zone means an unbounded outage. Azure will
  not fail you over and will not notify you.
- **Scheduled Events:** the build has no consumer, so every 15-minute maintenance
  warning Azure offers is currently discarded.

### What the SLA does *not* cover

The SLA measures **TCP/UDP connectivity only**. Our measured 5–13 s p99
degradation under overload, and any B-series credit throttling, are both
contractually **100% uptime**. Host maintenance reboots are explicitly carved out
of the calculation. The remedy is a service credit capped at the VM's own monthly
fee — roughly **R230** for a 10% credit.

**A service credit does not help an ambulance crew at a roadside.** Treat the SLA
as a floor for procurement, not as an operational plan.

---

## 5. The line nobody has costed: storage growth

Compute is a solved problem at this scale. **Storage is what compounds.**

Production averages **347,574 bytes on disk per PRF** — these records are mostly
base64 signatures, ID captures and scene photos.

| | |
|---|---|
| At 500 vehicles × ~4 calls/day | ~2,000 PRFs/day |
| | **~695 MB/day** |
| | **~21 GB/month** |
| | **~250 GB/year** |
| Medical-record retention | **7 years → ~1.75 TB** |

At Premium SSD (R2.4855/GB-month) the database storage line alone runs roughly
**R620/month at the end of year 1**, **R1,860/month by year 3**, and **R4,350/month
by year 7** — eventually exceeding the compute and database compute lines combined.

This is not a reason to delay. It *is* a reason to (a) budget for it, and (b)
finish moving uploads to Blob storage, where the same bytes cost a fraction of
Premium SSD.

---

## 6. What "24/7" requires operationally

The gap between the current system and a 24/7 one is **not capacity, and not
mostly money — it is alerting.** Credible monitoring for this build costs about
**R40/month**, because most of what matters is free.

| Item | Cost |
|---|---|
| Resource Health alerts (VM + PostgreSQL) | R0 |
| Service Health alert (South Africa North) | R0 |
| 9 metric alerts | R0 — first 10 time series free |
| Email + mobile push notifications | R0 — first 1,000/month free |
| 3 log alerts | R24.69 |
| SMS to +27, ~30/month | R12.31 |
| Log Analytics (stay under 5 GB/month) | R0 |

**The single highest-value item is already written and needs a URL pasted in.**
`deploy/ops/backup-verify.sh` and `backup-offsite.sh` already call a
healthchecks.io endpoint on success and `/fail` on failure. `HEALTHCHECK_URL` is
**unset**, so six scheduled jobs — including the nightly `pg_dump` — currently
fail silently.

The alert that matters most for the burstable decision: **`CPU Credits Remaining`**
— warn below 1,152 (half the bank), critical below 460 (about 3 hours of runway).

### What is already working, verified today

| | |
|---|---|
| Nightly backup (02:00) | ran — 14 MB database, 456 KB uploads |
| Backup verification (07:30) | ran — passed |
| **Weekly restore rehearsal (Sun 05:00)** | ran 2026-08-02 — **passed**, fingerprint matched across 80 finalised PRFs |
| Ops crons installed | all 6 |
| Exposed ports | 22 (key-only, root and passwords disabled), 80, 443 |
| Fault monitor | live, 10 probes, 5-minute sweep |

Backups on this platform are provably restorable, unattended, weekly. That is
further than most systems of this size ever get.

---

## 7. Must-fix before go-live

1. **`max_connections` is pinned to 200** in `infra/DEPLOY-AZURE.md:155`. The
   application opens up to 200 from the web tier alone (4 workers × pool 20 +
   overflow 30) before Celery, and Azure reserves ~15 for management. This is a
   connection-exhaustion outage on the first busy shift. Either remove the pin
   (the tier default is 859) or reduce the pool deliberately.

2. **`AZURE_SAS_URL` is unset.** The backend has no Blob SDK, so every uploaded
   PDF, provider logo and crew photo lives on the VM's disk, and the nightly
   archive is written to that same disk. **That VM is currently the only copy of
   every attachment.** This is also why the Azure Backup line must stay.

3. **`HEALTHCHECK_URL` is unset.** See §6.

4. **Choose PostgreSQL networking at creation.** Public access vs VNet
   integration is **fixed at server creation** and cannot be changed afterwards
   without a migration. Choose VNet integration.

5. **Upgrade the OS disk to Premium SSD.** §4 — the cheapest availability
   improvement available.

---

## 8. Recommendation

**Go live on the recommended build.** It carries 1500 concurrent crew with 3×
headroom on measured numbers, at about **USD 13/day** — roughly a quarter of the
quoted cost and close to what you already pay.

Two things to be honest with the client about:

- **It is a single VM in a single zone.** The contractual floor with the Premium
  disk is 99.8% — about 86 minutes a month — and a zone failure is an unbounded
  outage. That is a deliberate, defensible choice at this scale and price. It
  should be a decision on record, not a discovery at 03:00.
- **The database without HA takes planned maintenance roughly monthly.** If the
  client's expectation is genuinely "no interruption, ever", that is the line item
  to revisit first — but only *after* the Premium disk, which buys more uptime for
  less money.

Neither of those is a reason to delay go-live. Both are reasons to arm the
alerting first, so that when something does happen, you find out before a crew
does.
