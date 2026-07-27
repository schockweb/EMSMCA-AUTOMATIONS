"""
Verification for Security Fixes #1 (login lockout) and #2 (trusted client IP).

Creates a throwaway provider (with portal login) + crew member, then proves:
  A. Crew lockout: 5 wrong passwords -> locked; correct password refused (403)
     while locked; unlock -> success; counters reset; audit rows written.
  B. Provider portal lockout: same policy on /api/auth/login.
  C. Admin login unaffected (seed admin still logs in).
  D. Rate limiter binds per REAL client IP: 15/min on auth paths; a fresh
     X-Real-IP gets a fresh bucket; a rotating X-Forwarded-For does NOT.
  E. Loopback bypass still lets in-container non-auth calls through.

    docker exec ems_backend python security_fix_check.py

Exit 0 = all good. Cleans up its throwaway rows (audit rows kept — immutable).
"""
from __future__ import annotations
import json
import urllib.error
import urllib.parse
import urllib.request
import uuid

from e2e_prf_pipeline_check import run_db  # disposable-engine DB helper
import os
# Dev/test seed password — matches app.main.DEV_SEED_ADMIN_PASSWORD.
# The old hard-coded value leaked via a public repo and is burned.
SEED_ADMIN_PASSWORD = os.getenv("SEED_ADMIN_PASSWORD", "DevSeed!Change#2026")


BASE = "http://localhost:8000"
PASS, FAIL = [], []

TP_EMAIL = "lockout-portal@check.local"
TC_EMAIL = "lockout-crew@check.local"
GOOD_PW = "Correct-Horse-9!"
BAD_PW = "wrong-password"


def check(name, ok, detail=""):
    (PASS if ok else FAIL).append(name)
    print(f"{'PASS' if ok else 'FAIL!!':7} {name}" + (f"   [{detail}]" if detail else ""))


