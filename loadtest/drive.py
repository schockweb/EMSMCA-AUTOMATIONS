"""
Load driver for the EMS portal, run from the host against the isolated stack.

    python loadtest/drive.py --scenario shift   --users 500 --seconds 90
    python loadtest/drive.py --scenario burst   --users 500
    python loadtest/drive.py --scenario office  --users 50  --seconds 60

WHY THERE ARE THREE SCENARIOS, NOT ONE
--------------------------------------
The Digital PRF runs ON THE CREW'S DEVICE. Crews do not hold a server session
through a call: the form lives in local storage, autosaves locally, and talks to
the server on a slow cadence. "500 users at once" therefore does NOT mean 500
concurrent request streams, and a benchmark that models it that way measures a
system nobody is going to build.

  shift   What 500 crews on duty actually generate. Each runs a full call:
          create, a realistic number of autosaves spaced the way a crew types,
          then submit. Request RATE is low by design. This answers "does the
          normal day work".

  burst   The failure mode offline-first actually has. 500 devices come back
          into coverage at once - end of shift, a tower recovering, everyone
          arriving at the same hospital - and flush their queued work
          simultaneously with ZERO think time. This is the number that matters.

  office  Back-office concurrency, dominated by provider PRF search. That query
          is `cast(form_data, Text).ilike(...)` across a table whose rows average
          150 KB in production, fired on a 400 ms debounce with no minimum term
          length, so every keystroke after the third is a fresh full scan.

Reports per-endpoint p50/p95/p99, error rates and throughput. Latency is
measured per request from just before send to fully-read response.
"""
from __future__ import annotations

import argparse
import asyncio
import os
import random
import statistics
import time
import uuid
from collections import defaultdict

import httpx

# RUN THIS INSIDE THE DOCKER NETWORK, NOT FROM THE WINDOWS HOST.
#
# The first runs went through the published port on localhost:8100 and reported
# 148-SECOND response times at 500 concurrent — while the backend sat at 0.5%
# CPU and PostgreSQL showed 79 idle connections and not one lock wait. The
# platform was doing nothing. Every one of those seconds was Docker Desktop's
# userspace port proxy on Windows serialising 500 connections, plus 500 separate
# httpx clients in a single Python process.
#
# A benchmark that measures the test rig is worse than no benchmark, because it
# produces a confident number. Set HOST=http://lt_backend:8000 and run from a
# container on lt_net.
HOST = os.getenv("LT_HOST", "http://localhost:8100")
CREW_PASSWORD = "LoadTest-Crew-Pw-2026!"

results: dict[str, list[float]] = defaultdict(list)
errors: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
_lock = asyncio.Lock()


def record(name: str, dt: float, status: int) -> None:
    results[name].append(dt)
    if status >= 400 or status == 0:
        errors[name][str(status)] += 1


async def timed(client: httpx.AsyncClient, method: str, url: str, name: str, **kw):
    t0 = time.perf_counter()
    try:
        r = await client.request(method, url, **kw)
        dt = time.perf_counter() - t0
        record(name, dt, r.status_code)
        return r
    except Exception:
        record(name, time.perf_counter() - t0, 0)
        return None


async def login(client: httpx.AsyncClient, email: str) -> str | None:
    r = await timed(client, "POST", "/api/crew/login", "POST /api/crew/login",
                    json={"email": email, "password": CREW_PASSWORD})
    if r is not None and r.status_code == 200:
        return r.json().get("access_token")
    return None


def _form(n: int) -> dict:
    return {
        "call_type": "PRIMARY",
        "patient_name": "Load", "patient_surname": f"Test{n}",
        "medical_scheme": "GEMS",
        "events_hpi": "Simulated narrative for autosave %d. " % n * 20,
        "vitals_sets": [{"hr": "80", "bp": "120/80", "spo2": "98", "resp": "16",
                         "temp": "36.8", "gcs_e": "4", "gcs_v": "5", "gcs_m": "6"}],
    }


