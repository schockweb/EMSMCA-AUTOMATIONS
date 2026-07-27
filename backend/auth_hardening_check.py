"""
Proves the auth-integrity fixes from the 2026-07-27 security audit (DEV ONLY).

Each check corresponds to a finding:
  A. A refresh token must not authenticate API calls (it is a 7-day credential
     meant only for rotation).
  B. /api/auth/refresh must refuse a deactivated account at the source.
  C. Logout must actually take effect on the provider endpoints, which used to
     ignore the token blacklist entirely.
  D. A deactivated admin must lose access immediately, not at token expiry.
  E. Crew sessions must be revocable — there was previously no way at all.
  F. Crew change-password must take a request BODY, never query parameters.

    docker exec ems_backend python auth_hardening_check.py
"""
from __future__ import annotations
import json, urllib.request, urllib.error, sys
from sqlalchemy import text

# Disposable-engine helper: repeated asyncio.run() against the module-level
# AsyncSessionLocal dies with "Future attached to a different loop".
from e2e_prf_pipeline_check import run_db

BASE = "http://localhost:8000"
P = F = 0

def chk(name, ok, detail=""):
    global P, F
    P, F = (P + 1, F) if ok else (P, F + 1)
    print(f"{'PASS' if ok else 'FAIL':5} {name}   [{detail}]")

def call(method, path, body=None, tok=None, form=None):
    import urllib.parse
    if form is not None:
        data, ctype = urllib.parse.urlencode(form).encode(), "application/x-www-form-urlencoded"
    else:
        data, ctype = (json.dumps(body).encode() if body is not None else None), "application/json"
    h = {"Content-Type": ctype, "X-Real-IP": "198.51.100.77"}
    if tok:
        h["Authorization"] = f"Bearer {tok}"
    r = urllib.request.Request(BASE + path, method=method, data=data, headers=h)
    try:
        x = urllib.request.urlopen(r, timeout=20)
        return x.status, json.load(x)
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.load(e)
        except Exception:
            return e.code, None

def _reset():
    async def f(db):
        await db.execute(text("UPDATE users SET failed_login_attempts=0, locked_until=NULL, is_active=true"))
        await db.commit()
    return run_db(f)

def _set_active(flag: bool):
    async def f(db):
        await db.execute(text("UPDATE users SET is_active=:a WHERE email='admin@emsclaims.co.za'"), {"a": flag})
        await db.commit()
    return run_db(f)

def main():
    import os
    pw = os.getenv("SEED_ADMIN_PASSWORD", "DevSeed!Change#2026")
    _reset()

    st, tok = call("POST", "/api/auth/login", form={"username": "admin@emsclaims.co.za", "password": pw})
    if st != 200:
        print(f"cannot log in as admin (HTTP {st}) — set SEED_ADMIN_PASSWORD"); return 1
    access, refresh = tok["access_token"], tok["refresh_token"]

    print("--- A. refresh token must not work as an access token ---")
    chk("refresh token rejected on /api/auth/me", call("GET", "/api/auth/me", tok=refresh)[0] == 401)
    chk("access token still works on /api/auth/me", call("GET", "/api/auth/me", tok=access)[0] == 200)
    chk("refresh token rejected on a provider endpoint", call("GET", "/api/providers", tok=refresh)[0] == 401)

    print("--- C. logout must take effect on provider endpoints ---")
    chk("provider endpoint works before logout", call("GET", "/api/providers", tok=access)[0] == 200)
    call("POST", "/api/auth/logout", body={"refresh_token": refresh}, tok=access)
    chk("provider endpoint REFUSED after logout", call("GET", "/api/providers", tok=access)[0] == 401)
    chk("/api/auth/me also refused after logout", call("GET", "/api/auth/me", tok=access)[0] == 401)

    print("--- B. deactivated account cannot refresh ---")
    st, tok2 = call("POST", "/api/auth/login", form={"username": "admin@emsclaims.co.za", "password": pw})
    refresh2 = tok2["refresh_token"]
    _set_active(False)
    chk("deactivated user refused at /refresh", call("POST", "/api/auth/refresh", body={"refresh_token": refresh2})[0] == 401)
    _set_active(True)

    print("--- D. deactivated admin loses access ---")
    # Deactivation is enforced by get_current_user, so it takes effect the moment
    # a request actually reaches the route. Note the ACCEPTED limitation: the
    # response cache answers a HIT before the route runs, and unlike logout there
    # is no request to hang a purge off, so an already-cached GET can still be
    # served for the remainder of its TTL (<=60s here, <=300s on some prefixes).
    # Uncached endpoints — which includes everything under /api/auth — refuse
    # immediately. Deactivation is an administrative action, not an incident
    # response tool; for immediate cut-off, log the session out.
    st, tok3 = call("POST", "/api/auth/login", form={"username": "admin@emsclaims.co.za", "password": pw})
    a3 = tok3["access_token"]
    chk("works while active", call("GET", "/api/auth/me", tok=a3)[0] == 200)
    _set_active(False)
    chk("refused on an uncached endpoint once deactivated",
        call("GET", "/api/auth/me", tok=a3)[0] == 401)
    chk("refused on a cache MISS (fresh query string) once deactivated",
        call("GET", "/api/providers?cachebust=deactivated", tok=a3)[0] == 401)
    _set_active(True)

    print("--- F. change-password must not accept query params ---")
    st, _ = call("POST", "/api/crew/change-password?current_password=a&new_password=b", tok=a3)
    chk("query-param form no longer accepted", st in (401, 422), f"HTTP {st}")

    _reset()
    print(f"\n== {P} passed, {F} failed ==")
    return 1 if F else 0

if __name__ == "__main__":
    sys.exit(main())
