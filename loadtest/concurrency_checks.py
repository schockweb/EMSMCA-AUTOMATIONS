"""
Correctness-under-load checker for the Digital PRF.

Load tests prove the system stays *fast* under pressure. This proves it stays
*correct* under pressure — the bugs that matter at 105-client scale are silent
data corruption and cross-tenant leakage, not just latency. Each check targets a
specific guarantee from the go-live hardening:

  1. PRF-number uniqueness under a concurrent create storm   (no collisions)
  2. Tenant isolation                                        (no cross-company access)
  3. Optimistic concurrency                                   (stale save → 409)
  4. Frozen-after-submit                                      (editing submitted PRF → 409)
  5. Server-side submit validation                            (blank PRF → 422)
  6. Rate limiting                                            (token over limit → 429) [informational]

Run against a STAGING stack after seeding fixtures:

    pip install httpx
    python concurrency_checks.py --host https://staging.your-emr.co.za \
        --fixtures ./loadtest_fixtures.json --storm 300

Exit code is non-zero if any hard check fails (CI-friendly).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path

import httpx

RESULTS: list[tuple[str, bool, str]] = []


def record(name: str, ok: bool, detail: str = ""):
    RESULTS.append((name, ok, detail))
    mark = "PASS" if ok else "FAIL"
    print(f"  [{mark}] {name}" + (f" — {detail}" if detail else ""))


async def login(client: httpx.AsyncClient, cred: dict) -> str | None:
    r = await client.post("/api/crew/login", json={"email": cred["email"], "password": cred["password"]})
    if r.status_code == 200:
        return r.json().get("access_token")
    return None


def auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


async def create_prf(client: httpx.AsyncClient, token: str, vehicle_id: str | None = None) -> httpx.Response:
    return await client.post("/api/digital-prf", headers=auth(token),
                             json={"vehicle_id": vehicle_id} if vehicle_id else {})


# ── 1. PRF-number uniqueness under concurrent creates ────────────────────────
async def check_prf_number_uniqueness(client, crews, storm: int):
    # Spread the storm across as many crews as we have to maximise real concurrency.
    tokens = []
    for cred in crews[: min(len(crews), 40)]:
        t = await login(client, cred)
        if t:
            tokens.append((t, cred.get("vehicle_id")))
    if not tokens:
        record("1. PRF-number uniqueness", False, "no crews could log in")
        return

    async def one(i):
        tok, veh = tokens[i % len(tokens)]
        try:
            r = await create_prf(client, tok, veh)
            if r.status_code == 201:
                return r.json().get("prf_number")
        except Exception:
            return None
        return None

    results = await asyncio.gather(*[one(i) for i in range(storm)])
    numbers = [n for n in results if n is not None]
    unique = set(numbers)
    ok = len(numbers) > 0 and len(unique) == len(numbers)
    record(
        "1. PRF-number uniqueness",
        ok,
        f"{len(numbers)} created, {len(unique)} unique"
        + ("" if ok else f" — {len(numbers) - len(unique)} COLLISION(S)"),
    )


# ── 2. Tenant isolation ──────────────────────────────────────────────────────
async def check_tenant_isolation(client, crews):
    providers = {}
    for c in crews:
        providers.setdefault(c["provider_slug"], c)
    if len(providers) < 2:
        record("2. Tenant isolation", False, "need crews from >=2 providers in fixtures")
        return
    (slug_a, crew_a), (slug_b, crew_b) = list(providers.items())[:2]

    tok_a = await login(client, crew_a)
    tok_b = await login(client, crew_b)
    if not tok_a or not tok_b:
        record("2. Tenant isolation", False, "could not log in both providers")
        return

    r = await create_prf(client, tok_a, crew_a.get("vehicle_id"))
    if r.status_code != 201:
        record("2. Tenant isolation", False, f"setup create failed: {r.status_code}")
        return
    pid = r.json()["id"]

    # Provider B must not be able to read or mutate Provider A's PRF.
    probes = [
        ("GET", await client.get(f"/api/digital-prf/{pid}", headers=auth(tok_b))),
        ("PATCH", await client.patch(f"/api/digital-prf/{pid}", headers=auth(tok_b),
                                     json={"form_data": {"hacked": True}})),
        ("mark-time", await client.post(f"/api/digital-prf/{pid}/mark-time", headers=auth(tok_b),
                                        json={"field": "time_on_scene"})),
        ("submit", await client.post(f"/api/digital-prf/{pid}/submit", headers=auth(tok_b))),
        ("DELETE", await client.delete(f"/api/digital-prf/{pid}", headers=auth(tok_b))),
    ]
    leaks = [f"{verb}={resp.status_code}" for verb, resp in probes if resp.status_code != 404]
    ok = not leaks
    record("2. Tenant isolation", ok, "all cross-tenant calls 404" if ok else f"LEAK: {leaks}")


# ── 3. Optimistic concurrency (stale save rejected) ──────────────────────────
async def check_optimistic_concurrency(client, crews):
    cred = crews[0]
    tok = await login(client, cred)
    if not tok:
        record("3. Optimistic concurrency", False, "login failed")
        return
    r = await create_prf(client, tok, cred.get("vehicle_id"))
    if r.status_code != 201:
        record("3. Optimistic concurrency", False, f"create failed: {r.status_code}")
        return
    pid = r.json()["id"]

    g = await client.get(f"/api/digital-prf/{pid}", headers=auth(tok))
    base0 = g.json().get("updated_at")

    # Let real time pass so the row advances beyond the 1s server tolerance.
    await asyncio.sleep(1.3)

    s1 = await client.patch(f"/api/digital-prf/{pid}", headers=auth(tok),
                            json={"form_data": {"call_type": "PRIMARY", "note": "v1"},
                                  "client_base_updated_at": base0})
    # Stale save: reuse the ORIGINAL base, which is now > tolerance behind.
    s2 = await client.patch(f"/api/digital-prf/{pid}", headers=auth(tok),
                            json={"form_data": {"call_type": "PRIMARY", "note": "v2-stale"},
                                  "client_base_updated_at": base0})
    ok = s1.status_code == 200 and s2.status_code == 409
    record("3. Optimistic concurrency", ok,
           f"fresh save={s1.status_code}, stale save={s2.status_code} (want 200 then 409)")


# ── 4. Frozen after submit ───────────────────────────────────────────────────
async def check_frozen_after_submit(client, crews):
    cred = crews[0]
    tok = await login(client, cred)
    if not tok:
        record("4. Frozen after submit", False, "login failed")
        return
    r = await create_prf(client, tok, cred.get("vehicle_id"))
    pid = r.json()["id"]
    # Make it valid enough to submit.
    await client.patch(f"/api/digital-prf/{pid}", headers=auth(tok), json={"form_data": {
        "call_type": "PRIMARY",
        "vitals_sets": [{"hr": "80", "bp": "120/80", "spo2": "98"}],
    }})
    sub = await client.post(f"/api/digital-prf/{pid}/submit", headers=auth(tok))
    if sub.status_code not in (200, 202):
        record("4. Frozen after submit", False, f"submit failed: {sub.status_code} {sub.text[:150]}")
        return
    edit = await client.patch(f"/api/digital-prf/{pid}", headers=auth(tok),
                              json={"form_data": {"call_type": "PRIMARY", "note": "post-submit edit"}})
    ok = edit.status_code == 409
    record("4. Frozen after submit", ok, f"edit after submit={edit.status_code} (want 409)")


# ── 5. Submit validation ─────────────────────────────────────────────────────
async def check_submit_validation(client, crews):
    cred = crews[0]
    tok = await login(client, cred)
    if not tok:
        record("5. Submit validation", False, "login failed")
        return
    r = await create_prf(client, tok, cred.get("vehicle_id"))
    pid = r.json()["id"]
    # Submit a completely blank PRF — must be rejected.
    sub = await client.post(f"/api/digital-prf/{pid}/submit", headers=auth(tok))
    ok = sub.status_code == 422
    record("5. Submit validation (blank PRF)", ok, f"blank submit={sub.status_code} (want 422)")


# ── 6. Rate limiting (informational) ─────────────────────────────────────────
async def check_rate_limiting(client, crews, fire: int = 360):
    cred = crews[0]
    tok = await login(client, cred)
    if not tok:
        record("6. Rate limiting", False, "login failed")
        return

    async def hit():
        try:
            r = await client.get("/api/crew/me", headers=auth(tok))
            return r.status_code
        except Exception:
            return 0

    codes = await asyncio.gather(*[hit() for _ in range(fire)])
    n429 = sum(1 for c in codes if c == 429)
    # Informational: a 429 proves the limiter engages per-token. Zero may simply
    # mean the configured limit is above `fire` — not a failure.
    record("6. Rate limiting (informational)", True,
           f"{n429}/{fire} requests got 429 (per-token limiter {'engaged' if n429 else 'not tripped at this volume'})")


async def main_async(host: str, fixtures_path: Path, storm: int):
    data = json.loads(fixtures_path.read_text())
    crews = data.get("crews", [])
    if not crews:
        print("No crews in fixtures; run seed_loadtest_data.py first.", file=sys.stderr)
        return 2

    limits = httpx.Limits(max_connections=100, max_keepalive_connections=50)
    async with httpx.AsyncClient(base_url=host, timeout=30.0, limits=limits, verify=True) as client:
        print(f"\nDigital PRF correctness-under-load checks against {host}\n")
        print(f"› Concurrent create storm (n={storm})")
        await check_prf_number_uniqueness(client, crews, storm)
        print("› Multi-tenant isolation")
        await check_tenant_isolation(client, crews)
        print("› Optimistic concurrency")
        await check_optimistic_concurrency(client, crews)
        print("› Frozen after submit")
        await check_frozen_after_submit(client, crews)
        print("› Submit validation")
        await check_submit_validation(client, crews)
        print("› Rate limiting")
        await check_rate_limiting(client, crews)

    hard_fail = [n for n, ok, _ in RESULTS if not ok]
    print("\n" + "=" * 60)
    print(f"  {len(RESULTS) - len(hard_fail)}/{len(RESULTS)} checks passed")
    if hard_fail:
        print("  FAILED: " + ", ".join(hard_fail))
    print("=" * 60)
    return 1 if hard_fail else 0


def main():
    ap = argparse.ArgumentParser(description="Digital PRF correctness-under-load checks.")
    ap.add_argument("--host", required=True, help="Base URL of the staging stack, e.g. https://staging.your-emr.co.za")
    ap.add_argument("--fixtures", default=str(Path(__file__).resolve().parent / "loadtest_fixtures.json"))
    ap.add_argument("--storm", type=int, default=300, help="Concurrent creates for the uniqueness test.")
    args = ap.parse_args()

    fixtures_path = Path(args.fixtures)
    if not fixtures_path.exists():
        print(f"Fixtures file not found: {fixtures_path}", file=sys.stderr)
        sys.exit(2)

    rc = asyncio.run(main_async(args.host.rstrip("/"), fixtures_path, args.storm))
    sys.exit(rc)


if __name__ == "__main__":
    main()
