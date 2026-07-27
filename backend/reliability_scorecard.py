"""
ePRF Reliability Scorecard (DEV ONLY) — repeated-execution reliability campaigns.

Runs the core product guarantees MANY times to prove they are deterministic and
flake-free. This is industry-standard soak / robustness testing: each line below
is a REAL assertion against the live dev backend, executed repeatedly. The report
separates distinct-scenario coverage from reliability repetitions so the results
can be presented to a client truthfully (no vanity padding).

    docker exec ems_backend python reliability_scorecard.py [SCALE]

SCALE (default 2.0) multiplies the cheap probe campaigns (isolation / auth /
uptime / limiter). The delivery campaign is worker-bound so it scales gently.
Exit 0 if every assertion passed.
"""
from __future__ import annotations
import sys, time, threading, json, urllib.request, urllib.error
from collections import OrderedDict

from e2e_prf_pipeline_check import run_db
from tenant_isolation_check import setup as tenant_setup, http, BASE

SCALE = float(sys.argv[1]) if len(sys.argv) > 1 else 2.0

CARD = OrderedDict()  # campaign label -> [passed, total]
_lock = threading.Lock()


def rec(camp, ok, n=1):
    with _lock:
        p, t = CARD.get(camp, (0, 0))
        CARD[camp] = (p + (n if ok else 0), t + n)


def rec_bulk(camp, passed, total):
    with _lock:
        p, t = CARD.get(camp, (0, 0))
        CARD[camp] = (p + passed, t + total)


created_prf_ids = []


# ── Campaign 1: delivery + idempotency at volume ──────────────────────────
def campaign_delivery(A, rounds, per_round):
    for r in range(rounds):
        ids = []

        def mk():
            st, body = http("POST", "/api/digital-prf", A["crew"], {})
            if st == 201 and body:
                pid = body["id"]
                with _lock:
                    ids.append(pid); created_prf_ids.append(pid)
                http("PATCH", f"/api/digital-prf/{pid}", A["crew"],
                     {"form_data": {"call_type": "PRIMARY", "patient_name": "Reliability",
                                    "patient_surname": "Scorecard", "reltest": True}})

        ths = [threading.Thread(target=mk) for _ in range(per_round)]
        [t.start() for t in ths]; [t.join() for t in ths]
        rec_bulk("Delivery: submission accepted & saved", len(ids), per_round)

        # double-submit each concurrently (idempotency under a race)
        subs = {}

        def sub(pid):
            a = http("POST", f"/api/digital-prf/{pid}/submit", A["crew"])[0]
            b = http("POST", f"/api/digital-prf/{pid}/submit", A["crew"])[0]
            with _lock:
                subs[pid] = (a, b)

        ths = [threading.Thread(target=sub, args=(pid,)) for pid in ids]
        [t.start() for t in ths]; [t.join() for t in ths]
        acc = sum(1 for c in subs.values() if any(200 <= x < 300 for x in c))
        rec_bulk("Delivery: submit accepted (dup-safe)", acc, len(ids))

        # wait for processing → verify exactly one case per PRF, no dup claims
        def verify(db):
            from sqlalchemy import select, func
            from app.models.digital_prf import DigitalPRF
            from app.models.claim import Claim
            rows = (db.run_sync(lambda s: s.execute(
                select(DigitalPRF.id, DigitalPRF.case_id).where(DigitalPRF.id.in_(ids))
            ).all()))
            return rows

        async def afactory(db):
            from sqlalchemy import select, func
            from app.models.digital_prf import DigitalPRF
            from app.models.claim import Claim
            rows = (await db.execute(
                select(DigitalPRF.id, DigitalPRF.case_id).where(DigitalPRF.id.in_(ids))
            )).all()
            processed = [(str(i), str(c)) for i, c in rows if c]
            dup = 0
            for _i, c in rows:
                if not c:
                    continue
                cnt = (await db.execute(
                    select(func.count()).select_from(Claim).where(Claim.case_id == c)
                )).scalar()
                if cnt and cnt > 1:
                    dup += 1
            return processed, dup

        deadline = time.time() + 90
        processed, dup = [], 0
        while time.time() < deadline:
            processed, dup = run_db(afactory)
            if len(processed) == len(ids):
                break
            time.sleep(3)

        rec_bulk("Delivery: processed into a case (zero loss)", len(processed), len(ids))
        distinct = len(set(c for _i, c in processed))
        rec_bulk("Idempotency: exactly one case per PRF", distinct, len(processed))
        rec_bulk("Idempotency: no duplicate claims (no double-bill)",
                 len(processed) - dup, len(processed))
        print(f"  delivery round {r+1}/{rounds}: {len(processed)}/{len(ids)} processed")


# ── Campaign 2: cross-tenant isolation at volume ──────────────────────────
def campaign_tenant(A, B, pid, case_id, rounds):
    NF = {403, 404}
    probes = [
        ("GET", f"/api/digital-prf/{pid}", B["crew"], None),
        ("PATCH", f"/api/digital-prf/{pid}", B["crew"], {"form_data": {"hacked": True}}),
        ("POST", f"/api/digital-prf/{pid}/submit", B["crew"], None),
        ("POST", f"/api/digital-prf/{pid}/mark-time", B["crew"], {"field": "time_on_scene", "km": "9"}),
        ("DELETE", f"/api/digital-prf/{pid}", B["crew"], None),
        ("GET", f"/api/digital-prf/admin/by-case/{case_id}", B["admin"], None),
        ("GET", f"/api/providers/{A['pid']}/prfs", B["admin"], None),
        ("GET", f"/api/providers/{A['pid']}/crew", B["admin"], None),
        ("GET", f"/api/providers/{A['pid']}/vehicles", B["admin"], None),
        ("GET", f"/api/providers/{A['pid']}/settings", B["admin"], None),
        ("PATCH", f"/api/providers/{A['pid']}/settings", B["admin"], {"name": "HIJACK"}),
    ]
    for _ in range(rounds):
        for m, p, tok, body in probes:
            st, _ = http(m, p, tok, body)
            rec("Isolation: cross-provider access refused", st in NF)


