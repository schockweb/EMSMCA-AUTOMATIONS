"""
Proof that the unauthenticated crew-session hole is closed (DEV ONLY).

THE VULNERABILITY (found 2026-07-27, fixed same day)
----------------------------------------------------
/api/crew/shift-start-by-id and /api/crew/lookup-hpcsa minted 12-hour crew JWTs
with NO authentication whatsoever, and /api/providers/{slug}/public-crew served
the crew UUIDs and HPCSA numbers those endpoints needed. The full chain — public
provider list, public crew IDs, exchange an ID for a patient-record token — was
executable by anyone on the internet with no credential of any kind. It granted
read, edit, delete and submit access to Patient Report Forms.

This script asserts the chain is dead and that the legitimate flow still works.
NOTE: it RESETS the chosen provider's portal password to a known test value, so
run it only against a development stack.

    docker exec ems_backend python portal_grant_check.py
"""
import json, urllib.request, urllib.error, sys, asyncio
from sqlalchemy import text
from app.database import AsyncSessionLocal
from app.utils.security import hash_password
B="http://localhost:8000"; PW="UnlockTest#2026"

def req(method, path, body=None, tok=None):
    h={"Content-Type":"application/json"}
    if tok: h["Authorization"]=f"Bearer {tok}"
    r=urllib.request.Request(B+path, method=method,
        data=(json.dumps(body).encode() if body is not None else None), headers=h)
    try:
        x=urllib.request.urlopen(r,timeout=15); return x.status, json.load(x)
    except urllib.error.HTTPError as e:
        try: return e.code, json.load(e)
        except Exception: return e.code, None

async def setup():
    async with AsyncSessionLocal() as db:
        # a provider that HAS active non-admin crew
        row=(await db.execute(text("""
            SELECT p.slug, p.id, c.id AS crew_id, c.hpcsa_number
            FROM service_providers p JOIN crew_members c ON c.provider_id=p.id
            WHERE p.is_active AND c.is_active AND c.role<>'admin' LIMIT 1"""))).mappings().first()
        await db.execute(text("UPDATE service_providers SET portal_login_password_hash=:h,"
                              " failed_login_attempts=0, locked_until=NULL WHERE id=:i"),
                         {"h":hash_password(PW),"i":row["id"]})
        other=(await db.execute(text("SELECT slug FROM service_providers WHERE id<>:i AND is_active LIMIT 1"),
                                {"i":row["id"]})).scalar()
        await db.commit()
        return dict(slug=row["slug"], crew_id=str(row["crew_id"]),
                    hpcsa=row["hpcsa_number"], other=other)
D=asyncio.run(setup())
print(f"provider={D['slug']}  crew={D['crew_id'][:8]}…  other={D['other']}\n")
P=F=0
def chk(n, ok, d=""):
    global P,F
    P,F=(P+1,F) if ok else (P,F+1)
    print(f"{'PASS' if ok else 'FAIL':5} {n}   [{d}]")

print("--- BEFORE unlock: the attack chain must be dead ---")
for name, st in [("public-crew", req("GET", f"/api/providers/{D['slug']}/public-crew")[0]),
                 ("public-vehicles", req("GET", f"/api/providers/{D['slug']}/public-vehicles")[0]),
                 ("shift-start-by-id", req("POST","/api/crew/shift-start-by-id",{"crew_id":D['crew_id'],"provider_slug":D['slug']})[0]),
                 ("lookup-hpcsa", req("POST","/api/crew/lookup-hpcsa",{"hpcsa_number":D['hpcsa'] or "X","provider_slug":D['slug']})[0])]:
    chk(f"{name} unauthenticated -> 401", st==401, f"HTTP {st}")

print("\n--- unlock ---")
chk("wrong company password -> 401", req("POST","/api/crew/portal-unlock",{"provider_slug":D['slug'],"password":"nope"})[0]==401)
st,b=req("POST","/api/crew/portal-unlock",{"provider_slug":D['slug'],"password":PW})
chk("correct password -> grant", st==200 and bool(b and b.get("grant")), f"HTTP {st}")
g=(b or {}).get("grant")

print("\n--- WITH grant: legitimate crew flow still works ---")
st,b=req("GET", f"/api/providers/{D['slug']}/public-crew", tok=g)
chk("public-crew -> 200", st==200, f"HTTP {st}")
chk("hpcsa_number no longer exposed", bool(b) and "hpcsa_number" not in b[0], str(list(b[0].keys()) if b else []))
chk("public-vehicles -> 200", req("GET", f"/api/providers/{D['slug']}/public-vehicles", tok=g)[0]==200)
st,b=req("POST","/api/crew/shift-start-by-id",{"crew_id":D['crew_id'],"provider_slug":D['slug']}, tok=g)
chk("shift-start -> crew token issued", st==200 and bool(b and b.get("access_token")), f"HTTP {st}")
ct=(b or {}).get("access_token")

print("\n--- an existing crew token also satisfies the gate (mid-shift) ---")
chk("public-crew with crew token -> 200", req("GET", f"/api/providers/{D['slug']}/public-crew", tok=ct)[0]==200 if ct else False)

print("\n--- cross-provider isolation ---")
if D['other']:
    st,_=req("GET", f"/api/providers/{D['other']}/public-crew", tok=g)
    chk("grant for A refused on provider B", st in (401,403), f"HTTP {st}")

print(f"\n== {P} passed, {F} failed ==")
sys.exit(1 if F else 0)