def post(path, *, form=None, body=None, headers=None):
    if form is not None:
        data = urllib.parse.urlencode(form).encode()
        ctype = "application/x-www-form-urlencoded"
    else:
        data = json.dumps(body or {}).encode()
        ctype = "application/json"
    req = urllib.request.Request(
        BASE + path, method="POST", data=data,
        headers={"Content-Type": ctype, **(headers or {})},
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
        from app.models.service_provider import ServiceProvider
        from app.models.crew_member import CrewMember
        from app.utils.security import hash_password
        prov = ServiceProvider(
            id=uuid.uuid4(), name="Lockout Check EMS", slug=f"lockchk-{uuid.uuid4().hex[:6]}",
            portal_login_email=TP_EMAIL, portal_login_password_hash=hash_password(GOOD_PW),
            is_active=True,
        )
        crew = CrewMember(
            id=uuid.uuid4(), provider_id=prov.id, email=TC_EMAIL,
            hashed_password=hash_password(GOOD_PW), full_name="Lockout Check",
            qualification="AEA", role="crew", is_active=True,
        )
        db.add(prov); db.add(crew)
        await db.commit()
        return {"provider_id": str(prov.id), "crew_id": str(crew.id)}
    return run_db(factory)


def crew_state():
    async def factory(db):
        from sqlalchemy import select
        from app.models.crew_member import CrewMember
        c = (await db.execute(select(CrewMember).where(CrewMember.email == TC_EMAIL))).scalars().first()
        return {"fails": c.failed_login_attempts, "locked": c.locked_until is not None}
    return run_db(factory)


def unlock_crew():
    async def factory(db):
        from sqlalchemy import select
        from app.models.crew_member import CrewMember
        c = (await db.execute(select(CrewMember).where(CrewMember.email == TC_EMAIL))).scalars().first()
        c.locked_until = None
        await db.commit()
    return run_db(factory)


def audit_count(action):
    async def factory(db):
        from sqlalchemy import select, func
        from app.models.audit_log import AuditLog
        return (await db.execute(
            select(func.count()).select_from(AuditLog).where(AuditLog.action == action)
        )).scalar()
    return run_db(factory)


def cleanup(ids):
    async def factory(db):
        from sqlalchemy import delete
        from app.models.service_provider import ServiceProvider
        from app.models.crew_member import CrewMember
        await db.execute(delete(CrewMember).where(CrewMember.id == uuid.UUID(ids["crew_id"])))
        await db.execute(delete(ServiceProvider).where(ServiceProvider.id == uuid.UUID(ids["provider_id"])))
        await db.commit()
    return run_db(factory)


def main():
    ids = setup()
    print("throwaway provider/crew created\n--- A. crew lockout ---")
    # Distinct X-Real-IP per phase so the auth rate limit never interferes.
    ip_a = {"X-Real-IP": "198.51.100.11"}

    for i in range(5):
        st, _ = post("/api/crew/login", body={"email": TC_EMAIL, "password": BAD_PW}, headers=ip_a)
        check(f"wrong password #{i+1} -> 401", st == 401, f"HTTP {st}")

    st, body = post("/api/crew/login", body={"email": TC_EMAIL, "password": GOOD_PW}, headers=ip_a)
    check("CORRECT password while locked -> 403 locked", st == 403, f"HTTP {st}: {body}")
    s = crew_state()
    check("DB shows 5 fails + locked_until set", s["fails"] == 5 and s["locked"], str(s))

    unlock_crew()
    st, body = post("/api/crew/login", body={"email": TC_EMAIL, "password": GOOD_PW}, headers=ip_a)
    check("after unlock, correct password -> 200", st == 200 and body.get("access_token"), f"HTTP {st}")
    s = crew_state()
    check("success resets counters", s["fails"] == 0 and not s["locked"], str(s))
    check("audit: CREW_LOGIN_FAILED rows written", audit_count("CREW_LOGIN_FAILED") >= 5)
    check("audit: CREW_LOGIN_FAILED_LOCKED written", audit_count("CREW_LOGIN_FAILED_LOCKED") >= 1)
    check("audit: CREW_LOGIN_SUCCESS written", audit_count("CREW_LOGIN_SUCCESS") >= 1)

    print("--- B. provider portal lockout ---")
    ip_b = {"X-Real-IP": "198.51.100.12"}
    for i in range(5):
        st, _ = post("/api/auth/login", form={"username": TP_EMAIL, "password": BAD_PW}, headers=ip_b)
        check(f"portal wrong password #{i+1} -> 401", st == 401, f"HTTP {st}")
    st, body = post("/api/auth/login", form={"username": TP_EMAIL, "password": GOOD_PW}, headers=ip_b)
    check("portal CORRECT password while locked -> 403", st == 403, f"HTTP {st}: {body}")
    check("audit: PORTAL_LOGIN_FAILED rows written", audit_count("PORTAL_LOGIN_FAILED") >= 5)
    check("audit: PORTAL_LOGIN_FAILED_LOCKED written", audit_count("PORTAL_LOGIN_FAILED_LOCKED") >= 1)

    print("--- C. admin login unaffected ---")
    st, body = post("/api/auth/login",
                    form={"username": "admin@emsclaims.co.za", "password": SEED_ADMIN_PASSWORD},
                    headers={"X-Real-IP": "198.51.100.13"})
    check("seed admin login -> 200 tokens", st == 200 and body.get("access_token"), f"HTTP {st}")

    print("--- D. rate limiter binds per trusted IP ---")
    ip_d = {"X-Real-IP": "198.51.100.14"}
    saw_429 = None
    for i in range(20):
        st, _ = post("/api/crew/login", body={"email": "ghost@check.local", "password": "x"}, headers=ip_d)
        if st == 429:
            saw_429 = i + 1
            break
    check("auth limit binds (429 within 20 attempts, after >=15)",
          saw_429 is not None and saw_429 >= 15, f"429 at attempt {saw_429}")

    st, _ = post("/api/crew/login", body={"email": "ghost@check.local", "password": "x"},
                 headers={"X-Real-IP": "198.51.100.15"})
    check("different real IP -> fresh bucket (401 not 429)", st == 401, f"HTTP {st}")

    st, _ = post("/api/crew/login", body={"email": "ghost@check.local", "password": "x"},
                 headers={**ip_d, "X-Forwarded-For": "10.9.8.7"})
    check("rotating XFF does NOT dodge the limit (still 429)", st == 429, f"HTTP {st}")

    print("--- E. loopback bypass for non-auth in-container calls ---")
    req = urllib.request.Request(BASE + "/health")
    with urllib.request.urlopen(req, timeout=10) as r:
        check("/health reachable", r.status == 200)

    cleanup(ids)
    print(f"\n== {len(PASS)} passed, {len(FAIL)} failed ==")
    if FAIL:
        print("FAILED:", ", ".join(FAIL))
    import sys
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