async def one_call(client: httpx.AsyncClient, email: str, autosaves: int,
                   think: tuple[float, float], deadline: float) -> None:
    """One PRF from creation to submit, the way a crew works through it."""
    token = await login(client, email)
    if not token:
        return
    h = {"Authorization": f"Bearer {token}"}

    r = await timed(client, "POST", "/api/digital-prf", "POST /api/digital-prf (create)",
                    json={}, headers=h)
    if r is None or r.status_code != 201:
        return
    prf_id = r.json().get("id")
    base = r.json().get("updated_at")

    for n in range(autosaves):
        if time.time() > deadline:
            return
        payload = {"form_data": _form(n)}
        if base:
            payload["client_base_updated_at"] = base
        r = await timed(client, "PATCH", f"/api/digital-prf/{prf_id}",
                        "PATCH /api/digital-prf (autosave)", json=payload, headers=h)
        if r is not None and r.status_code == 200:
            base = r.json().get("updated_at") or base
        elif r is not None and r.status_code == 409:
            g = await timed(client, "GET", f"/api/digital-prf/{prf_id}",
                            "GET /api/digital-prf", headers=h)
            if g is not None and g.status_code == 200:
                base = g.json().get("updated_at")
        if think[1] > 0:
            await asyncio.sleep(random.uniform(*think))

    await timed(client, "POST", f"/api/digital-prf/{prf_id}/submit",
                "POST /api/digital-prf/submit", headers=h)


async def one_call_token(client: httpx.AsyncClient, token: str, autosaves: int,
                         think: tuple[float, float], deadline: float) -> None:
    """One PRF, using a token the crew already holds. See mint_tokens.py: a crew
    token lasts 12 hours with no refresh, so a crew authenticates ONCE at the
    start of a shift, not once per call."""
    h = {"Authorization": f"Bearer {token}"}
    r = await timed(client, "POST", "/api/digital-prf", "POST /api/digital-prf (create)",
                    json={}, headers=h)
    if r is None or r.status_code != 201:
        return
    body = r.json()
    prf_id, base = body.get("id"), body.get("updated_at")

    for n in range(autosaves):
        if time.time() > deadline:
            return
        payload = {"form_data": _form(n)}
        if base:
            payload["client_base_updated_at"] = base
        r = await timed(client, "PATCH", f"/api/digital-prf/{prf_id}",
                        "PATCH /api/digital-prf (autosave)", json=payload, headers=h)
        if r is not None and r.status_code == 200:
            base = r.json().get("updated_at") or base
        elif r is not None and r.status_code == 409:
            g = await timed(client, "GET", f"/api/digital-prf/{prf_id}",
                            "GET /api/digital-prf", headers=h)
            if g is not None and g.status_code == 200:
                base = g.json().get("updated_at")
        if think[1] > 0:
            await asyncio.sleep(random.uniform(*think))

    await timed(client, "POST", f"/api/digital-prf/{prf_id}/submit",
                "POST /api/digital-prf/submit", headers=h)


async def crew_worker(i: int, tokens: list[str], scenario: str, deadline: float,
                      client: httpx.AsyncClient) -> None:
    token = tokens[i % len(tokens)]
    if True:
        if scenario == "burst":
            # A device flushing what it queued while offline: no think time at
            # all, everything at once. This is what a tower coming back does.
            await one_call_token(client, token, autosaves=8, think=(0, 0), deadline=deadline)
        else:
            # A real 45-minute call: ~20 autosaves, 20-30 s apart. Compressed
            # here so a run finishes, but the RATIO of work to wait is kept.
            while time.time() < deadline:
                await one_call_token(client, token, autosaves=6, think=(1.5, 3.0),
                                     deadline=deadline)
                await asyncio.sleep(random.uniform(2, 5))


async def login_storm_worker(i: int, providers: int, crew_per: int) -> None:
    """Shift change: everyone authenticates at once. Measured on its own because
    the auth limiter caps this at 15/60s PER CLIENT IP, and crews on a shared
    base WiFi or carrier NAT present as one IP."""
    email = f"crew{i % providers:03d}-{(i // providers) % crew_per:02d}@loadtest.local"
    async with httpx.AsyncClient(base_url=HOST, timeout=120.0) as client:
        await login(client, email)


async def office_worker(token: str, provider_ids: list[str], deadline: float) -> None:
    h = {"Authorization": f"Bearer {token}"}
    terms = ["Nkosi", "chest", "GEMS", "Thabo", "MVA", "seiz", "Bot", "Prim"]
    limits = httpx.Limits(max_connections=4, max_keepalive_connections=4)
    async with httpx.AsyncClient(base_url=HOST, timeout=120.0, limits=limits) as client:
        while time.time() < deadline:
            pid = random.choice(provider_ids)
            # A search box on a 400 ms debounce: a 6-letter term typed at speed
            # sends roughly this many queries, each a fresh full scan.
            term = random.choice(terms)
            for k in range(3, len(term) + 1):
                if time.time() > deadline:
                    return
                await timed(client, "GET", f"/api/providers/{pid}/prfs",
                            "GET /api/providers/{id}/prfs (search)",
                            params={"search": term[:k], "limit": 25}, headers=h)
                await asyncio.sleep(0.4)
            await timed(client, "GET", f"/api/providers/{pid}/prfs",
                        "GET /api/providers/{id}/prfs (list, no search)",
                        params={"limit": 25}, headers=h)
            await asyncio.sleep(random.uniform(1, 3))


