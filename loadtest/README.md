# Digital PRF — Load & Stress Test Kit

Tools to prove the Digital PRF stays **fast** and **correct** under the load of
105 client companies and their crews, including 06:00/18:00 shift-change bursts.

> ⚠️ **Run against STAGING, never production.** All scripts write real data.
> Fixtures use `loadtest-*` slugs so they're easy to find and delete.

## Contents

| File | Purpose |
|------|---------|
| `seed_loadtest_data.py` | Creates providers, crews (known logins), and vehicles; writes `loadtest_fixtures.json`. |
| `locustfile.py` | Load + burst harness: simulates crews running the full PRF lifecycle. |
| `concurrency_checks.py` | Correctness-under-load assertions (uniqueness, tenant isolation, concurrency, validation). |
| `requirements.txt` | `locust` + `httpx`. |

## Quickstart

```bash
# 0. Install tooling (use the backend venv so app.* imports work for seeding)
pip install -r loadtest/requirements.txt

# 1. Seed fixtures (run from backend/ so the .env / app models load)
cd backend
python ../loadtest/seed_loadtest_data.py --providers 2 --crews-per-provider 60
cd ..

# 2. Correctness under load (fast, ~1 min) — do this FIRST
python loadtest/concurrency_checks.py \
  --host https://staging.your-emr.co.za \
  --fixtures loadtest/loadtest_fixtures.json --storm 300

# 3. Load test with the live dashboard
export LOADTEST_FIXTURES=loadtest/loadtest_fixtures.json
locust -f loadtest/locustfile.py --host https://staging.your-emr.co.za
#   → open http://localhost:8089, set users + spawn rate

# 4. Headless shift-change burst (steady → spike → recover), CSV output
USE_SHAPE=1 SUSTAINED_USERS=60 BURST_USERS=400 \
  locust -f loadtest/locustfile.py --host https://staging.your-emr.co.za \
  --headless --csv results
```

## What each part exercises

**`locustfile.py`** — every virtual user logs in as a crew member and loops:
create draft → mark timestamps (with GPS) → ~6 autosaves (sending the
optimistic-concurrency token) → submit. Tune with `AUTOSAVES_PER_PRF`,
`SUBMIT_RATIO`, and the `USE_SHAPE`/`*_USERS` env vars. Watch the dashboard for
p95/p99 latency, RPS, and failure rate while you also watch your server metrics
(DB connections, RabbitMQ queue depth, Celery lag, CPU/RAM).

**`concurrency_checks.py`** — the assertions that catch *silent* failures:
1. fires N concurrent creates and verifies every `prf_number` is unique;
2. confirms a crew from Provider B gets **404** on Provider A's PRF (read + every mutation);
3. confirms a stale autosave is rejected with **409**;
4. confirms editing a submitted PRF returns **409**;
5. confirms a blank PRF submit returns **422**;
6. reports whether the per-token rate limiter engages (informational).

Exit code is non-zero if any hard check fails, so it drops straight into CI.

## Cleanup

```bash
cd backend && python ../loadtest/seed_loadtest_data.py --teardown
```

See `../../Digital_PRF_Stress_Test_Strategy.md` for the full strategy: scenarios,
metrics, pass/fail thresholds, soak/chaos testing, and the go-live gate.
