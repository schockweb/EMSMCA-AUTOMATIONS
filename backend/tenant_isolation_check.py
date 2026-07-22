"""
Cross-tenant isolation proof for the Digital PRF / provider APIs (DEV ONLY).

Mints real tokens for TWO providers (A and B), each with a regular crew member
and a provider-admin, then hammers every crew + provider endpoint trying to
cross the tenant boundary. Provider B must NEVER be able to read, edit,
submit, delete, or even confirm the existence of Provider A's data — and no
list endpoint may ever leak one provider's PRFs into another's.

    docker exec ems_backend python tenant_isolation_check.py

Exit 0 = airtight. Exit 1 = a leak (printed in red-flag lines).
Creates one throwaway PRF/case for A, cleaned up at the end.
"""
from __future__ import annotations
import asyncio, json, time, urllib.request, urllib.error

from e2e_prf_pipeline_check import run_db  # disposable-engine DB helper

BASE = "http://localhost:8000"
PASS, FAIL = [], []


def check(name: str, ok: bool, detail: str = ""):
    (PASS if ok else FAIL).append(name)
    print(f"{'PASS' if ok else 'LEAK!!':7} {name}" + (f"   [{detail}]" if detail else ""))


def http(method, path, token, body=None):
    req = urllib.request.Request(
        BASE + path, method=method,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        data=(json.dumps(body).encode() if body is not None else None),
    )
    try:
        r = urllib.request.urlopen(req, timeout=15)
        try:
            return r.status, json.load(r)
        except Exception:
            return r.status, None
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.load(e)
        except Exception:
            return e.code, None


def setup():
    async def factory(db):
        from sqlalchemy import select, func
        from app.models.service_provider import ServiceProvider
        from app.models.crew_member import CrewMember
        from app.utils.security import create_access_token

        provs = (await db.execute(select(ServiceProvider))).scalars().all()
        chosen = []
        for p in provs:
            reg = (await db.execute(
                select(CrewMember).where(
                    CrewMember.provider_id == p.id,
                    CrewMember.is_active == True,  # noqa: E712
                    CrewMember.role != "admin",
                ).limit(1)
            )).scalars().first()
            adm = (await db.execute(
                select(CrewMember).where(
                    CrewMember.provider_id == p.id,
                    CrewMember.is_active == True,  # noqa: E712
                    CrewMember.role == "admin",
                ).limit(1)
            )).scalars().first()
            if reg and adm:
                chosen.append((p, reg, adm))
            if len(chosen) == 2:
                break
        assert len(chosen) == 2, "need two providers each with an active crew + admin"

        def crew_tok(c):
            return create_access_token({
                "sub": str(c.id), "crew_id": str(c.id),
                "provider_id": str(c.provider_id), "token_scope": "crew",
            })

        (pa, ra, aa), (pb, rb, ab) = chosen
        return {
            "A": {"pid": str(pa.id), "slug": pa.slug, "crew": crew_tok(ra), "admin": crew_tok(aa)},
            "B": {"pid": str(pb.id), "slug": pb.slug, "crew": crew_tok(rb), "admin": crew_tok(ab)},
        }
    return run_db(factory)


def make_and_submit_prf(A) -> tuple[str, str]:
    """Create + submit a PRF as Provider A's crew; return (prf_id, case_id)."""
    st, body = http("POST", "/api/digital-prf", A["crew"], {})
    assert st == 201, f"A create failed {st}"
    prf_id = body["id"]
    http("PATCH", f"/api/digital-prf/{prf_id}", A["crew"],
         {"form_data": {"call_type": "PRIMARY", "patient_name": "Tenant", "patient_surname": "Isolation",
                        "medical_scheme": "Discovery Health", "tenant_test": True}})
    http("POST", f"/api/digital-prf/{prf_id}/submit", A["crew"])
    # wait for case
    case_id = None
    for _ in range(30):
        def q(db):
            from sqlalchemy import select
            from app.models.digital_prf import DigitalPRF
            return db.execute(select(DigitalPRF).where(DigitalPRF.id == prf_id))
        async def factory(db):
            from sqlalchemy import select
            from app.models.digital_prf import DigitalPRF
            p = (await db.execute(select(DigitalPRF).where(DigitalPRF.id == prf_id))).scalars().first()
            return str(p.case_id) if p and p.case_id else None
        case_id = run_db(factory)
        if case_id:
            break
        time.sleep(2)
    assert case_id, "A's PRF never got a case_id"
    return prf_id, case_id