def report(users: int, scenario: str, elapsed: float) -> None:
    total = sum(len(v) for v in results.values())
    errs = sum(sum(d.values()) for d in errors.values())
    print()
    print("=" * 96)
    print(f"  scenario={scenario}  concurrency={users}  wall={elapsed:.1f}s  "
          f"requests={total}  throughput={total / elapsed:.1f}/s  "
          f"errors={errs} ({100 * errs / max(total, 1):.2f}%)")
    print("=" * 96)
    print(f"  {'endpoint':<44} {'n':>6} {'p50':>8} {'p95':>8} {'p99':>8} {'max':>8}  errors")
    print("  " + "-" * 92)
    for name in sorted(results, key=lambda k: -statistics.median(results[k] or [0])):
        v = sorted(results[name])
        if not v:
            continue
        p = lambda q: v[min(len(v) - 1, int(len(v) * q))] * 1000  # noqa: E731
        e = errors.get(name) or {}
        estr = ", ".join(f"{k}x{n}" for k, n in sorted(e.items())) if e else ""
        print(f"  {name:<44} {len(v):>6} {p(0.50):>7.0f}m {p(0.95):>7.0f}m "
              f"{p(0.99):>7.0f}m {v[-1] * 1000:>7.0f}m  {estr}")
    print()


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenario", choices=["shift", "burst", "office", "loginstorm"],
                    default="shift")
    ap.add_argument("--tokens", default="loadtest/tokens.txt")
    ap.add_argument("--users", type=int, default=100)
    ap.add_argument("--seconds", type=int, default=60)
    ap.add_argument("--providers", type=int, default=105)
    ap.add_argument("--crew-per", type=int, default=14)
    ap.add_argument("--admin-email", default="admin@emsclaims.co.za")
    ap.add_argument("--admin-password", default=os.getenv("LT_ADMIN_PW", ""))
    args = ap.parse_args()

    deadline = time.time() + args.seconds
    t0 = time.perf_counter()

    if args.scenario == "office":
        async with httpx.AsyncClient(base_url=HOST, timeout=60.0) as c:
            r = await c.post("/api/auth/login",
                             data={"username": args.admin_email, "password": args.admin_password})
            if r.status_code != 200:
                raise SystemExit(f"admin login failed: {r.status_code} {r.text[:200]}")
            token = r.json()["access_token"]
            pr = await c.get("/api/providers", headers={"Authorization": f"Bearer {token}"},
                             params={"limit": 50})
            ids = [p["id"] for p in (pr.json() if isinstance(pr.json(), list)
                                     else pr.json().get("items", []))]
            if not ids:
                raise SystemExit("no providers returned")
        tasks = [office_worker(token, ids, deadline) for _ in range(args.users)]
    elif args.scenario == "loginstorm":
        tasks = [login_storm_worker(i, args.providers, args.crew_per)
                 for i in range(args.users)]
    else:
        import pathlib
        lines = [ln.split("\t")[0] for ln in
                 pathlib.Path(args.tokens).read_text().splitlines() if ln.strip()]
        if not lines:
            raise SystemExit(f"no tokens in {args.tokens} — run mint_tokens.py first")
        # ONE client, pooled. 500 clients meant 500 connection pools and
        # 500 SSL contexts built on one event loop, which cost more than the
        # requests did.
        limits = httpx.Limits(max_connections=args.users + 50,
                              max_keepalive_connections=args.users + 50)
        shared = httpx.AsyncClient(base_url=HOST, timeout=180.0, limits=limits)
        tasks = [crew_worker(i, lines, args.scenario, deadline, shared)
                 for i in range(args.users)]

    await asyncio.gather(*tasks, return_exceptions=True)
    try:
        await shared.aclose()          # noqa: F821
    except NameError:
        pass
    report(args.users, args.scenario, time.perf_counter() - t0)


asyncio.run(main())