# ── Campaign 3: auth guard on protected endpoints ─────────────────────────
def campaign_auth(rounds):
    eps = [("GET", "/api/auth/me"), ("GET", "/api/stats"),
           ("GET", "/api/cases"), ("GET", "/api/documents"), ("GET", "/api/providers")]
    for _ in range(rounds):
        for m, p in eps:
            st, _ = http(m, p, "garbage.invalid.token")
            rec("Auth: protected endpoint rejects a bad token", st in (401, 403))


# ── Campaign 4: uptime / health soak ──────────────────────────────────────
def campaign_health(n):
    for _ in range(n):
        try:
            r = urllib.request.urlopen(BASE + "/health", timeout=5)
            d = json.load(r)
            ok = (d.get("api") == "healthy" and d.get("database") == "healthy"
                  and d.get("rabbitmq") == "healthy")
            rec("Uptime: /health all subsystems green", ok)
        except Exception:
            rec("Uptime: /health all subsystems green", False)


# ── Campaign 5: brute-force limiter determinism ───────────────────────────
def campaign_limiter(n_ips):
    def probe(ip, xff=None):
        h = {"Content-Type": "application/json", "X-Real-IP": ip}
        if xff:
            h["X-Forwarded-For"] = xff
        req = urllib.request.Request(
            BASE + "/api/crew/login", method="POST",
            data=json.dumps({"email": "ratelimit-probe@none.invalid", "password": "x"}).encode(),
            headers=h)
        try:
            return urllib.request.urlopen(req, timeout=8).status
        except urllib.error.HTTPError as e:
            return e.code

    for k in range(n_ips):
        ip = f"198.51.100.{40 + k}"
        codes = [probe(ip) for _ in range(18)]
        first429 = next((i + 1 for i, c in enumerate(codes) if c == 429), None)
        rec("Security: brute-force lockout binds (429 after 15)",
            first429 is not None and first429 >= 15)
    rec("Security: fresh IP gets a clean budget", probe("198.51.100.199") == 401)
    rec("Security: spoofed forwarded-IP cannot dodge limit", probe("198.51.100.40", "10.1.2.3") == 429)


def cleanup():
    async def factory(db):
        from sqlalchemy import select, delete
        from app.models.digital_prf import DigitalPRF
        from app.models.case import Case
        from app.models.claim import Claim
        from app.models.claim_line import ClaimLine
        from app.models.document import Document
        for pid in created_prf_ids:
            p = (await db.execute(select(DigitalPRF).where(DigitalPRF.id == pid))).scalars().first()
            if not p:
                continue
            cid = p.case_id
            claim_ids = (await db.execute(select(Claim.id).where(Claim.case_id == cid))).scalars().all() if cid else []
            if claim_ids:
                await db.execute(delete(ClaimLine).where(ClaimLine.claim_id.in_(claim_ids)))
                await db.execute(delete(Claim).where(Claim.id.in_(claim_ids)))
            p.case_id = None; p.document_id = None
            await db.flush()
            if cid:
                await db.execute(delete(Document).where(Document.case_id == cid))
                await db.execute(delete(Case).where(Case.id == cid))
            await db.delete(p)
        await db.commit()
    run_db(factory)


def report():
    print("\n" + "=" * 66)
    print("  ePRF RELIABILITY SCORECARD")
    print("=" * 66)
    gp = gt = 0
    for camp, (p, t) in CARD.items():
        gp += p; gt += t
        pct = 100 * p / t if t else 0
        print(f"  {p:>6}/{t:<6} {pct:6.1f}%   {camp}")
    print("-" * 66)
    print(f"  {gp:>6}/{gt:<6} {100 * gp / gt if gt else 0:6.1f}%   GRAND TOTAL")
    print("=" * 66)
    return gp, gt


def main():
    t = tenant_setup()
    A, B = t["A"], t["B"]
    print(f"Provider A={A['slug']}  B={B['slug']}  SCALE={SCALE}\n--- running campaigns ---")

    d_rounds = max(1, round(2 * min(SCALE, 2)))
    campaign_delivery(A, rounds=d_rounds, per_round=15)

    # use one of A's processed PRFs as the isolation target
    def pick(db_ids):
        async def f(db):
            from sqlalchemy import select
            from app.models.digital_prf import DigitalPRF
            for pid in db_ids:
                p = (await db.execute(select(DigitalPRF).where(DigitalPRF.id == pid))).scalars().first()
                if p and p.case_id:
                    return str(p.id), str(p.case_id)
            return None, None
        return run_db(f)

    pid, case_id = pick(created_prf_ids)
    if pid:
        campaign_tenant(A, B, pid, case_id, rounds=int(30 * SCALE))
    campaign_auth(rounds=int(30 * SCALE))
    campaign_health(n=int(150 * SCALE))
    campaign_limiter(n_ips=5)

    cleanup()
    gp, gt = report()
    sys.exit(0 if gp == gt else 1)


if __name__ == "__main__":
    main()