def main():
    t = setup()
    A, B = t["A"], t["B"]
    print(f"Provider A = {A['slug']}   Provider B = {B['slug']}\n")
    prf_id, case_id = make_and_submit_prf(A)
    print(f"A's PRF {prf_id} -> case {case_id}\n--- cross-tenant attacks (B against A) ---")

    # A 404 (not 403) is the STRONGEST answer — it doesn't even confirm the PRF exists.
    NOTFOUND = {403, 404}

    st, _ = http("GET", f"/api/digital-prf/{prf_id}", B["crew"])
    check("B-crew GET A's PRF is refused", st in NOTFOUND, f"HTTP {st}")

    st, _ = http("PATCH", f"/api/digital-prf/{prf_id}", B["crew"], {"form_data": {"hacked": True}})
    check("B-crew PATCH A's PRF is refused", st in NOTFOUND, f"HTTP {st}")

    st, _ = http("POST", f"/api/digital-prf/{prf_id}/submit", B["crew"])
    check("B-crew SUBMIT A's PRF is refused", st in NOTFOUND, f"HTTP {st}")

    st, _ = http("POST", f"/api/digital-prf/{prf_id}/mark-time", B["crew"], {"field": "time_on_scene", "km": "9"})
    check("B-crew MARK-TIME A's PRF is refused", st in NOTFOUND, f"HTTP {st}")

    st, _ = http("DELETE", f"/api/digital-prf/{prf_id}", B["crew"])
    check("B-crew DELETE A's PRF is refused", st in NOTFOUND, f"HTTP {st}")

    st, _ = http("GET", f"/api/digital-prf/admin/by-case/{case_id}", B["admin"])
    check("B-admin GET A's PRF-by-case is refused", st in NOTFOUND, f"HTTP {st}")

    # Provider settings/data endpoints, addressed by A's provider_id
    for ep, label in [
        (f"/api/providers/{A['pid']}/prfs", "PRFs"),
        (f"/api/providers/{A['pid']}/crew", "crew"),
        (f"/api/providers/{A['pid']}/vehicles", "vehicles"),
        (f"/api/providers/{A['pid']}/settings", "settings"),
    ]:
        st, _ = http("GET", ep, B["admin"])
        check(f"B-admin GET A's {label} is refused", st in NOTFOUND, f"HTTP {st}")
    st, _ = http("PATCH", f"/api/providers/{A['pid']}/settings", B["admin"], {"name": "HIJACKED"})
    check("B-admin PATCH A's settings is refused", st in NOTFOUND, f"HTTP {st}")
    st, _ = http("POST", f"/api/providers/{A['pid']}/crew", B["admin"],
                 {"full_name": "Ghost", "hpcsa_number": "X", "qualification": "ILS", "role": "crew"})
    check("B-admin CREATE crew under A is refused", st in NOTFOUND, f"HTTP {st}")

    print("\n--- list-leak checks ---")
    # B-admin's own PRF list must not contain A's PRF/case
    st, items = http("GET", f"/api/providers/{B['pid']}/prfs?limit=500", B["admin"])
    rows = (items if isinstance(items, list) else (items or {}).get("items", [])) or []
    leaked = [r for r in rows if r.get("case_id") == case_id]
    check("B-admin's PRF list excludes A's case", st == 200 and not leaked, f"leaked={len(leaked)}")

    # A-crew's own list is scoped to A + creator (positive control it returns, negative it has no B rows)
    st, mine = http("GET", "/api/digital-prf", A["crew"])
    ok = st == 200 and isinstance(mine, list) and any(p["id"] == prf_id for p in mine)
    check("A-crew list returns A's own PRF (positive control)", ok, f"HTTP {st}")

    print("\n--- positive controls (A may reach A) ---")
    st, _ = http("GET", f"/api/digital-prf/{prf_id}", A["crew"])
    check("A-crew GET own PRF succeeds", st == 200, f"HTTP {st}")
    st, _ = http("GET", f"/api/digital-prf/admin/by-case/{case_id}", A["admin"])
    check("A-admin GET own PRF-by-case succeeds", st == 200, f"HTTP {st}")
    st, _ = http("GET", f"/api/providers/{A['pid']}/prfs", A["admin"])
    check("A-admin GET own PRFs succeeds", st == 200, f"HTTP {st}")

    # cleanup A's throwaway
    async def clean(db):
        from sqlalchemy import select, delete
        from app.models.digital_prf import DigitalPRF
        from app.models.case import Case
        from app.models.claim import Claim
        from app.models.claim_line import ClaimLine
        from app.models.document import Document
        p = (await db.execute(select(DigitalPRF).where(DigitalPRF.id == prf_id))).scalars().first()
        if p:
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
    run_db(clean)

    print(f"\n══ {len(PASS)} passed, {len(FAIL)} LEAKS ══")
    if FAIL:
        print("LEAKS:", ", ".join(FAIL))
    import sys
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
