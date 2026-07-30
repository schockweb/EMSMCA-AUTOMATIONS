# Backend audit — pre-client-deployment

**Date:** 2026-07-30 · **Scope:** `backend/` (28 routers, 28 models, services, ops config)

**Status: REPORT. Fixes tracked separately — see the commits that reference this file.**

**Why.** The platform is about to be deployed onto a CLIENT-OWNED VM — a second
instance run by someone else. The two prior audits were frontend-heavy (PDF export,
crew form); the backend had never had a dedicated pass.

**Method.** Five parallel analyses (authorisation, tenant isolation, data integrity,
fresh-deploy readiness, availability/async), each finding handed to an independent
reviewer whose job was to REFUTE it. **73 raised, 61 confirmed, 12 refuted.**

| Severity | Count |
|---|---:|
| high | 25 |
| medium | 25 |
| low | 11 |

### By category

| Category | High | Total |
|---|---:|---:|
| authz | 11 | 21 |
| data-integrity | 4 | 11 |
| availability | 1 | 7 |
| deploy-readiness | 4 | 6 |
| secret-config | 2 | 6 |
| tenant-isolation | 3 | 5 |
| input-validation | 0 | 5 |

---

## HIGH (25)

### POST /api/invoices/{invoice_id}/submit has no auth dependency at all and is publicly proxied

- **Severity:** high · **Category:** authz · **Lens:** authz
- **Location:** `backend/app/main.py:577`

**Impact.** Anyone who can reach the portal and guess/obtain a claim UUID can cause a real invoice to be submitted to a medical scheme with no credential whatsoever. Duplicate or unauthorised scheme submissions are a billing-integrity and POPIA problem, and the caller is completely unattributable in the audit log.

<details><summary>Evidence</summary>

```
@app.post("/api/invoices/{invoice_id}/submit", tags=["Invoices"], status_code=202)
async def submit_invoice(
    invoice_id: str,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):

No Depends(get_current_user), no require_role. It loads the Claim by the path UUID, resolves the payer from the scheme rules module, and dispatches the real payer-routing background task. nginx/nginx.conf:61 `location /api/ { proxy_pass http://ems_api; }` — there is no deny for this path, so it is reachable from the internet.
```

</details>

**Recommended fix.** Add `_user: User = Depends(require_role(UserRole.ADMIN, UserRole.SUPER_ADMIN))` (or at minimum get_current_user) to submit_invoice, and move the route into a router so it cannot keep escaping the audit of app/api/.

<details><summary>Independent verification</summary>

VERIFIED, NOT REFUTED (with one impact correction).

Code check at backend/app/main.py:577-668: the decorator and signature are verbatim as quoted. Only dependency is Depends(get_db). No get_current_user, no require_role, no tenant/provider scoping.

Ruled out every escape hatch:
- app = FastAPI(...) at main.py:146 declares no global dependencies=[...].
- No middleware authenticates. Grep of app/middleware/*.py and app/core/response_cache.py for Authorization / get_current_user / 401 hits only response-cache key fingerprinting (lines 77, 85, 174). The chain (CORS, GZip, RateLimit, XSSProtection, CrashHandler, ResponseCache) has no auth gate. ResponseCacheMiddleware is GET-only anyway, so the cache-HIT-before-dependencies quirk is irrelevant here.
- No shadowing route: repo-wide grep for "invoices/" returns this single line; no router in app/api/ registers /api/invoices, so nothing guarded is matched first.
- nginx/nginx.conf:61 `location /api/ { proxy_pass http://ems_api; }` has no deny/auth_request; only /docs (81) and /openapi.json (86) are denied. Internet reachable.
- Not on the already-fixed or deliberate lists (those cover crew-session minting, refresh-as-access, digital_prf access resolver, crashes.py optional auth, require_role exact-match, tariff engine, patient-ID encryption). Nothing covers this route.
- Contrast in the same file proves the omission is unintended: /api/stats at main.py:445 was explicitly given Depends(get_current_user) with a comment calling it "the one unauthenticated data endpoint" — this invoice route was missed.

IMPACT CORRECTION (the claim overstates): app/services/submission_strategies.py — both EDISwitchStrategy and B2BAggregatorStrategy are explicitly labelled MOCK. They format a string payload and mint a random SW-/B2B- reference; neither makes any outbound call to HealthBridge, Mediswitch, ER24 or Netcare. So "a real invoice submitted to a medical scheme" does NOT occur today. The claimed mechanism (public route, no credential, real background dispatch) is accurate; the claimed downstream consequence is not yet real.

WHAT IS REAL, unauthenticated, from an anonymous caller holding a claim UUID:
1. Genuine DB mutation in _execute_invoice_routing (main.py:558-568): claim.adjudication_status = SUBMITTED, claim.submitted_at = now(), and for AGGREGATOR payers claim.dispatch_reference_number overwritten with a fabricated reference. Unauthenticated corruption of billing state — a claim marked submitted that never was.
2. Information oracle: 404 vs 422 vs 202 distinguishes valid claim UUIDs; the 422 detail echoes case.medical_scheme_name and the 202 body returns payer_name/payer_type — scheme attribution leaked to an anonymous caller.
3. Zero attribution: logger.info at main.py:657 records only the invoice id, no princi

</details>

---

### Provider settings/crew/vehicle/PRF endpoints authenticate any role — _assert_settings_access only constrains crew, never Users

- **Severity:** high · **Category:** tenant-isolation · **Lens:** authz
- **Location:** `backend/app/api/providers.py:819`

**Impact.** A paramedic/billing-clerk/dispatcher account — the lowest privilege the system can issue — can PATCH any provider's /settings to set portal_login_password and the admin crew password (full takeover of any tenant's portal), read/overwrite that tenant's Gmail/Outlook SMTP account, POST /crew/{id}/reset-password to get a plaintext temp password back (providers.py:1190 returns `"temp_password": new_password`), and GET /{provider_id}/prfs to page through another tenant's entire 7-year patient PRF history. On the client VM every back-office login becomes a master key over every provider on that instance.

<details><summary>Evidence</summary>

```
def _assert_settings_access(principal, provider_id: uuid.UUID) -> None:
    """Crew tokens may only manage their own provider's settings..."""
    if isinstance(principal, CrewMember):
        if principal.role != "admin" or principal.provider_id != provider_id:
            raise HTTPException(status_code=403, detail="Admin access required")

The User branch falls through with no check. get_admin_or_crew_admin (providers.py:88-114) returns ANY active User: `if user and user.is_active: return user` — it never looks at user.role. All 15 call sites (lines 844, 880, 975, 1004, 1038, 1099, 1133, 1176, 1201, 1247, 1290, 1313, 1342, 1385, 1442) are therefore wide open to every logged-in account, and the default role for a new User is PARAMEDIC (models/user.py:57 `default=UserRole.PARAMEDIC`).
```

</details>

**Recommended fix.** In _assert_settings_access, add an explicit User branch: `if isinstance(principal, User) and principal.role not in (UserRole.ADMIN, UserRole.SUPER_ADMIN): raise HTTPException(403, ...)`. Fixing the one helper covers all 15 endpoints.

<details><summary>Independent verification</summary>

CONFIRMED — the code says exactly what the claim says, and I found no guard, middleware, or shared dependency that closes it.

Verified line by line:

1. `_assert_settings_access` (backend/app/api/providers.py:819-824) branches only on `isinstance(principal, CrewMember)`. Its own docstring states the intent — "Full admin User tokens pass unchanged" — but the code never verifies the User is an admin. Any `User` instance returns from the function with no check at all.

2. `get_admin_or_crew_admin` (providers.py:88-131) is authn-only for the User branch: `if user and user.is_active: return user` (lines 113-114). It checks token type=="access", the blacklist, existence and is_active — all the hardening listed as already-fixed — but never `user.role`. The crew branch (118-130) likewise only checks is_active; the role gate for crew lives in `_assert_settings_access`, which is precisely why the missing User-side equivalent is a real asymmetry rather than a stylistic one.

3. Call sites: grep returns exactly the 15 lines cited (844, 880, 975, 1004, 1038, 1099, 1133, 1176, 1201, 1247, 1290, 1313, 1342, 1385, 1442). Every one is `_assert_settings_access(principal, ...)` immediately after `Depends(get_admin_or_crew_admin)`. No `require_role` anywhere in providers.py (grep: zero hits).

4. No compensating guard upstream: `app/main.py:260` is a bare `app.include_router(providers_router)` — no router-level `dependencies=[...]`. The middleware chain does no authorization. `require_role` exists in app/utils/security.py:194-203 and works correctly, but is simply not applied here.

5. Low-privilege Users are real and reachable: `models/user.py:56-57` `role ... default=UserRole.PARAMEDIC`, with DISPATCHER/PARAMEDIC/BILLING_CLERK in the enum (lines 37-42). `app/api/users.py:55-82` lets an ADMIN mint a user with any of those roles. `app/api/auth.py` login imposes no role restriction, so such an account gets a normal access token. The `permissions` JSON column that the employee-management UI edits is enforced nowhere on the server — grep for `.permissions` outside users.py hits only auth.py:308-309, where it is merely echoed to the client. Page-level restriction of a billing clerk or dispatcher is purely client-side.

6. Impact verified against the actual handler bodies, not asserted:
   - PATCH /{provider_id}/settings (871) sets `provider.portal_login_password_hash` (909) and overwrites the admin CrewMember's `hashed_password` (944), or creates an admin CrewMember if none exists (946-957) — full takeover of a tenant's crew portal.
   - POST /{provider_id}/crew/{crew_id}/reset-password (1168) returns `{"temp_password": new_password}` in plaintext at line 1190.
   - GET /{provider_id}/crew (list_crew, ~1004) hands back every crew id/email needed to target that reset.
   - 

</details>

---

### Provider create/update/delete are guarded only by get_current_user — any logged-in user can hard-delete a tenant and all its patient PRFs

- **Severity:** high · **Category:** authz · **Lens:** authz
- **Location:** `backend/app/api/providers.py:749`

**Impact.** One authenticated request with the lowest role destroys an entire client's patient record archive with no soft-delete and no per-tenant backup boundary, or silently rotates a competitor tenant's portal password. Nothing in the pipeline recovers this short of a full DB restore.

<details><summary>Evidence</summary>

```
@router.delete("/{provider_id}", status_code=204)
async def delete_provider(
    provider_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Hard-delete a provider and ALL related data (crew, vehicles, PRFs, logos)."""
...
    await db.execute(sql_delete(DigitalPRF).where(DigitalPRF.provider_id == pid))

`user` is bound and then never inspected. Same pattern on POST "" (line 544), POST /{provider_id}/logo (614), GET /{provider_id} (641) and PATCH /{provider_id} (673) — and PATCH sets provider.portal_login_password_hash (line 712) and the admin crew's hashed_password (729). The module docstring says "Admin-only endpoints" (providers.py:3); nothing enforces it.
```

</details>

**Recommended fix.** Swap `Depends(get_current_user)` for `Depends(require_role(UserRole.ADMIN, UserRole.SUPER_ADMIN))` on providers.py:544, 614, 641, 673, 749, and make the hard delete a soft deactivate given the 7-year retention obligation.

<details><summary>Independent verification</summary>

Claim confirmed by direct code reading; nothing in the middleware chain, router registration, or shared dependencies prevents it.

VERIFIED:
- providers.py:39 `router = APIRouter(prefix="/api/providers", tags=[...])` — no `dependencies=[...]`. main.py:260 `app.include_router(providers_router)` — no dependency added. main.py:146 `FastAPI(...)` — no global `dependencies`.
- create_provider (544), upload_provider_logo (614), get_provider (641), update_provider (673), delete_provider (749) each bind `user: User = Depends(get_current_user)` and never reference `user` anywhere in the body. Read all five bodies fully; no role check, no permission check, no `_assert_settings_access`.
- get_current_user (utils/security.py:142-189) is authentication ONLY: `type == "access"`, jti not blacklisted, user exists and is_active. Returns any User regardless of role. `require_role` exists (security.py:194) and is used in users.py, claims.py, account_security.py — never in providers.py.
- No path/role authz in middleware: grep for role/admin/providers across app/middleware returns nothing. ResponseCacheMiddleware is irrelevant to DELETE/PATCH.

SEVERITY IS IF ANYTHING UNDERSTATED:
- UserRole (models/user.py:37) = SUPER_ADMIN, ADMIN, DISPATCHER, PARAMEDIC, BILLING_CLERK, with column default PARAMEDIC (line 57). So dispatcher/paramedic/billing-clerk accounts — the low-trust operational roles — can call DELETE /api/providers/{id}, which executes sql_delete on DigitalPRF, Vehicle, CrewMember, ServiceProvider and commits. No soft-delete. logger.info (786) records the provider name but not the acting user, so there is no attribution either.
- PATCH is the cross-tenant vector: lines 708-712 set provider.portal_login_password_hash and 726-729 overwrite the admin CrewMember's email and hashed_password for ANY provider_id in the path. That portal password is the portal-grant device-unlock credential guarding a tenant's PRFs, so a non-admin user can set a known password on another tenant and unlock a device into it.

INTENT vs IMPLEMENTATION: everything below line 835 (/settings, /crew, /vehicles, /prfs) uses Depends(get_admin_or_crew_admin) PLUS _assert_settings_access (819-824), which enforces role=="admin" and provider_id match. The top-level CRUD block simply never got the equivalent. The module docstring (line 3, "Admin-only endpoints") and the section banner (line 482, "PROVIDER ENDPOINTS (admin-protected)") assert a guard that does not exist.

CHECKED AND DOES NOT RESCUE IT: crew tokens cannot reach these routes (get_current_user resolves `sub` against the users table), narrowing the attacker set to any logged-in staff user but not eliminating it. No FK constraint blocks the cascade — the only inbound FKs are crew_members/vehicles/digital_prfs -> service_providers (deleted 

</details>

---

### DELETE /api/cases/all lets any authenticated user wipe every case, claim, document and file on the instance

- **Severity:** high · **Category:** data-integrity · **Lens:** authz
- **Location:** `backend/app/api/cases.py:270`

**Impact.** A single curl from any low-privilege session — or a mis-fired frontend call — irrecoverably destroys the whole claims database and the PDFs on disk, across all tenants. This is the highest-blast-radius route in the codebase and it sits behind the weakest possible guard.

<details><summary>Evidence</summary>

```
@router.delete("/all", status_code=status.HTTP_204_NO_CONTENT)
async def delete_all_cases(
    queue: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    _current: User = Depends(get_current_user),
):

With no `queue` param the selection is unfiltered (`query = select(Case.id)`, line 288) and the handler then deletes RFI, SchemeAuthRequest, ClaimLine, Claim, Document rows and os.remove()s every stored PDF (lines 310-341). No role check, no confirmation token, no provider scoping. Sibling delete_case (line 347) is equally unguarded.
```

</details>

**Recommended fix.** Restrict to require_role(ADMIN, SUPER_ADMIN), require an explicit non-optional scope parameter so an unfiltered wipe cannot be requested by accident, and audit-log the caller.

<details><summary>Independent verification</summary>

CONFIRMED. DELETE /api/cases/all (backend/app/api/cases.py:270) declares only `db: AsyncSession = Depends(get_db)` and `_current: User = Depends(get_current_user)`. get_current_user (backend/app/utils/security.py) is authentication-only — decode, type=="access", blacklist check, user exists + is_active — and returns the User with no role or permission assertion. require_role exists in the same module and is applied on other routers (app/api/users.py:55-59, 92-97, 120-125, 159-163 all use require_role(UserRole.ADMIN)); it is simply absent here.

No guard exists at any other layer: the router is built as APIRouter(prefix="/api/cases", tags=["Cases"]) with no `dependencies=` (cases.py:19); app.include_router(cases_router) at main.py:247 passes no dependencies; FastAPI(...) at main.py:146-156 declares no global dependency; and no middleware in backend/app/middleware/*.py filters by path or method (ResponseCacheMiddleware is a GET-side cache, irrelevant to DELETE). Nothing in deploy/ or nginx blocks the path.

The behaviour is as described. Line 288 `query = select(Case.id)` is unfiltered; the `queue` param only narrows for the literal values 'era' or 'management'. Lines 304-318 os.remove() every storage_uri/processed_uri on disk; lines 322-343 delete RFI, SchemeAuthRequest, ClaimLine, Claim, Document and Case rows, then commit. No confirmation token, no dry-run, no provider scoping — the Case model has no tenant/provider FK at all (only assigned_provider_id -> users.id, an assignee, never consulted here). Route ordering is fine for the attacker: "/all" is registered at line 270 before "/{case_id}" at line 347, so the literal path matches and the endpoint is reachable, not shadowed.

Low-privilege reachability is real: UserRole (app/models/user.py:37-42) includes DISPATCHER, PARAMEDIC and BILLING_CLERK besides the two admin roles, and /api/auth/login applies no role filter — any active user of any role gets an access token that satisfies get_current_user. Sibling delete_case (line 347) is likewise guarded only by get_current_user with no ownership check, so any authenticated user can delete any case by ID.

Refutations I tested and that failed: (a) crew tokens cannot reach it — app/api/crew_auth.py mints tokens with "sub": str(crew.id), a CrewMember UUID, which get_current_user's select(User).where(User.id == user_uuid) will not resolve, so crew sessions 401; this narrows the attacker set to portal accounts but does not remove the defect; (b) there is no unauthenticated path and no open registration (auth.py exposes only login/refresh/logout/me; user creation is admin-only); (c) no env/APP_ENV gate on the route.

One element of the claim is overstated and should be corrected in the writeup: "or a mis-fired frontend call" is not demonstrated — grepping fro

</details>

---

### Fine-grained permissions are never enforced server-side — the whole permission model is client-side only

- **Severity:** high · **Category:** authz · **Lens:** authz
- **Location:** `backend/app/utils/security.py:194`

**Impact.** A user created with permissions=['dashboard'] is only hidden from UI links; their token reaches every endpoint. Concretely, with zero permissions they can still call: /api/rate-schemas/* and /api/tariff-lines/* (rule_builder, tariff_billing), /api/failed-prfs/* incl. PUT /{prf_id}/correct which rewrites clinical data (failed_forms), /api/providers/* (providers, employees, settings), /api/adjudication/* incl. POST /rfis/{id}/resolve, /api/edi/generate and /api/edi/submit (edi_submit), /api/era/ingest and /api/era/reconcile (era_tracking), /api/cases/* (cases), /api/documents/* incl. download and PATCH /{id}/review (upload, document_review), /api/analytics/dashboard and /api/stats (dashboard, analytics), /api/member-lookup/{scheme}/{member_number} (member PII), and /api/digital-prf/admin/by-case/{case_id}.

<details><summary>Evidence</summary>

```
security.py exposes exactly two guards — get_current_user (142) and require_role (194). There is no require_permission/has_permission anywhere: `grep -rn "require_permission|has_permission|check_permission" backend/app` returns nothing. `permissions` appears only where it is stored or echoed (models/user.py:61, api/users.py:27/84/141-142, api/auth.py:308). Every non-admin route binds get_current_user only, e.g. rate_schemas.py:175 `_user=Depends(get_current_user)`.
```

</details>

**Recommended fix.** Add `require_permission(*keys)` in utils/security.py that reads current_user.permissions (treating None as all, [] as none — matching the auth.py:308 fix) and apply it to each router; until then do not describe permissions as an access control anywhere client-facing.

<details><summary>Independent verification</summary>

CONFIRMED — the claim is accurate and I could not refute it.

security.py (read in full, 204 lines) defines exactly two auth dependencies: get_current_user (line 142) and require_role (line 194). A case-insensitive grep for "permission" across all of backend/app finds no guard: hits are only ALL_PERMISSIONS (models/user.py:14), the JSON column (models/user.py:61, comment "List of page-keys the user can access"), storage/echo in api/users.py, the /me echo in api/auth.py:308, the seed in main.py:117, an error *string* in security.py:200, and the Permissions-Policy header in sanitization.py:130. No code path anywhere reads user.permissions to authorize a request.

require_role is imported by only three routers: account_security.py, claims.py, users.py. I verified guards route-by-route in the routers named by the claim and every one binds get_current_user alone: rate_schemas.py (all 6 routes), tariff_lines.py (all 5), failed_prfs.py incl. PUT /{prf_id}/correct (:226) which rewrites clinical data, adjudication.py incl. POST /rfis/{id}/resolve (:608), edi.py /generate (:53) and /submit (:92), analytics.py /era/ingest (:63) and /era/reconcile (:88), cases.py incl. DELETE /all (:270), documents.py incl. GET /{doc_id}/download (:293) and PATCH /{doc_id}/review (:358), and member_lookup.py (:152, member PII).

I checked for upstream enforcement before concluding, per instructions. None exists: all 22 APIRouter(...) constructions are declared without a dependencies= argument; all 22 include_router calls in main.py are bare (no dependencies=); and the middleware package contains only crash_handler, logging_config, rate_limit, sanitization — none performs path-based authorization. The ResponseCacheMiddleware short-circuit is irrelevant here since it can only skip checks, never add them.

providers.py initially looked like a counterexample but is not. get_admin_or_crew_admin (:88) is authn-only for User tokens (type/blacklist/is_active), and _assert_settings_access (:819) narrows only CrewMember principals — its own docstring says "Full admin User tokens pass unchanged." So any authenticated User with zero permissions still reads/writes provider settings, crew and vehicle records.

Exploitability is real, not theoretical. UserRole has five values with default PARAMEDIC, and require_role(UserRole.ADMIN) is exact-match, so a PARAMEDIC/DISPATCHER/BILLING_CLERK created via POST /api/users with permissions=['dashboard'] authenticates normally and reaches every endpoint above. auth.py:305-309 carries a comment about a previously-fixed bug where an empty permissions list granted the full set — evidence the model is intended as a genuine grant, which makes the absent server-side half more serious.

This is not on the already-fixed list (those items concern crew-session mi

</details>

---

### POST /gateway/ forwards attacker-controlled payloads to real medical schemes using stored platform credentials, unauthenticated

- **Severity:** high · **Category:** authz · **Lens:** authz
- **Location:** `backend/app/api/gateway.py:22`

**Impact.** An unauthenticated caller can drive REQUEST_AUTH / SUBMIT_CLAIM traffic at a live scheme B2B endpoint signed with the platform's own credentials — fabricated authorisations, fraudulent claims, or enough junk traffic to get the credentials suspended. Mitigating factor: the router is mounted at /gateway (not /api/), so nginx's `location /` try_files swallows it in the current prod topology and only compose publishes 80/443 — but it is fully reachable on any deployment that exposes :8000 (dev, localhost, a client who publishes the backend port).

<details><summary>Evidence</summary>

```
@router.post("/")
async def submit_gateway_request(
    request: Request,
    gateway_req: GatewayRequest,
    db: AsyncSession = Depends(get_db)
):

No auth dependency. The body carries `scheme_destination_code` and a free-form `payload_data: dict`, and forward_to_scheme (services/gateway.py:37) resolves the scheme's stored credentials and calls `adapter.forward_payload(payload_data, action)` with them.
```

</details>

**Recommended fix.** Add require_role(ADMIN, SUPER_ADMIN) — this is a machine-to-machine integration endpoint and should also be pinned to an internal network or a service credential, not left as the only unauthenticated mutating route in app/api/.

<details><summary>Independent verification</summary>

The claim is accurate as written and I could not find a guard that defeats it.

CODE CONFIRMS THE CLAIM:
- backend/app/api/gateway.py is 49 lines total. APIRouter(prefix="/gateway") is constructed with no `dependencies=[...]`, and submit_gateway_request's only dependency is Depends(get_db). There is no get_current_user / require_role / API-key / HMAC check in the handler or the router.
- backend/app/main.py:33 imports it and :255 does `app.include_router(gateway_router)` with no dependencies= argument, so no mount-level guard either.
- Middleware chain (main.py:182-219) is ErrorLogging -> CORS -> GZip -> RateLimit -> XSSProtection -> CrashHandler -> ResponseCache. None of these authenticate. RateLimitMiddleware (app/middleware/rate_limit.py:102-145) does cover /gateway/ under the general api_limit (300/min, keyed by bearer token else client IP, fails open when Redis is down) — that throttles abuse but does not authorise it.
- The forwarding is exactly as described: services/gateway.py:51 get_adapter_for_scheme(scheme_destination_code) -> scheme_auth.resolve_scheme_credentials -> config.get_scheme_credentials_by_name (app/config.py:234-245) -> SCHEME_<ID>_* env vars; then services/gateway.py:80 `await adapter.forward_payload(payload_data, action)`. In adapters/generic.py:120-147 that acquires an OAuth2 access token from the platform's stored client_id/client_secret and POSTs the caller's raw dict verbatim to {base_url}/authorizations/ems/request (REQUEST_AUTH) or {base_url}/b2b/claims (SUBMIT_CLAIM); adapters/medscheme.py:103 is the API-key equivalent. Both the destination scheme and the payload body are fully attacker-chosen.

MITIGATIONS I VERIFIED (they lower today's exploitability, they do not refute the missing authz):
- No SCHEME_* variable is set in any environment file (.env, .env.dev, .env.prod, .env.prod.template, backend/.env) — only commented examples at backend/.env.example:148-158. So get_adapter_for_scheme currently returns None and the route fails closed with 503 in every existing environment. Credential abuse is latent, not live, today.
- The reachability caveat in the claim is correct: nginx/nginx.conf and infra/nginx/api.conf proxy only /api/, /docs, /openapi.json, /health, /uploads/; /gateway/ falls into `location /` and is served from the frontend static root. docker-compose.prod.yml publishes only 80/443.
- However docker-compose.yml (the dev/local stack) publishes "8001:8000", so the backend is directly reachable off-nginx there, and any client deployment that publishes the backend port gets the endpoint wide open.

WHY IT STILL MATTERS FOR THIS AUDIT (fresh-deployment-insecure-by-default, category c):
- The only thing keeping it closed is the absence of scheme credentials — i.e. the feature being unconfigured. Configuring SCHEM

</details>

---

### A revoked crew token still works as a portal grant, so logout/End Shift can be traded back for a fresh 12-hour patient-record session

- **Severity:** high · **Category:** authz · **Lens:** authz
- **Location:** `backend/app/api/crew_auth.py:287`

**Impact.** A crew token captured from a lost or shared tablet is not actually killable: after End Shift/logout it is rejected by the PRF endpoints but still satisfies require_portal_grant, so the holder replays it into POST /api/crew/shift-start-by-id (line 500) and receives a brand-new 12-hour token — for any active crew member of that provider, including one who has since been deactivated. This defeats the crew-revocation control added in f80df14 and keeps patient PRFs reachable indefinitely.

<details><summary>Evidence</summary>

```
async def require_portal_grant(provider_slug, token, db) -> ServiceProvider:
    ...
    payload = decode_token(token)
    scope = payload.get("token_scope")
    if scope not in (PORTAL_GRANT_SCOPE, "crew"):
        raise HTTPException(status_code=401, detail="Invalid device unlock token")
    if str(payload.get("provider_id")) != str(provider.id):
        raise HTTPException(status_code=403, ...)
    return provider

Signature + scope + provider binding only — no is_token_blacklisted call, no type=="access" check, and no lookup of the crew member the token names (so is_active is not consulted either). Meanwhile crew_logout (line 589) and End Shift blacklist that exact jti, and get_current_crew honours the blacklist at line 94.
```

</details>

**Recommended fix.** In require_portal_grant, check `payload.get("type") == "access"`, consult is_token_blacklisted(jti), and when scope=="crew" re-load the CrewMember and require is_active — mirroring get_current_crew.

<details><summary>Independent verification</summary>

The core defect is real and I could not find any guard that prevents it, but two supporting details in the claim's evidence are wrong and one is inert — so the impact needs restating.

WHAT THE CODE ACTUALLY SAYS (verified, not asserted)

`require_portal_grant` (C:/Users/USER-PC/Desktop/New EMS AUTOMATIONS/backend/app/api/crew_auth.py:287-322) does exactly three things after resolving the provider: `decode_token(token)` (signature/exp only — `decode_token` at backend/app/utils/security.py:93-102 does no blacklist and no type check), `token_scope in (PORTAL_GRANT_SCOPE, "crew")`, and `provider_id == provider.id`. There is no `is_token_blacklisted` call and no `select(CrewMember)` — so neither revocation nor `is_active` is consulted on this path. By contrast `get_current_crew` (crew_auth.py:94, 96-99) checks both.

Not guarded elsewhere: `main.py` registers only ErrorLogging/CORS/RateLimit/XSS/CrashHandler/GZip/ResponseCache — no global auth dependency, and `include_router(crew_auth_router)` (main.py:259) passes no router-level `dependencies=`. ResponseCacheMiddleware is irrelevant here (the exploit endpoints are POSTs). So the path is genuinely reachable.

Consumers of the weak dependency: `/api/crew/shift-start-by-id` (crew_auth.py:513), `/api/crew/lookup-hpcsa` (417), `/api/providers/{slug}/public-crew` (providers.py:460), `/api/providers/{slug}/public-vehicles` (providers.py:426).

THE EXPLOIT THAT ACTUALLY WORKS — and it is worse than a replay

Admins can deactivate a crew member: `PATCH /api/providers/{provider_id}/crew/{crew_id}` (providers.py:1090-1116) blind-`setattr`s `is_active` from `CrewMemberUpdate`. After that, the ex-crew member's still-unexpired 12h token is rejected by every PRF endpoint (get_current_crew:98) but STILL satisfies `require_portal_grant`. The holder then calls `/api/providers/{slug}/public-crew` with the same dead token to list colleague UUIDs, and POSTs one to `/api/crew/shift-start-by-id`, receiving a brand-new 12-hour crew token minted as that colleague — full read/edit/delete on patient PRFs, under someone else's identity in the audit trail.

Worse, the minted token is itself `token_scope: "crew"`, so it satisfies `require_portal_grant` again. The session is indefinitely self-renewable: the 12-hour bound is not a bound, and the company-password gate added in f80df14 is a one-time cost per device, forever. Deactivating the crew member is the only revocation lever an admin has, and it does not close this.

WHERE THE CLAIM IS WRONG (why the write-up needs correcting, not why it's refuted)

1. "End Shift blacklists that exact jti" — false. End Shift (frontend/src/pages/crew/CrewDashboard.tsx:297) calls `/api/digital-prf/end-shift`, which only deletes empty draft PRFs (backend/app/api/digital_prf.py:876-916) and blacklist

</details>

---

### SUPER_ADMIN is 403'd out of user management, claim void/rebill and System Health — the seed account on a fresh deploy is SUPER_ADMIN

- **Severity:** high · **Category:** deploy-readiness · **Lens:** authz
- **Location:** `backend/app/api/users.py:59`

**Impact.** On a brand-new client VM the one existing account is SUPER_ADMIN and is therefore locked out of creating users, listing users, updating roles/permissions, deactivating users, voiding or rebilling claims, and the entire crash/System Health dashboard. The client cannot onboard their own staff without someone hand-editing the users table, and the highest-privilege role has strictly fewer rights than ADMIN.

<details><summary>Evidence</summary>

```
users.py:34/59/97/125/163 all pass a single role: `_admin: User = Depends(require_role(UserRole.ADMIN)),` — and require_role is exact membership (`if current_user.role not in roles`, security.py:197). claims.py:243 and :302 do the same for void_claim and rebill_claim. crashes.py hand-rolls the same mistake five times: `if current_user.role.value != "admin": raise HTTPException(403, "Admin access required")` at lines 119, 164, 263, 287, 308.

Startup then promotes the only seeded account past that gate — main.py:113-114: `if admin.role != UserRole.SUPER_ADMIN: admin.role = UserRole.SUPER_ADMIN`. account_security.py:51 shows the correct pattern: `require_role(UserRole.ADMIN, UserRole.SUPER_ADMIN)`.
```

</details>

**Recommended fix.** Pass both roles at all 7 require_role sites in users.py/claims.py, and replace the five `role.value != "admin"` string tests in crashes.py with `Depends(require_role(UserRole.ADMIN, UserRole.SUPER_ADMIN))`. Note also that DISPATCHER/PARAMEDIC/BILLING_CLERK are never named at any call site, so on every route that is not one of these 9 they are indistinguishable from an admin.

<details><summary>Independent verification</summary>

CONFIRMED — the authz defect is real and every line of cited evidence is literally present. One factual correction to the claim's bootstrap story (below), which lowers the "day-one lockout" framing but not the defect.

VERIFIED IN CODE
1. `backend/app/utils/security.py:194-203` — `require_role(*roles)` is exact membership: `if current_user.role not in roles: raise 403`. `UserRole` (backend/app/models/user.py:37-42) is a plain str-Enum with distinct members `SUPER_ADMIN = "super_admin"` and `ADMIN = "admin"`, so `UserRole.SUPER_ADMIN not in (UserRole.ADMIN,)` is True → 403. No hierarchy anywhere.
2. `backend/app/api/users.py` lines 34, 59, 97, 125, 163 each pass only `require_role(UserRole.ADMIN)` — i.e. permissions-list, create_user, list_users, update_user (role/permissions/password reset), delete_user (deactivate). Verified by reading the whole file.
3. `backend/app/api/claims.py:243` (void_claim) and `:302` (rebill_claim) — same single-role dependency.
4. `backend/app/api/crashes.py` lines 119, 164, 263, 287, 308 hand-roll `if current_user.role.value != "admin": raise HTTPException(403, ...)` on list_crashes, crash_stats, resolve_crash, delete_crash, purge. These five use REQUIRED auth (`Depends(get_current_user)`), so the "crashes.py uses OPTIONAL auth on purpose" exemption does not cover them — that applies only to the POST report endpoint above line 101.
5. `backend/app/api/account_security.py:51` and `:102` do it correctly: `require_role(UserRole.ADMIN, UserRole.SUPER_ADMIN)` — proof the codebase knows the right pattern and these 12 call sites are omissions, not policy.
6. No mitigating guard: `main.py:245-256` registers users/claims/crashes routers with no `dependencies=[...]` override; routers are declared bare (`APIRouter(prefix=..., tags=...)`). Nothing in the middleware chain grants role. ResponseCacheMiddleware can only make this worse (cache HIT skips the route), never better.
7. Reachability is real, not theoretical: `frontend/src/App.tsx:61` computes `isAdmin = role === 'admin' || role === 'super_admin'`, so a SUPER_ADMIN is shown Employee Management and System Health and every call 403s. `frontend/src/pages/EmployeeManagement.tsx` calls exactly the blocked endpoints (`GET/POST /api/users/`, `PATCH /api/users/{id}`, `/api/users/permissions-list`); `frontend/src/pages/SystemHealth.tsx` calls all five blocked crash endpoints. And `update_user` does `user.role = UserRole(body.role)`, so an ADMIN can mint a SUPER_ADMIN — who is then strictly less privileged and, if the promoting admin promoted themselves, self-locked out of ever undoing it.

WHERE THE CLAIM OVERSTATES — the "fresh deploy" mechanism
The seed/promotion path is gated to non-production. `main.py:66` wraps both `seed_admin_user()` and `seed_super_admin()` in `if settings.APP_E

</details>

---

### POST /gateway/ forwards attacker-controlled payloads to real medical schemes with no authentication

- **Severity:** high · **Category:** authz · **Lens:** tenant-isolation
- **Location:** `backend/app/api/gateway.py:22`

**Impact.** Anyone who can reach the backend port can submit fraudulent pre-authorisations and EDI claims to a live medical scheme under this provider's practice number, using credentials they never see. In the CURRENT production topology this is shielded by accident, not design: nginx/nginx.conf proxies only /api/, /health, /uploads and /docs, so /gateway/ falls through to `location /` and is served by the SPA. That shield does not survive the second deployment — docker-compose.yml:80-81 publishes the backend on host port 8001, so a client VM brought up with the dev compose file (or any nginx whose config differs) exposes http://<vm>:8001/gateway/ directly to the internet. A security control that depends on a reverse-proxy path list is exactly the control that breaks when someone else runs the stack.

<details><summary>Evidence</summary>

```
@router.post("/")
async def submit_gateway_request(
    request: Request,
    gateway_req: GatewayRequest,
    db: AsyncSession = Depends(get_db)
):

There is no get_current_user / get_current_crew / require_role dependency — only get_db. The body is fully caller-controlled:

    internal_claim_id: str
    scheme_destination_code: str
    action: Literal["REQUEST_AUTH", "SUBMIT_CLAIM"]
    payload_data: dict

and it lands in app/services/gateway.py:47-80, which resolves the INSTANCE's stored scheme credentials and forwards the payload verbatim:

    adapter = get_adapter_for_scheme(scheme_destination_code)
    ...
    response = await adapter.forward_payload(payload_data, action)

Registered in main.py:255 as `app.include_router(gateway_router)` with the router's own prefix="/gateway" — note this is NOT under /api, so it also sits outside the /api RateLimit bucket.
```

</details>

**Recommended fix.** Add `_current: User = Depends(require_role(UserRole.ADMIN, UserRole.SUPER_ADMIN))` to submit_gateway_request, and move the router under the /api prefix so it inherits the rate limiter. Independently, stop publishing backend port 8001 in docker-compose.yml, or bind it to 127.0.0.1.

<details><summary>Independent verification</summary>

The code says what the claim says, and no guard prevents it.

CONFIRMED:
- backend/app/api/gateway.py:14 — APIRouter(prefix="/gateway", tags=[...]) has NO dependencies= argument. Line 22-27: the route's only dependency is get_db. No get_current_user / get_current_crew / require_role anywhere in the file.
- backend/app/main.py:146-156 — FastAPI(...) is constructed with no global dependencies. main.py:255 is a bare app.include_router(gateway_router), so the full path is POST /gateway/, outside /api.
- Middleware chain supplies no authentication: CORS -> GZip -> RateLimit -> XSSProtection -> CrashHandler -> ResponseCache. ResponseCacheMiddleware only handles GETs.
- app/utils/idempotency.py:29-40 (process_idempotent_request) reads only an Idempotency-Key header or hashes the body; no credential check.
- The forwarding is real, not nominal. app/services/gateway.py:80 calls adapter.forward_payload(payload_data, action); app/services/adapters/generic.py:118-145 mints an OAuth2 token from the INSTANCE's client_id/client_secret and POSTs the caller-supplied payload verbatim to {base_url}/authorizations/ems/request (REQUEST_AUTH) or {base_url}/b2b/claims (SUBMIT_CLAIM), attaching the instance's X-Provider-Practice header. The attacker supplies the payload and never sees the credentials, exactly as claimed.
- nginx/nginx.conf confirms the accidental shield: only /api/, /api/auth/login, /health and ^~ /uploads/ are proxied (with /docs and /openapi.json denied); /gateway/ falls through to location / { try_files $uri $uri/ /index.html } and is answered by the SPA.
- docker-compose.yml:80-81 does publish "8001:8000".
- Not on the already-fixed or deliberate list; no test covers /gateway; git log shows the file untouched since the initial import.

TWO CORRECTIONS to the claim's supporting details (neither rescues the route):
1. The "outside the /api RateLimit bucket" sub-claim is WRONG. app/middleware/rate_limit.py:220-226 exempts only "/", "/health", "/docs", "/openapi.json", "/static*" and loopback peers; every other path INCLUDING /gateway/ is keyed into the rl:api: bucket at 300/min per IP (fail-open when Redis is down). Rate limiting is not authentication, so the finding stands.
2. docker-compose.prod.yml:54-55 explicitly publishes NO backend ports ("No ports exposed — Nginx reverse-proxies to this container"), and deploy/GO-LIVE-RUNBOOK.md drives deploys with -f docker-compose.prod.yml. So the second-deployment exposure requires the client to bring the stack up with the dev docker-compose.yml (the one CLAUDE.md documents as plain "docker-compose up") plus a permissive NSG. Plausible for a client-run instance, but not automatic.

SEVERITY NUANCE the claim overstates today: no SCHEME_*_BASE_URL is set in backend/.env.example (all lines commented) or in any live

</details>

---

### DELETE /api/cases/all deletes PDFs from disk before a DB transaction that cannot commit — permanent file loss with no role check

- **Severity:** high · **Category:** data-integrity · **Lens:** tenant-isolation
- **Location:** `backend/app/api/cases.py:270`

**Impact.** On any instance where at least one Digital PRF has been processed into a Case — i.e. every real deployment — this endpoint deletes every scanned PRF PDF off the uploads volume, then hits digital_prfs_case_id_fkey, rolls the transaction back, and returns a 500. The caller sees a failure and the DB looks untouched, so nobody knows the source documents are gone; the rows still point at storage_uri paths that no longer exist. Compounding it, the only guard is get_current_user, which utils/security.py:194-203 shows is authn-only — require_role is never applied — so a DISPATCHER, PARAMEDIC or BILLING_CLERK token, or any stolen low-privilege token, triggers it against seven years of retained claims.

<details><summary>Evidence</summary>

```
@router.delete("/all", status_code=status.HTTP_204_NO_CONTENT)
async def delete_all_cases(
    queue: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    _current: User = Depends(get_current_user),
):

Files are removed first, outside any transaction (lines 304-317):

    # Delete physical files (chunked to avoid parameter limit)
    ...
            for uri in [doc.storage_uri, doc.processed_uri]:
                if uri:
                    full_path = get_full_path(uri)
                    if os.path.exists(full_path):
                        try:
                            os.remove(full_path)
                        except OSError:
                            pass

The DB deletes then run at lines 340-341 and commit only at 343:

        await db.execute(delete(Document).where(Document.case_id.in_(chunk_cases)))
        await db.execute(delete(Case).where(Case.id.in_(chunk_cases)))
    await db.commit()

DigitalPRF holds FKs to both tables (models/digital_prf.py:129-133, `ForeignKey("cases.id")` and document_id). The single-case sibling knows this and severs them first (cases.py:387-392):

    # ... without nulling them first the Document delete below trips
    # the digital_prfs_document_id_fkey constraint.
    await db.execute(
        update(DigitalPRF)
        .where(DigitalPRF.case_id == case.id)
        .values(case_id=None, document_id=None)
    )

delete_all_cases has no such update.
```

</details>

**Recommended fix.** Gate it with require_role(UserRole.ADMIN, UserRole.SUPER_ADMIN); null the DigitalPRF.case_id/document_id references first exactly as delete_case does; and move the os.remove loop to AFTER a successful db.commit() so the filesystem can never diverge from a rolled-back transaction.

<details><summary>Independent verification</summary>

CLAIM STANDS — verified on all three legs, none refuted.

1. CODE MATCHES VERBATIM. backend/app/api/cases.py:270-343 is exactly as quoted. os.remove of storage_uri/processed_uri runs unconditionally at lines 304-318; the ONLY commit is at line 343, with no intermediate commits. Files are destroyed before any DB statement in a transaction that will not commit.

2. ROUTE IS REACHABLE. /all is registered at line 270, ahead of /{case_id} at line 347. FastAPI matches in declaration order, so DELETE /api/cases/all binds to delete_all_cases and is not shadowed.

3. FK VIOLATION IS REAL. models/digital_prf.py:129-135 declares case_id ForeignKey("cases.id") and document_id ForeignKey("documents.id") with NO ondelete; models/case.py has no cascade/passive_deletes. Migration f4b9c1d7e2a8's own docstring states digital_prfs is created by SQLAlchemy create_all, so deployed constraints are NO ACTION. tasks/prf_processing.py:329-330 sets prf.case_id and prf.document_id on every PRF reaching PROCESSED, so the FKs are populated on the normal path. Line 340's delete(Document) trips digital_prfs_document_id_fkey (or line 341 trips digital_prfs_case_id_fkey when document_id is null) — always before line 343. Bulk delete() statements bypass ORM cascades, so nothing rescues it. Net effect: PDFs gone from disk, transaction rolled back, 500 returned, DB rows still pointing at missing storage_uri paths — silent, unrecoverable loss.

4. OMISSION IS PROVEN, NOT INFERRED. The single-case sibling delete_case at cases.py:388-392 performs update(DigitalPRF).values(case_id=None, document_id=None) with a comment naming digital_prfs_document_id_fkey explicitly. delete_all_cases has no equivalent.

5. NO ROLE CHECK, AND THE CLAIM'S ROLE LIST IS CORRECT. cases.py:19 router has no dependencies; main.py:247 is a bare include_router with no dependencies; no app-level dependencies in main.py. Sole guard is get_current_user, which ends at security.py:189 returning the user; require_role (194-203) is a separate factory never applied here. models/user.py:37-57 confirms UserRole includes DISPATCHER, PARAMEDIC, BILLING_CLERK and the column default is PARAMEDIC — the lowest-privilege account type can invoke a mass delete by default.

REFUTATION AVENUES CHECKED AND CLOSED: no middleware mitigates (ResponseCacheMiddleware only short-circuits cache HITs on reads, not a DELETE); not on the already-fixed or deliberate lists; path is not dead code. Absence of any frontend caller or test for cases/all (grepped repo-wide, only the backend definition exists) is NOT a mitigation — it is a live authenticated HTTP route, and the lack of exercise explains why the FK breakage was never discovered.

MINOR IMPACT REFINEMENT (does not change verdict): digital_prfs rows themselves survive since this endpoint neve

</details>

---

### create_prf accepts another provider's crew_member_2_id and vehicle_id, and get_prf then returns that crew member's name, HPCSA number and qualification

- **Severity:** high · **Category:** tenant-isolation · **Lens:** tenant-isolation
- **Location:** `backend/app/api/digital_prf.py:296`

**Impact.** A crew member of provider A creates a PRF with provider B's crew UUID in crew_member_2_id, then GETs their own PRF and reads back B's employee full name, initials, HPCSA registration number and qualification. _load_crew_prf correctly 404s cross-provider PRFs, so this is the one path that walks around it: the object being read belongs to A, but the data rendered into it is B's. The same write also pins B's vehicle and crew onto A's billing record, which is the attribution corruption the save-path comment was written to prevent. With a second client on the platform this stops being theoretical — B is a real competitor whose staff roster is now readable, and it lands in A's generated PDF.

<details><summary>Evidence</summary>

```
POST /api/digital-prf writes both foreign keys straight from the request body with no ownership check (lines 293-297):

    prf = DigitalPRF(
        provider_id=crew.provider_id,
        crew_member_1_id=crew.id,
        crew_member_2_id=uuid.UUID(body.crew_member_2_id) if body.crew_member_2_id else None,
        vehicle_id=uuid.UUID(body.vehicle_id) if body.vehicle_id else None,

PATCH /{prf_id} guards the identical two fields (lines 432-444), with a comment naming this exact attack:

    # Update crew/vehicle assignments. Every assigned vehicle / crew member must
    # belong to the caller's provider ...
        await _assert_provider_owns(db, Vehicle, new_vehicle_id, crew.provider_id, "vehicle")
        await _assert_provider_owns(db, CrewMember, new_c2, crew.provider_id, "crew member")

and _assert_provider_owns itself (line 202) is documented as "Used to stop a crew from attaching another company's vehicle or crew member to their PRF (which would corrupt tenant isolation and billing attribution)." The create path never calls it.

The read-back sink has no provider filter either — get_prf's helper at line 1396-1405:

    async def _crew(crew_id):
        ...
        r = await db.execute(select(CrewMember).where(CrewMember.id == crew_id))
        ...
        return {
            "full_name": c.full_name,
            "initials": c.initials,
            "hpcsa_number": c.hpcsa_number,
            "qualification": c.qualification,
        }

(the same unfiltered lookup repeats at line 1584 for the admin by-case viewer, and at providers.py:1483-1485 for the provider PRF list).
```

</details>

**Recommended fix.** Call _assert_provider_owns for vehicle_id and crew_member_2_id in create_prf before constructing the DigitalPRF, mirroring lines 435-444. Additionally scope the three _crew()/crew-name lookups with `CrewMember.provider_id == prf.provider_id` so a stale or malicious cross-tenant FK can never render.

<details><summary>Independent verification</summary>

The code says exactly what the claim says, and I could not find any guard, middleware, dependency, schema validator, or DB constraint that prevents it.

VERIFIED POINT BY POINT:

1. Missing guard on create (backend/app/api/digital_prf.py:293-302). create_prf builds the row with crew_member_2_id=uuid.UUID(body.crew_member_2_id) and vehicle_id=uuid.UUID(body.vehicle_id) directly from the request body. _assert_provider_owns is never called in this function. Confirmed by reading the whole endpoint (lines 219-342), not just the quoted excerpt.

2. No schema-level defence. PRFCreateRequest (lines 37-61) declares vehicle_id and crew_member_2_id as bare `str | None`. Grep for `field_validator`/`validator` in digital_prf.py returns zero hits, so nothing normalises or ownership-checks them before the ORM write.

3. The asymmetry with PATCH is real, not asserted. save_prf lines 432-448 calls _assert_provider_owns for both the identical fields, and _assert_provider_owns (lines 202-212) carries the docstring "Used to stop a crew from attaching another company's vehicle or crew member to their PRF (which would corrupt tenant isolation and billing attribution)." Same two fields, guarded on the update path, unguarded on the create path.

4. No database backstop. models/digital_prf.py declares vehicle_id / crew_member_1_id / crew_member_2_id as plain ForeignKey("vehicles.id") / ForeignKey("crew_members.id"). The FK enforces row existence only, not provider ownership. There is no composite (id, provider_id) FK. The only table constraint is UniqueConstraint("provider_id","prf_number"), which is unrelated.

5. Unfiltered read-back sinks confirmed in all three locations cited:
   - digital_prf.py:1396-1408, get_prf's _crew() helper: select(CrewMember).where(CrewMember.id == crew_id), returning full_name, initials, hpcsa_number, qualification, rendered into crew_member_1/crew_member_2.
   - digital_prf.py ~1580, the admin by-case viewer, byte-identical helper.
   - providers.py:1487, select(CrewMember.id, CrewMember.full_name).where(CrewMember.id.in_(crew_ids)) for the provider PRF list, and the parallel Vehicle.callsign lookup at 1493.
   None of these add a provider_id predicate.

6. Guard chain checked, nothing intercepts. Route is POST /api/digital-prf (router prefix line 32) with Depends(get_current_crew), which authenticates the caller but says nothing about body-supplied IDs. ResponseCacheMiddleware only short-circuits GETs, so it is irrelevant to the write. _load_crew_prf (164-199) does correctly 404 cross-provider PRFs, but it cannot help here: the PRF being read genuinely belongs to the caller's provider — only the data joined into it is foreign. The claim's characterisation of this as "the one path that walks around it" is accurate.

7. Not on the already-fixed

</details>

---

### Alembic can never create the schema — a fresh client instance boots with no tables

- **Severity:** high · **Category:** deploy-readiness · **Lens:** data-integrity
- **Location:** `backend/alembic/versions/04be48895f1c_initial_schema.py:24`

**Impact.** Standing up the platform on the client's VM per the written runbook produces a backend with an empty database. Every request 500s. The only recovery is undocumented: flip APP_ENV to development to let create_all run (which also enables the dev admin seed, /docs, and the dev CORS posture), then flip it back and `alembic stamp head`. This also means the two instances' schemas will diverge over time, because the client's DB will have been built by create_all from whatever model file shipped, not by a reviewed migration.

<details><summary>Evidence</summary>

```
The root migration is a no-op:

```python
# 04be48895f1c_initial_schema.py
def upgrade() -> None:
    """Upgrade schema."""
    # ### commands auto generated by Alembic - please adjust! ###
    pass
```

`grep -c create_table backend/alembic/versions/*.py` matches **zero** files — not one of the 29 migrations creates a table. The third migration in the chain then does:

```python
# 66bd72a732f9_add_scheme_adapter_fields.py
op.alter_column('cases', 'dependant_code', ...)
```

which raises `relation "cases" does not exist` on an empty database. The only thing that has ever built the schema is:

```python
# app/main.py:57
if settings.APP_ENV == "development":
    await create_tables()
```

and `app/config.py:17` reads `APP_ENV: str = "production"`, so a correctly-configured fresh instance skips it. The documented install path is `infra/DEPLOY-AZURE.md:497` → `docker exec ems_backend alembic upgrade head` (`deploy/GO-LIVE-RUNBOOK.md:139` calls it "⚠️ MANDATORY").
```

</details>

**Recommended fix.** Autogenerate a real baseline migration against a create_all-built database, insert it as the new root (or replace the body of 04be48895f1c), and verify `alembic upgrade head` against a genuinely empty Postgres in CI before the client deploy. Also fix `infra/DEPLOY-AZURE.md:499` which still says the expected head is `b4c8d2e6f7a3` — the real head is `c7d9e1f3a5b8`.

<details><summary>Independent verification</summary>

CONFIRMED. Every load-bearing element of the claim is true in the code.

(1) backend/alembic/versions/04be48895f1c_initial_schema.py:21-25 upgrade() is literally `pass`; so is the second revision 3f98acd077f5_add_billing_guidelines_table.py:21-24.

(2) `op.create_table` appears ZERO times across all 29 migration files. The only table-creating DDL anywhere is one raw `CREATE TABLE IF NOT EXISTS rate_schemas` in a3b7c9d1e5f2_billing_critical_fixes.py:109 — a single auxiliary table, far downstream of the failure point. (Minor overstatement in the evidence: "not one of the 29 migrations creates a table" is technically off by that one raw statement, but it is immaterial.)

(3) Chain order verified by reading every revision/down_revision: 04be48895f1c (no-op) -> 3f98acd077f5 (no-op) -> 66bd72a732f9, whose first statement is op.alter_column('cases','dependant_code',...) at line 24. On an empty DB that raises UndefinedTable: relation "cases" does not exist. Real single head is c7d9e1f3a5b8. Migrations downstream are full of `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` whose own docstrings state "dev DBs are create_all-managed" and reference "an earlier Base.metadata.create_all() bootstrap" (d4e7f2c1a8b9:8) — the chain was authored assuming a pre-existing schema.

(4) create_all is genuinely unreachable in a correct prod boot: app/config.py:17 `APP_ENV: str = "production"`; app/main.py:56-59 gates `await create_tables()` on APP_ENV == "development". create_all exists only in app/database.py:80, tests/conftest.py:181, seed_jems.py:28. No Docker entrypoint, compose command, or deploy script invokes it — backend/Dockerfile and Dockerfile.prod go straight to uvicorn/gunicorn; docker-compose.prod.yml has no init/migrate container.

(5) The fresh-client-instance guide infra/DEPLOY-AZURE.md sets APP_ENV=production (line 262) and its ONLY schema step is Step 10 line 497 `docker exec ems_backend alembic upgrade head`. Same in infra/DEPLOY.md:298 and deploy/GO-LIVE-RUNBOOK.md:139 ("MANDATORY"). .env.prod.template:58 and .env.prod:35 both set APP_ENV=production. Corroborating that this path has never been run against an empty DB: the docs' "Expected head" values are stale (b4c8d2e6f7a3 / a3b7c9d1e5f2) versus the actual head c7d9e1f3a5b8.

No guard, middleware, entrypoint, seed script, or SQL dump anywhere in the repo builds the schema on the documented path (infra/postgres/ contains only postgresql.conf; no schema.sql, no pg_restore step in any doc).

TEMPERING on impact only (does not change refuted=false): the failure is loud, not silent — `alembic upgrade head` aborts with UndefinedTable at Step 10, so the operator gets a stopped deploy, not a running backend 500ing on every request with patient data at risk. Severity is "the written install procedure cannot stand up a

</details>

---

### Every provider's failed PRFs — full form_data, patient ID, clinical notes — readable by any authenticated user

- **Severity:** high · **Category:** tenant-isolation · **Lens:** data-integrity
- **Location:** `backend/app/api/failed_prfs.py:124`

**Impact.** Any account on the instance — including the lowest default role — can enumerate and read the complete patient record of every failed or stuck PRF belonging to every one of the ~105 provider companies on that instance, and can rewrite the form_data of any of them via /correct. On the shared instance this is a cross-tenant PHI breach between competing ambulance companies; on the client instance it means their ordinary staff logins are effectively super-admin over the whole failed-PRF queue.

<details><summary>Evidence</summary>

```
Nothing in this router filters by provider, and nothing checks role:

```python
@router.get("")
async def list_failed_prfs(
    search: str | None = Query(None, ...),
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),        # authn only
):
    query = (select(DigitalPRF).where(or_(DigitalPRF.status == PRFStatus.FAILED, _stuck_condition())))
```

`GET /{prf_id}` returns the whole record:

```python
    return {
        ...
        "form_data": prf.form_data,      # patient name, SA ID, scheme number, clinical notes
        "review_flags": prf.review_flags,
```

`get_current_user` (app/utils/security.py:142) validates signature, type, blacklist and is_active — it does not look at `role`. `User.role` defaults to `UserRole.PARAMEDIC` (app/models/user.py:57). `PUT /{prf_id}/correct` and `POST /{prf_id}/reprocess` carry the same dependency and are likewise unscoped.
```

</details>

**Recommended fix.** Gate the whole router with `require_role(ADMIN, SUPER_ADMIN)` (passing both, per the exact-match convention), and scope every query by the caller's provider the way `_load_crew_prf` does in digital_prf.py.

<details><summary>Independent verification</summary>

The code says what the claim says on the technical points, and I verified each one rather than taking the evidence as given. backend/app/api/failed_prfs.py imports only get_db and get_current_user; there is no require_role, no permission check, and no provider_id filter in the file. All five endpoints (/stats, "", /{prf_id}, /{prf_id}/correct, /{prf_id}/reprocess) carry only Depends(get_current_user). app/main.py:264 registers the router with no dependencies=[...] argument, so there is no router-level or prefix-level guard, and the route is live (used by frontend/src/pages/Cases.tsx:88/453/474). get_current_user (app/utils/security.py:142-189) validates signature, type=="access", JTI blacklist, and user exists+is_active, and never reads role. GET /{prf_id} does return prf.form_data and prf.review_flags verbatim (lines 209/217), and PUT /{prf_id}/correct accepts an arbitrary form_data dict and writes a new PRF. User.role defaults to PARAMEDIC (app/models/user.py:57) and the per-user `permissions` list (which contains "failed_forms") is enforced NOWHERE in the backend - grep over app/api/*.py and app/utils/security.py shows it is only read/written by users.py and echoed by auth.py:308, i.e. it is a frontend nav gate only. So a non-admin back-office account, or an admin whose permissions deliberately exclude failed_forms, can enumerate and read full PHI and rewrite form_data. Not on the already-fixed or deliberate lists. Two parts of the claimed IMPACT are wrong and should be corrected, which lowers the severity. (1) The cross-tenant framing does not hold: User has no provider_id column and there is no mechanism anywhere to scope a User to a provider; provider/crew principals use crew tokens (token_scope=="crew", sub=crew.id) and such a token cannot satisfy get_current_user - it passes type=="access" but then select(User).where(User.id == <crew UUID>) returns None -> 401. Only providers.get_admin_or_crew_admin accepts crew tokens and it is not used by this router. So the exposed population is the operating company's own back-office User accounts, not the ~105 provider companies. (2) User rows can only be created by require_role(ADMIN) (app/api/users.py:59) and the seed account is SUPER_ADMIN (main.py:97/113), so "any account on the instance" means a deliberately-created DISPATCHER/BILLING_CLERK/PARAMEDIC or a permission-restricted admin, not a self-service signup. Additional context that matters for triage: this is a codebase-wide pattern, not a one-file oversight - cases.py:108, documents.py:77/364, and all of tariff_lines.py and rate_schemas.py are equally authn-only; require_role appears only in users.py, claims.py:243/302 and account_security.py. Net: real, demonstrated missing-authorization defect with a PHI read and an unauthenticated-by-role writ

</details>

---

### Deleting a crew member force-deletes their submitted and processed PRFs — and orphans the Cases and Claims

- **Severity:** high · **Category:** data-integrity · **Lens:** data-integrity
- **Location:** `backend/app/api/providers.py:1214`

**Impact.** A client's own office admin deactivating a paramedic who left silently destroys every patient report that person ever wrote or co-signed — including PROCESSED records inside the 7-year retention window — and every PRF where they were merely the second crew member, i.e. reports authored by someone else. The claims survive as billable rows with no source document, so the provider is left billing schemes for calls whose PRF no longer exists, with no audit-log entry recording the deletion.

<details><summary>Evidence</summary>

```
```python
    from sqlalchemy import delete
    from app.models.digital_prf import DigitalPRF

    # ⚠️ TEMPORARY ENABLEMENT: Force-delete dud PRFs associated with this crew member
    await db.execute(
        delete(DigitalPRF).where(
            (DigitalPRF.crew_member_1_id == crew.id) |
            (DigitalPRF.crew_member_2_id == crew.id)
        )
    )
    await db.delete(crew)
```

There is no status filter. Compare the sibling `delete_vehicle` (line 1399), which does it correctly:

```python
    # Preserve historical PRFs by nulling their vehicle reference
    await db.execute(update(DigitalPRF).where(DigitalPRF.vehicle_id == vehicle.id).values(vehicle_id=None))
```

This contradicts the crew-facing rule stated in `digital_prf.delete_prf:838`: "Submitted / processed PRFs are billing records — never deletable from crew app". The endpoint is reachable by the provider's own crew-admin (`get_admin_or_crew_admin` + `_assert_settings_access`), and the Case / Document / Claim / ClaimLine rows created from those PRFs are left behind.
```

</details>

**Recommended fix.** Null the crew reference instead of deleting (mirror delete_vehicle), or refuse the delete while non-DRAFT PRFs reference the crew member and offer deactivation (`is_active = False`) instead. Whatever the choice, write an AuditLog row.

<details><summary>Independent verification</summary>

Verified against the code, not refuted. providers.py:1213-1222 (delete_crew_member) executes an unconditional bulk `delete(DigitalPRF).where(crew_member_1_id == crew.id | crew_member_2_id == crew.id)` with no status filter, then deletes the crew member — evidence quoted in the claim is verbatim and present at HEAD. The sibling contrast is accurate: delete_vehicle (providers.py:1397-1405) preserves history by nulling vehicle_id. The contradicted rule is accurate: digital_prf.delete_prf (app/api/digital_prf.py:838-843) raises 409 for any non-DRAFT PRF because "Submitted / processed PRFs are billing records". Reachability confirmed: get_admin_or_crew_admin is authn-only (its post-f80df14 hardening checks blacklist/type=="access"/is_active but nothing about deletion scope) and _assert_settings_access only requires a crew principal with role=="admin" and matching provider_id, so the client's own crew-admin can invoke it; the frontend calls it from crew/ProviderAdminDashboard.tsx:501 behind a confirm that says only "Permanently delete {name}?" with no mention of PRF destruction (also from ProviderManagement.tsx:518). Orphaning confirmed: app/tasks/prf_processing.py:231-330 creates Case, Document, Claim (and ClaimLines) and then stamps prf.case_id/prf.document_id — the FKs live on the PRF row, so deleting the PRF leaves Case/Document/Claim/ClaimLine behind with no back-reference, i.e. billable claims with no source report. No DB-level guard exists: nothing references digital_prfs.id except the PRF self-FK (models/digital_prf.py:137). No audit trail: only a logger.info about the crew member; providers.py writes no AuditLog row despite app/models/audit_log.py existing, and the PRF deletion is not logged at all. Two minor corrections that do not weaken the finding: the destructive path is the explicit "Permanently delete" button, not the separate non-destructive is_active deactivate PATCH (the claim's word "deactivating" is loose); and this is not a tenant-boundary crossing — damage is confined to the admin's own provider. Still high severity for a client deployment: it silently destroys PROCESSED records inside the 7-year retention window, including PRFs authored by other crew where the deleted person was only crew member 2, and the "TEMPORARY ENABLEMENT" comment shows it was never meant to ship. Recommended fix mirrors delete_vehicle: null crew_member_1_id/crew_member_2_id (or refuse deletion when non-DRAFT PRFs reference the crew member) and prefer deactivation.

</details>

---

### Provider hard-delete wipes all PRFs but leaves the Cases and Claims, and is gated on authentication alone

- **Severity:** high · **Category:** authz · **Lens:** data-integrity
- **Location:** `backend/app/api/providers.py:753`

**Impact.** Any authenticated account, at the default PARAMEDIC role, can irreversibly delete an entire ambulance company's operational history in one request. And the deletion is wrong in both directions: it destroys the PRFs that are the legal patient records, while leaving every Case row — patient name, plaintext SA ID number, DOB, scheme membership — permanently in the database with nothing left pointing at it. A POPIA erasure request served by this endpoint would leave the patient identifiers behind.

<details><summary>Evidence</summary>

```
```python
@router.delete("/{provider_id}", status_code=204)
async def delete_provider(
    provider_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),      # no require_role, no _assert_settings_access
):
    """Hard-delete a provider and ALL related data (crew, vehicles, PRFs, logos)."""
    ...
    # 1. PRFs linked to this provider
    await db.execute(sql_delete(DigitalPRF).where(DigitalPRF.provider_id == pid))
```

No status filter on the PRF delete, and `cases`, `claims`, `claim_lines` and `documents` are never touched. Note also that `Case` has no `provider_id` column at all (app/models/case.py) — there is no way to find that provider's cases to delete them.
```

</details>

**Recommended fix.** Require SUPER_ADMIN, require a typed confirmation of the provider slug, and either refuse while non-DRAFT PRFs exist or extend the cascade to the Case/Document/Claim/ClaimLine chain. Longer term, give `cases` a `provider_id` so tenant-scoped queries and deletions are expressible at all.

<details><summary>Independent verification</summary>

Claim confirmed by direct reading. backend/app/api/providers.py:749-786 declares delete_provider with only Depends(get_db) and Depends(get_current_user); there is no require_role, no _assert_settings_access, and no in-body role check. get_current_user (app/utils/security.py:142-189) validates signature, type=="access", blacklist, user existence and is_active, and never inspects role; User.role defaults to UserRole.PARAMEDIC (app/models/user.py:56-57), so any active non-admin staff token suffices. No router-level guard exists (app/main.py:260 includes the router with no dependencies=) and no middleware in the chain performs authorization; the response cache is irrelevant for DELETE. The body deletes exactly DigitalPRF (no status filter, so SUBMITTED/COMPLETED legal records go), Vehicle, CrewMember, ServiceProvider — cases, claims, claim_lines and documents are never referenced. The delete will actually complete rather than fail on FK constraints: the only FKs into service_providers.id / crew_members.id / vehicles.id come from crew_member.py, vehicle.py and digital_prf.py, and the only FK into digital_prfs.id is the self-reference at digital_prf.py:137. The path is reachable and in use (frontend/src/pages/ProviderManagement.tsx:361) with zero backend test coverage. One wording correction that does not change the verdict: Case does have assigned_provider_id (app/models/case.py:73-75) but it is ForeignKey("users.id"), the internal handler, not service_providers.id — so the substance holds, there is no Case-to-ServiceProvider link and the only back-pointer is DigitalPRF.case_id (digital_prf.py:129-130), which this endpoint destroys, leaving orphaned Case rows with patient_name, plaintext patient_id_number, DOB and scheme membership. Not on the already-fixed or deliberate lists. Related finding worth hardening at the same time: the sibling top-level routes GET "" (485), POST "" (544), POST /{id}/logo (614), GET /{id} (641) and PATCH /{id} (673) are likewise authentication-only, and _assert_settings_access (819) constrains only CrewMember principals — any User of any role passes it unchanged.

</details>

---

### DELETE /api/cases/all destroys every patient case in the database, for any authenticated user

- **Severity:** high · **Category:** authz · **Lens:** data-integrity
- **Location:** `backend/app/api/cases.py:271`

**Impact.** One request from any logged-in account erases the entire billing history — cases, claims, claim lines, documents, RFIs — for every provider on the instance. There is no confirmation, no role check, no audit entry, and (per the memory note on backups) the only recovery is a full restore from the nightly dump.

<details><summary>Evidence</summary>

```
```python
@router.delete("/all", status_code=status.HTTP_204_NO_CONTENT)
async def delete_all_cases(
    queue: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    _current: User = Depends(get_current_user),
):
    """Hard-delete all cases, or scope bounds by the queue ..."""
```

With no `queue` parameter the selection is unfiltered (`query = select(Case.id)`), and the body deletes RFI, SchemeAuthRequest, ClaimLine, Claim, Document and Case in chunks. `DELETE /{case_id}` at line 347 has the same authn-only dependency. Unlike `delete_case`, the bulk path never nulls `digital_prfs.case_id` / `document_id` first, so once any digital PRF has been processed the whole statement dies on `digital_prfs_document_id_fkey`.
```

</details>

**Recommended fix.** Restrict to SUPER_ADMIN, require an explicit confirmation token in the body, and consider removing the bulk endpoint entirely before the client deploy — it exists for dev-data resets and has no production use.

<details><summary>Independent verification</summary>

I could not refute this — the code says exactly what the claim says, and I found no guard anywhere in the chain.

VERIFIED IN SOURCE (C:\Users\USER-PC\Desktop\New EMS AUTOMATIONS\backend\app\api\cases.py):
- Line 270-274: `@router.delete("/all", status_code=204)` with dependencies `db: AsyncSession = Depends(get_db)` and `_current: User = Depends(get_current_user)`. `get_current_user` (app\utils\security.py:142-189) is authentication-only — it validates token type=="access", checks the blacklist, and confirms the user exists and is_active. It performs NO role check. `require_role` exists at security.py:194 but is not used here.
- The router is declared bare: `router = APIRouter(prefix="/api/cases", tags=["Cases"])` (line 20) — no `dependencies=`. app\main.py:247 is a plain `app.include_router(cases_router)` — no router-level or app-level dependency. The FastAPI app object (main.py:146-156) declares no global dependencies.
- Selection is unfiltered by default: `query = select(Case.id)`, narrowed only if `queue == 'era'` or `queue == 'management'`. Any other value (or omission) falls through with no `else: raise`, so `DELETE /api/cases/all` or `?queue=anything` selects every Case row.
- No tenant scoping: `Case.assigned_provider_id` (app\models\case.py:73) is never referenced in the query, so the deletion spans all providers on the instance. This is exactly the cross-tenant-boundary case the audit prioritises.
- No audit entry: `APIAuditLog` is only written by app\services\gateway.py (outbound scheme calls); no audit/confirmation step exists on this path.
- No confirmation and no UI caller: grepping frontend\src finds only `/api/cases/` GET/count/PATCH usages — nothing calls the bulk delete. It is a leftover dev-convenience endpoint reachable by any portal user token.

FK detail also verified: `DigitalPRF.case_id` and `DigitalPRF.document_id` (app\models\digital_prf.py:129-135) are plain `ForeignKey("cases.id")` / `ForeignKey("documents.id")` with NO `ondelete` (the only `ondelete` in app\models\ is scheme_tariff_line.py:31). `delete_case` at line 347 deliberately runs `update(DigitalPRF)...values(case_id=None, document_id=None)` with a comment naming `digital_prfs_document_id_fkey`; the bulk path omits that unlink entirely, so on any instance with processed PRFs the `delete(Document)` raises a ForeignKeyViolation and the whole transaction aborts.

TWO CORRECTIONS THAT MAKE IT WORSE, NOT BETTER:
1. The FK abort is not a safety net. The physical-file loop (`os.remove` over `doc.storage_uri` / `doc.processed_uri`) runs BEFORE any DB deletion and is not transactional. So even in the run that dies on the FK constraint and rolls back, every scanned PRF/PDF on disk for every selected case is already permanently gone, while the DB rows still point at them.
2.

</details>

---

### Correcting a failed PRF poisons the provider's PRF numbering forever and produces a record with no case number

- **Severity:** high · **Category:** data-integrity · **Lens:** data-integrity
- **Location:** `backend/app/api/failed_prfs.py:274`

**Impact.** One admin correction of PRF #5 creates PRF #100005; the provider's very next call is then numbered #100006 and its case number becomes e.g. JEMS-2026-07-100006. The per-provider sequential numbering that the paper-to-digital baseline (`prf_start_number`) exists to preserve is permanently broken, and each subsequent correction adds another 100 000. Meanwhile the corrected record — the one that actually gets billed — carries `case_number = NULL` forever, so it cannot be found by the admin search (`DigitalPRF.case_number.ilike(...)`, line 146) and the PDF emailed to the receiving facility is titled with the bogus 100005 instead (`app/tasks/prf_email.py:111`: `prf.case_number or prf.prf_number`).

<details><summary>Evidence</summary>

```
```python
    corrected_prf = PRFModel(
        ...
        prf_number=original.prf_number + 100000,  # Offset to avoid collision; will be unique
        case_number=None,  # Will be assigned during processing
```

But the next PRF number is derived from the provider's own maximum:

```python
# app/api/digital_prf.py:137  _next_prf_number
    result = await db.execute(
        select(func.max(DigitalPRF.prf_number)).where(DigitalPRF.provider_id == provider.id)
    )
    provider_max = result.scalar() or 0
```

And nothing ever assigns `case_number` "during processing" — `process_prf_submission` sets only `case_id`, `document_id`, `status`, `submitted_at` (app/tasks/prf_processing.py:329-333). A repo-wide grep for `case_number=` finds exactly two writers: `create_prf` and this `None`.
```

</details>

**Recommended fix.** Allocate the corrected row a real next number via `_next_prf_number` under the provider `FOR UPDATE` lock, and generate its case number with `_generate_case_number` at creation time rather than deferring to a step that does not exist.

<details><summary>Independent verification</summary>

I read the code and the claim holds on both of its factual legs.

1) Numbering poisoning — CONFIRMED. backend/app/api/failed_prfs.py:274 sets prf_number=original.prf_number + 100000 on a brand-new row carrying the SAME provider_id (line 270). backend/app/api/digital_prf.py:121-144 _next_prf_number derives the next number as max(provider_max, baseline) + 1 where provider_max = select(func.max(DigitalPRF.prf_number)).where(DigitalPRF.provider_id == provider.id) — no status filter, no correction_of_id IS NULL filter, no exclusion of CORRECTED/correction rows. So the +100000 row permanently raises that provider's max. _generate_case_number (digital_prf.py:147-153) then bakes the inflated number into every subsequent case number (SLUG-2026-07-100006) — exactly the per-provider paper continuity that prf_start_number exists to preserve. Correcting a correction compounds it (only FAILED rows can be corrected, and a failed correction is FAILED, so 5 -> 100005 -> 200005).

2) case_number = NULL forever — CONFIRMED. Repo-wide grep for case_number= in backend/app finds exactly two writers: create_prf (digital_prf.py:299) and this None (failed_prfs.py:275). process_prf_submission (app/tasks/prf_processing.py) never touches prf.case_number — its finalise block sets only case_id, document_id, status, submitted_at, processing_error (~lines 328-334); the Case model has no case_number column at all, so nothing backfills it. I also checked for a before_insert/listens_for hook on the model and for a server_default in the alembic versions: none exist. The "# Will be assigned during processing" comment is simply false. case_number is String(50), unique=True, nullable=True, so multiple NULLs insert fine — the row survives with a permanently NULL billing identifier, and it is the corrected row that gets billed.

No guard prevents it: the endpoint's only precondition is original.status == FAILED (line 256), and the route is mounted (main.py:264). ResponseCacheMiddleware caches /api/failed-prfs GETs only; a PUT is unaffected.

Two parts of the stated impact are overstated but do not change the verdict:
- "cannot be found by the admin search": the corrected row IS findable by number. failed_prfs.py:142-147 branches on search.isdigit() and matches prf_number == int(search), and the provider PRF search (providers.py:1450-1454) ORs cast(DigitalPRF.prf_number, Text).ilike(term) with the case-number and form_data matches. Only case-number lookup (and any downstream consumer assuming a case number exists) breaks.
- Practical exposure is lower than "high" implies: no frontend calls PUT /api/failed-prfs/{id}/correct (the UI uses only /stats, the list, and /reprocess in Cases.tsx) and there is no test for it, so triggering it requires a direct authenticated API/Swagger call. Reachable,

</details>

---

### A fresh production box cannot get a schema: no migration creates any core table, and the initial revision is an empty stub

- **Severity:** high · **Category:** deploy-readiness · **Lens:** deploy-readiness
- **Location:** `backend/alembic/versions/04be48895f1c_initial_schema.py:21`

**Impact.** On a client-owned VM with an empty database, the documented deploy step `docker compose exec -T ems_backend python -m alembic upgrade head` (deploy/GO-LIVE-RUNBOOK.md:139) aborts at revision 66bd72a732f9 with `relation "cases" does not exist`. No users, digital_prfs, cases, claims, service_providers or crew_members table is ever created. Startup then also hard-fails, because lifespan calls purge_old_crashes() (main.py:74) which issues an unguarded DELETE against crash_events. The instance is unbootable, and the runbook's documented rebuild sequence (sections 1-4) never mentions alembic at all — so the deployer's only visible escape hatch is APP_ENV=development, which is the next finding.

<details><summary>Evidence</summary>

```
04be48895f1c_initial_schema.py (the root revision, down_revision = None):

    def upgrade() -> None:
        """Upgrade schema."""
        # ### commands auto generated by Alembic - please adjust! ###
        pass

The next revision, 3f98acd077f5_add_billing_guidelines_table.py, is also `pass`. Across all 29 revisions there is not one `op.create_table`:

    $ grep -hoE 'op\.(create_table|add_column|alter_column|...)' alembic/versions/*.py | sort | uniq -c
          8 op.add_column
         36 op.alter_column
          6 op.create_index
          8 op.drop_column
        138 op.execute

Only two tables exist in raw SQL anywhere (`CREATE TABLE IF NOT EXISTS rate_schemas`, `CREATE TABLE IF NOT EXISTS scheme_tariff_lines`). The third revision in the chain, 66bd72a732f9_add_scheme_adapter_fields.py:24, immediately does:

    op.alter_column('cases', 'dependant_code', existing_type=sa.VARCHAR(length=5), ...)

The only code that ever creates the 28 tables is create_tables() (Base.metadata.create_all), and main.py:58 gates it:

    if settings.APP_ENV == "development":
        await create_tables()
```

</details>

**Recommended fix.** Author a real baseline migration that creates the full current schema (autogenerate against an empty DB from the models, review by hand), verify with `alembic upgrade head` against a scratch empty Postgres in CI, and add that assertion to the test suite. Add a first-deploy section to the runbook covering: create DB -> alembic upgrade head -> bootstrap admin. Wrap purge_old_crashes() so a missing table logs rather than kills startup.

<details><summary>Independent verification</summary>

CONFIRMED — the claim is accurate in every checked particular, and I found no guard, script, or entrypoint that rescues a fresh box.

1. Root revision is an empty stub. backend/alembic/versions/04be48895f1c_initial_schema.py has down_revision = None and upgrade() body = `pass`. The next revision, 3f98acd077f5_add_billing_guidelines_table.py (down_revision '04be48895f1c'), is also `pass` despite being titled "Add billing_guidelines table".

2. No table creation across the 29 revisions. `grep -hoE 'op\.(create_table|...)' alembic/versions/*.py | sort | uniq -c` returns: 8 add_column, 36 alter_column, 6 create_index, 7 drop_index, 8 drop_column, 138 execute, 6 op.f — zero op.create_table. A case-insensitive grep for `CREATE TABLE` inside the raw-SQL op.execute bodies hits exactly two files: a3b7c9d1e5f2 (`CREATE TABLE IF NOT EXISTS rate_schemas`) and e1f2a3b4c5d6 (`CREATE TABLE IF NOT EXISTS scheme_tariff_lines`). Matches the evidence exactly.

3. The chain breaks at the third revision, unguarded. I dumped every revision/down_revision pair: the chain is strictly 04be48895f1c -> 3f98acd077f5 -> 66bd72a732f9 -> 9f16b31598f3 -> ... 66bd72a732f9_add_scheme_adapter_fields.py:23 opens with a bare `op.alter_column('cases', 'dependant_code', existing_type=sa.VARCHAR(length=5), comment=..., existing_nullable=True)` — a comment-only alter emits `COMMENT ON COLUMN cases.dependant_code`, which on Postgres raises UndefinedTable when `cases` does not exist. It is followed by more bare alters on `documents`/`users` and `op.add_column('scheme_configs', ...)`. Unlike later revisions (a9d4e2c7b1f8, b3e5d7f9a1c4, c7d9e1f3a5b8, etc., which deliberately use `ADD COLUMN IF NOT EXISTS` raw DDL), 66bd72a732f9 has no IF EXISTS / DO-block tolerance. `alembic upgrade head` on an empty DB aborts there.

4. create_all is the only real schema source and it is production-gated. app/database.py:77-80 `create_tables()` -> `Base.metadata.create_all`; app/main.py:58-60 wraps it in `if settings.APP_ENV == "development":`. Repo-wide grep finds create_all only in database.py, seed_jems.py, and tests/conftest.py — nothing on a deploy path. Several migration docstrings state the assumption outright (d4e7f2c1a8b9: "...from an earlier Base.metadata.create_all() bootstrap"; f4b9c1d7e2a8: "`digital_prfs` is created by SQLAlchemy create_all"), direct evidence the migration chain was never the schema owner.

5. A fresh box really does land in APP_ENV=production. .env.prod.template:58 and .env.prod:35 both set APP_ENV=production (only backend/.env and CI use development), so the dev escape hatch is off by default on a new instance.

6. alembic/env.py does not bootstrap. It only sets target_metadata = Base.metadata for autogenerate and runs context.run_migrations() — no create_all. Neither backend/Do

</details>

---

### SECRET_KEY and ENCRYPTION_KEY accept the shipped CHANGE_ME placeholders — no entropy or placeholder validation at boot

- **Severity:** high · **Category:** secret-config · **Lens:** deploy-readiness
- **Location:** `backend/app/config.py:52`

**Impact.** A deployer who follows the root .env.example (the file CLAUDE.md points at: "Copy `.env.example` to `.env`") boots a fully working instance whose JWT signing key is the literal string `CHANGE_ME`. Anyone can mint an access token for any user id with role SUPER_ADMIN and read or alter every patient PRF on the client instance. The failure is silent — health checks pass, logins work, nothing warns. This is worse on a second instance than on ours, because the client's deployer has no institutional memory of which template is authoritative.

<details><summary>Evidence</summary>

```
config.py declares both as required-but-unvalidated strings:

    # ── JWT Auth (SECRET_KEY MUST be set via environment — no default) ──
    SECRET_KEY: str
    ...
    # ── POPIA Encryption (MUST be set via environment — no default) ──
    ENCRYPTION_KEY: str

Three conflicting templates ship placeholder values that satisfy that type:

    .env.example:13            SECRET_KEY=CHANGE_ME
    .env.example:35            ENCRYPTION_KEY=CHANGE_ME
    backend/.env.example:38    SECRET_KEY=CHANGE_ME_GENERATE_A_SECURE_KEY
    .env.prod.template:33      SECRET_KEY=CHANGE_ME_GENERATE_A_RANDOM_64_CHAR_STRING

`grep -rn "CHANGE_ME" backend/app --include=*.py` returns no hits — nothing anywhere refuses a placeholder, checks length, or checks entropy. SECRET_KEY is used unconditionally at security.py:82/90/95 for jwt.encode/decode.
```

</details>

**Recommended fix.** Add a pydantic validator that rejects boot when SECRET_KEY is under ~32 chars, matches /CHANGE_ME|changeme|secret|password/i, or equals any known template value; do the same for ENCRYPTION_KEY (requiring a valid 44-char Fernet key). Delete or merge the redundant .env.example files so there is exactly one authoritative template, and have the runbook's first-deploy step generate both keys with a printed command.

<details><summary>Independent verification</summary>

CONFIRMED — the code says what the claim says, and no guard prevents it.

Verified directly:
1. backend/app/config.py:52 `SECRET_KEY: str` and :135 `ENCRYPTION_KEY: str` are bare required strings on a pydantic BaseSettings. Read the entire file: there is no field_validator, model_validator, min_length, or any other constraint. The Config class only sets env_file/case_sensitive/extra.
2. No boot-time validation anywhere. `grep SECRET_KEY|ENCRYPTION_KEY` over all backend/**/*.py yields only: config.py (declaration), app/utils/security.py:82/90/95 (jwt.encode/encode/decode, unconditional), app/api/crashes.py:78, tests/conftest.py:86. main.py's lifespan (lines 50-78) does setup_logging, dev-only create_tables, dev-only seeding, purge_old_crashes — no secret checks. docker-compose* contains zero references to either var (so no compose-level default or preflight). Nothing under deploy/ references either var either.
3. Templates confirmed and in fact worse than stated (four files, not three): root .env.example:13 SECRET_KEY=CHANGE_ME and :35 ENCRYPTION_KEY=CHANGE_ME; backend/.env.example:38 CHANGE_ME_GENERATE_A_SECURE_KEY and :50 CHANGE_ME_GENERATE_A_FERNET_KEY; .env.prod.template:33/41. CLAUDE.md does instruct "Copy `.env.example` to `.env`" without disambiguating which one.

Aggravating factor the claim missed: backend/app/utils/crypto.py:22-29 deliberately catches Fernet's rejection of a malformed key and derives a valid key via SHA-256 of whatever string was supplied ("a prod key that is an arbitrary string must not brick the app"). So ENCRYPTION_KEY=CHANGE_ME does not crash — it silently yields a fully functional, entirely public encryption key. The one path that could have failed loudly is explicitly neutralised.

Fairness corrections to the claim's impact wording (do not change severity):
- Role is NOT taken from the token. get_current_user (security.py:142+) validates type=="access" and the blacklist, then loads the User row from the DB by `sub` and uses the stored role. An attacker cannot assert role=SUPER_ADMIN in the payload; they must name an existing active user's UUID. Bounded caveat, not a mitigation — the signing key remains the sole authentication root, so forgery still grants full impersonation of any account whose UUID is known or leaked, plus any other token family signed with the same key.
- Current production .env.prod does contain high-entropy values for both, so the existing live instance is not currently exploitable. That is exactly why this qualifies under audit criterion (c): the safety depends entirely on institutional memory the client's deployer will not have, and the failure is silent (boot succeeds, health checks pass, logins work, nothing warns).

Recommended fix: a validator in config.py rejecting empty/placeholder (case-in

</details>

---

### ENCRYPTION_KEY silently derives a working Fernet key from any string, including the published placeholder

- **Severity:** high · **Category:** secret-config · **Lens:** deploy-readiness
- **Location:** `backend/app/utils/crypto.py:22`

**Impact.** A deployer who leaves the template placeholder in place gets encryption that appears to work end-to-end — provider SMTP app passwords encrypt and decrypt normally — under a key any reader of the repo can reproduce in one line. The template also tells them this value is load-bearing and must be backed up ("Set ONCE and NEVER change"), which makes leaving it look harmless. Worse for multi-instance: two instances that both left the placeholder share one key, so a token stolen from our instance decrypts on the client's and vice versa. The same fallback also means a typo'd or truncated key is never reported.

<details><summary>Evidence</summary>

```
backend/app/utils/crypto.py:22-29:

    @lru_cache(maxsize=1)
    def _fernet() -> Fernet:
        key = (get_settings().ENCRYPTION_KEY or "").strip()
        try:
            return Fernet(key.encode())
        except Exception:
            derived = base64.urlsafe_b64encode(hashlib.sha256(key.encode()).digest())
            return Fernet(derived)

The module docstring states the intent plainly: "If the configured key isn't a valid Fernet key we derive one deterministically from it (SHA-256 -> urlsafe base64)". Combined with .env.prod.template:41 `ENCRYPTION_KEY=CHANGE_ME_GENERATE_A_FERNET_KEY`, the derived key is SHA-256 of a string that is published in the repository.
```

</details>

**Recommended fix.** Keep the fallback only for reading legacy data, and refuse to boot on a key that is not a valid Fernet key or that matches a known placeholder. Log which path was taken at INFO. Ship a `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` line in the template.

<details><summary>Independent verification</summary>

The claim survives adversarial review; the code says exactly what is alleged and no guard prevents it.

VERIFIED VERBATIM: backend/app/utils/crypto.py:22-29 is exactly as quoted. A bare `except Exception` around `Fernet(key.encode())` catches any invalid key and substitutes `base64.urlsafe_b64encode(hashlib.sha256(key.encode()).digest())`. The module docstring (lines 5-9) confirms the behaviour is intentional-by-design, not an accident.

DEMONSTRATED, NOT ASSERTED: I executed the derivation. `CHANGE_ME_GENERATE_A_FERNET_KEY` (.env.prod.template:41) is rejected by Fernet and derives the working key `WKKCo4lXdESeKfVd4SZFw-yRQWZE_yWD24FYSgel-o0=`, with a clean encrypt/decrypt round trip. `.env.example:35` (`CHANGE_ME`) behaves the same. Both source strings are published in the repo, so the derived key is reproducible by any reader in one line.

NO GUARD ON THE PATH (checked all the usual mitigation sites):
- app/config.py:135 is a bare `ENCRYPTION_KEY: str` with no default and NO validator. Grep for validator/CHANGE_ME/preflight in config.py returns no matches.
- app/main.py lifespan never references ENCRYPTION_KEY or crypto — no startup assertion.
- No deploy script generates or validates the key. deploy/GO-LIVE-RUNBOOK.md never mentions ENCRYPTION_KEY or Fernet. Only infra/DEPLOY-AZURE.md:276 documents a manual generation command in prose (process, not enforcement).
- No tests exercise crypto.py.

PATH IS REACHABLE AND LIVE: app/api/providers.py:326 calls encrypt_str on the provider SMTP app password; app/tasks/prf_email.py:95 calls decrypt_str. The PRF facility auto-email feature is in production.

NOT ON THE EXCLUSION LISTS: the deliberate item about encryption concerns patient ID columns being unencrypted (String(13)) — a different issue. Nothing on the already-fixed or deliberate lists covers the crypto fallback.

TWO CORRECTIONS THAT AFFECT THE FIX:
1. The defect is BROADER than claimed: an empty `ENCRYPTION_KEY=` also passes. Pydantic accepts an empty str, `.strip()` yields "", and the fallback derives SHA-256 of the empty string — a universal constant. So the failure mode is not limited to the published placeholder.
2. FIX CAVEAT: .github/workflows/ci.yml:100 sets ENCRYPTION_KEY="test-encrypt-key-32chars0000000", which is NOT a valid Fernet key. CI currently depends on this fallback. Hard-failing on invalid keys will break the first-ever-green CI unless that value is replaced with a real generated key in the same commit.

ACCURACY OF THE CLAIM'S IMPACT: correctly scoped. Only provider SMTP app passwords are encrypted (confirmed: encrypt_str/decrypt_str have exactly two call sites), and the claim says so rather than inflating it to patient data. Separately worth fixing: the .env.prod.template comment above line 41 says "patient ID numbers are en

</details>

---

### nginx.conf is version-controlled with our domain and cert path hardcoded, and the documented deploy reverts any local fix

- **Severity:** high · **Category:** deploy-readiness · **Lens:** deploy-readiness
- **Location:** `nginx/nginx.conf:48`

**Impact.** On a client VM, certbot issues a cert for the client's domain, so /etc/letsencrypt/live/portal.emsmca.co.za/ never exists and nginx exits at config load — the site is down and the failure mode (`cannot load certificate ... No such file or directory`) looks like a TLS problem, not a config-templating problem. The deployer's only fix is to edit a tracked file, which the very next `git reset --hard origin/main` silently reverts, taking the client's site down again on a routine deploy. The port-80 block's `server_name portal.emsmca.co.za 172.209.218.22 _;` also bakes our production IP into the client's config.

<details><summary>Evidence</summary>

```
nginx/nginx.conf:47-51:

    listen 443 ssl http2;
    server_name portal.emsmca.co.za;

    ssl_certificate     /etc/letsencrypt/live/portal.emsmca.co.za/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/portal.emsmca.co.za/privkey.pem;

docker-compose.prod.yml:109 mounts that exact file read-only into the container:

    - ./nginx/nginx.conf:/etc/nginx/conf.d/default.conf:ro

And the documented deploy procedure (deploy/GO-LIVE-RUNBOOK.md:132) is:

    sudo git fetch origin main && sudo git reset --hard origin/main
```

</details>

**Recommended fix.** Template the server_name and cert paths from an env var (envsubst at container start, or a small entrypoint that renders conf.d/default.conf from ${PORTAL_DOMAIN}), and stop mounting a tracked file as live config. Add "nginx.conf domain + cert path" to the per-instance regeneration checklist.

<details><summary>Independent verification</summary>

Claim confirmed at every cited location. nginx/nginx.conf:46-129 contains an ACTIVE (not commented) 443 server block with server_name portal.emsmca.co.za (line 48) and ssl_certificate/ssl_certificate_key pointing at /etc/letsencrypt/live/portal.emsmca.co.za/ (lines 50-51). The file is git-tracked (git ls-files lists it; git check-ignore exits 1; .gitignore:54 only covers nginx/ssl/). docker-compose.prod.yml:109 mounts it read-only at /etc/nginx/conf.d/default.conf exactly as quoted, overriding the frontend image's baked-in config. deploy/GO-LIVE-RUNBOOK.md:132 is verbatim "sudo git fetch origin main && sudo git reset --hard origin/main" under "Manual deploy procedure ... repeat whenever deploying by hand", and .github/workflows/deploy.yml:82 does the same, so both deploy paths revert any local edit; the next line (133) rebuilds with --force-recreate, so the revert takes effect during that deploy.

Refutation attempts all failed: (1) No templating mechanism exists anywhere - repo-wide grep for envsubst, *.template, ${DOMAIN}, /etc/nginx/templates returns nothing; the nginx image's envsubst path is bypassed because the mount targets conf.d/ directly, not templates/. No per-tenant override, no docker-compose.override.yml, mount source not parameterised. (2) The port-80 block is in the SAME file, so a missing ssl_certificate fails nginx config parse and the container never starts - the outage is total, not HTTPS-only. (3) No alternative live config: the runbook itself states "The live config is nginx/nginx.conf from the repo". infra/DEPLOY-AZURE.md:372,420 references infra/nginx/prod.conf, which does not exist in the repo (infra/nginx/ holds only api.conf) and itself hardcodes a different domain (app.jems.co.za) - reinforcing, not refuting. (4) The runbook header explicitly designates sections 1-4 as the from-scratch rebuild procedure, i.e. exactly what a new client VM would follow, and its certbot step issues -d portal.emsmca.co.za.

Additional supporting finding not in the claim: deploy/ops/nginx-cert-reload.sh:33 also hardcodes DOMAIN="portal.emsmca.co.za", so the cert-renewal cron installed by install-ops-crons.sh (which the runbook says to re-run after every deploy) would monitor the wrong host on a client VM.

Two minor framing corrections that do not affect the verdict: the port-80 block's server_name includes the "_" catch-all, so the baked-in production IP there is a hygiene/info-leak wart rather than a functional break; and server_name on line 48 alone would not break TLS (it is the only 443 server, hence default) - the fatal element is solely the cert paths on lines 50-51, one line below the claim's file anchor.

</details>

---

### POST /api/invoices/{invoice_id}/submit requires no authentication and mutates claim state

- **Severity:** high · **Category:** authz · **Lens:** deploy-readiness
- **Location:** `backend/app/main.py:577`

**Impact.** An anonymous caller who learns or is given a claim UUID can force that claim to SUBMITTED and push the patient's name, scheme member number and preauth number to the configured payer endpoint, bypassing every adjudication and authorisation gate. It is also cross-tenant by construction: the query is `select(Claim).where(Claim.id == ...)` with no provider filter. Separately, a non-UUID invoice_id makes `_uuid.UUID(invoice_id)` raise, which the global handler turns into a 500 plus a persisted crash_events row — an unauthenticated DB-write amplifier at 300 req/min per IP.

<details><summary>Evidence</summary>

```
backend/app/main.py:577-582 — the dependency list contains only a DB session:

    @app.post("/api/invoices/{invoice_id}/submit", tags=["Invoices"], status_code=202)
    async def submit_invoice(
        invoice_id: str,
        background_tasks: BackgroundTasks,
        db: AsyncSession = Depends(get_db),
    ):

Compare the sibling endpoint two functions earlier, main.py:445, which was explicitly hardened:

    async def get_stats(_user: User = Depends(get_current_user)):

The background task it schedules writes to the claim (main.py:563-568):

    claim.adjudication_status = AdjudicationStatus.SUBMITTED
    claim.submitted_at = _dt.now(_tz.utc)
    if payer_type == "AGGREGATOR" and result.reference:
        claim.dispatch_reference_number = result.reference

and the payload it hands to route_invoice() carries patient identifiers (main.py:643-646):

    "patient_name": case.patient_name,
    "scheme_member_number": case.scheme_member_number,
    "preauth_number": case.preauth_number,

nginx proxies the whole /api/ prefix (nginx/nginx.conf:60), and there is no provider/tenant scoping on the claim lookup — any claim id in the database is accepted.
```

</details>

**Recommended fix.** Add `_user: User = Depends(get_current_user)` (or the provider-scoped guard used elsewhere) plus the same tenant check the provider endpoints use, and validate invoice_id as a UUID path param (`invoice_id: uuid.UUID`) so malformed input returns 422 instead of a 500 and a crash row.

<details><summary>Independent verification</summary>

CONFIRMED — the core defect is real, though two parts of the stated impact are overstated and should be corrected.

VERIFIED VERBATIM: backend/app/main.py:577-582 matches the quoted evidence exactly. The dependency list is only invoice_id: str, background_tasks: BackgroundTasks, db: AsyncSession = Depends(get_db). No auth dependency.

NO SHARED GUARD EXISTS (checked before concluding, per instructions):
- FastAPI(...) at main.py:146-156 has no dependencies=[...]. Grepped `dependencies=` across the whole file: zero hits.
- Full middleware list is main.py:182/193/203/211/214/219 — CORS, GZip, RateLimit, XSSProtection, CrashHandler, ResponseCache. Read rate_limit.py and crash_handler.py; neither authenticates. TrustedHostMiddleware is imported at line 11 but never added.
- Route is registered at module level on `app`; grep across app/api/ + main.py shows this is the ONLY /api/invoices route in the backend, so no router shadows it.
- nginx `location /api/` proxies it; the `deny all` blocks cover only /docs and /openapi.json.

MUTATION + TENANT GAP CONFIRMED: _execute_invoice_routing (main.py:558-568) opens its own session and sets adjudication_status = SUBMITTED, submitted_at, and dispatch_reference_number. Both lookups — select(Claim).where(Claim.id == ...) at 596-598 and select(Case).where(Case.id == claim.case_id) at 605-607 — carry no provider filter, while Case DOES have assigned_provider_id (app/models/case.py:73). So tenant scoping exists as a concept in the schema and is simply not applied here. The contrast drawn with the hardened get_stats at main.py:445 is accurate, including its explanatory comment.

CRASH-WRITE AMPLIFIER CONFIRMED: _uuid.UUID(invoice_id) at line 597 raises ValueError on non-UUID input; global_exception_handler (main.py:226-240) calls record_crash_event, which unconditionally INSERTs a crash_events row (crash_handler.py:87-101). Unauthenticated, one DB row per request.

TWO OVERSTATEMENTS THAT DO NOT REFUTE THE FINDING BUT MUST BE CORRECTED:
1. "push patient name / scheme member number / preauth number to the configured payer endpoint" is FALSE TODAY. I read app/services/submission_strategies.py end to end. Both strategies are explicitly labelled "# ── MOCK:". EDISwitchStrategy builds an XML string; B2BAggregatorStrategy builds a text string. There is no HTTP client, no PDF generation, and no configured payer endpoint anywhere in the module. The patient_name / scheme_member_number / preauth_number keys in invoice_data are never read by either strategy — they appear in neither payload_preview nor any log line. There is therefore NO patient-data egress at present. The exposure is latent: it materialises the day the mocks are replaced with real dispatch, which is exactly why shipping the route unauthenticated is wrong.
2. "bypas

</details>

---

### POST /api/invoices/{invoice_id}/submit has no authentication dependency at all

- **Severity:** high · **Category:** authz · **Lens:** availability
- **Location:** `backend/app/main.py:577`

**Impact.** Anyone who can reach the API (the whole internet — nginx proxies /api/ unconditionally) can POST a claim UUID and cause the platform to transmit a named patient's scheme membership number to a third-party payer, and to mark the claim SUBMITTED so it never appears in the billing queue again. Claim UUIDs leak into the frontend, PDFs and URLs. It is also an unauthenticated amplifier: each call spends a BackgroundTask and an outbound HTTP call. On the client's VM this is a POPIA-reportable disclosure path that requires no credential.

<details><summary>Evidence</summary>

```
@app.post("/api/invoices/{invoice_id}/submit", tags=["Invoices"], status_code=202)
async def submit_invoice(
    invoice_id: str,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):

Every other write route in the app carries `Depends(get_current_user)` or `Depends(get_current_crew)`. This one carries neither. It loads the Claim + Case, builds a payload containing `"patient_name": case.patient_name, "scheme_member_number": case.scheme_member_number, "preauth_number": case.preauth_number` and hands it to `background_tasks.add_task(_execute_invoice_routing, ...)`, which calls `route_invoice(invoice_data, payer_type)` — a real outbound submission to the scheme/aggregator — and then flips `claim.adjudication_status = AdjudicationStatus.SUBMITTED`.
```

</details>

**Recommended fix.** Add `_current: User = Depends(get_current_user)` (plus a role check consistent with the rest of the billing routes) and validate `invoice_id` as a UUID before the query. Also move the routing off `BackgroundTasks` onto Celery — a BackgroundTask is lost on container restart, so a submission can silently vanish.

<details><summary>Independent verification</summary>

CONFIRMED — the route is genuinely unauthenticated, though the claimed impact is partly overstated.

VERIFIED (code read directly):
- `C:/Users/USER-PC/Desktop/New EMS AUTOMATIONS/backend/app/main.py:577-582` — `@app.post("/api/invoices/{invoice_id}/submit", ...)` with signature `(invoice_id: str, background_tasks: BackgroundTasks, db: AsyncSession = Depends(get_db))`. No `get_current_user`, no `get_current_crew`, no `require_role`. `get_db` is a session factory only, it performs no authn/authz.
- No app-level guard exists: `app = FastAPI(...)` (main.py:146-156) is constructed WITHOUT `dependencies=[...]`, and every `app.include_router(...)` (main.py:245-266) is called without a `dependencies=` argument.
- Middleware chain does not authenticate. `app/middleware/` contains only `crash_handler.py`, `logging_config.py`, `rate_limit.py`, `sanitization.py` plus `app/core/response_cache.py` — none inspects `Authorization` for authorization purposes (the only `Authorization` hit in middleware is the rate limiter's comment about not exempting login paths; ResponseCache only keys on the header). Rate limiting (300 API/min per client IP) throttles but does not block.
- Reachable: `deploy/nginx/nginx.conf:61` proxies `location /api/` unconditionally. It is the only `/api/invoices` route in the codebase (grep over `app/`), so nothing shadows it. No test exercises it (`tests/` has zero `invoices` hits), and the frontend never calls it (zero hits in `frontend/src/`), so it is a purely server-side, internet-exposed surface with no client that would have exercised auth.
- The 422 "no pricing module" branch is NOT an effective gate: `app/rules/__init__.py` registers gems, discovery, er24, netcare, and when `case.medical_scheme_name` is empty the check is skipped entirely and `payer_type` defaults to "SCHEME", so execution proceeds.
- Real impact confirmed: `_execute_invoice_routing` (main.py:536-574) opens its own `AsyncSessionLocal()` and writes `claim.adjudication_status = AdjudicationStatus.SUBMITTED`, `claim.submitted_at`, and `claim.dispatch_reference_number`, then commits. That is an unauthenticated write to the billing record. `AdjudicationStatus.SUBMITTED` feeds `app/services/analytics.py:126,197`, so falsely-submitted claims silently pollute submission counts — a claim can be marked "submitted" having never been sent, i.e. revenue loss plus audit falsification, and it is trivially repeatable per claim UUID.

WHERE THE CLAIM OVERSTATES (should be corrected in the writeup, but does not refute it):
- "a real outbound submission to the scheme/aggregator" and "transmit a named patient's scheme membership number to a third party" is FALSE. `app/services/submission_strategies.py` is entirely mocked: `EDISwitchStrategy.execute` and `B2BAggregatorStrategy.execute` bu

</details>

---

### DELETE /api/cases/all wipes every case, claim, document and file for any authenticated user of any role

- **Severity:** high · **Category:** authz · **Lens:** availability
- **Location:** `backend/app/api/cases.py:270`

**Impact.** A plain USER-role account — the role given to billing clerks — can destroy the entire claims database and the physical files behind it with one request, with no confirmation and no soft-delete. Combined with the 7-year HPCSA/POPIA retention obligation this is unrecoverable outside a restore. On a client VM run by someone else, a single compromised or disgruntled clerk account ends the business.

<details><summary>Evidence</summary>

```
@router.delete("/all", status_code=status.HTTP_204_NO_CONTENT)
async def delete_all_cases(
    queue: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    _current: User = Depends(get_current_user),
):
    """Hard-delete all cases, or scope bounds by the queue..."""

`get_current_user` (app/utils/security.py:142) is authentication-only — it validates token type, blacklist and `user.is_active`, and returns the User. It never inspects `user.role`. The body then does `os.remove(full_path)` on every stored document and `delete(RFI) / delete(SchemeAuthRequest) / delete(ClaimLine) / delete(Claim) / delete(Document)` in 500-row chunks across the entire table.
```

</details>

**Recommended fix.** Gate behind `require_role(SUPER_ADMIN)` (passing both ADMIN and SUPER_ADMIN per the house convention), require an explicit confirmation token in the body, and write an AuditLog row before deleting. Consider removing the unscoped `/all` variant entirely for production builds.

<details><summary>Independent verification</summary>

Verified directly in source, not asserted.

ROUTE: backend/app/api/cases.py:270 `@router.delete("/all", status_code=204)` with deps `db: Depends(get_db)` and `_current: User = Depends(get_current_user)` only. No `require_role` appears anywhere in cases.py (all 7 endpoints use bare get_current_user).

GUARD IS AUTHN-ONLY: app/utils/security.py:142-190 get_current_user validates signature, `payload["type"] == "access"`, jti blacklist, user exists and is_active, then returns the User. It never inspects `user.role`. require_role is defined at line 194 and is simply not used by this router.

NO COMPENSATING LAYER: app/main.py:247 `app.include_router(cases_router)` passes no `dependencies=`; the `FastAPI(...)` constructor at line 146 declares no global dependency. The middleware chain (app/middleware/: crash_handler, logging_config, rate_limit, sanitization) has zero role/permission logic — grep for "permission|role" over app/middleware/ returns nothing. ResponseCacheMiddleware is irrelevant (a cache HIT would only skip work on a cached GET, not on this DELETE). RateLimit is 300 API/min, so a single request is unimpeded. Nothing in deploy/ restricts the DELETE method at nginx.

REACHABLE: `/all` is registered at line 270, before `/{case_id}` at line 348, so FastAPI matches the literal path. `queue` is Optional and defaults to None, in which case the selector is an unfiltered `select(Case.id)` — the entire table, all providers, no tenant scoping at all.

BODY DOES WHAT IS CLAIMED: for every selected case it loads Documents and calls `os.remove(get_full_path(uri))` on `storage_uri` and `processed_uri`, then issues `delete(RFI)/delete(SchemeAuthRequest)/delete(ClaimLine)/delete(Claim)/delete(Document)/delete(Case)` in 500-row chunks, single `await db.commit()`. No soft-delete, no confirmation token, no audit write.

ONE CORRECTION TO THE CLAIM (does not refute it): there is no "USER" role. app/models/user.py:37-42 defines SUPER_ADMIN, ADMIN, DISPATCHER, PARAMEDIC, BILLING_CLERK, and the `role` column default is UserRole.PARAMEDIC (line 57). So the mislabeled role makes the finding stronger, not weaker: the default role assigned to a new account, plus the literal BILLING_CLERK role the claim describes, both pass this endpoint.

ONE NUANCE THAT DOES NOT MITIGATE: unlike delete_case (line 348), which explicitly nulls DigitalPRF.case_id/document_id before deleting Documents, delete_all_cases never severs digital_prfs links and never deletes EDISubmission or ERAEvent, both of which hold non-nullable FKs to claims.id (app/models/edi_submission.py, app/models/era.py). None of these FKs declare ondelete, so on a database containing such rows the DB portion raises a ForeignKeyViolation and the whole transaction rolls back. However, the os.remove() loop runs BEFORE any

</details>

---

### /api/metrics and /health are unauthenticated and make blocking Celery/Kombu calls on the event loop; /health is exempt from rate limiting

- **Severity:** high · **Category:** availability · **Lens:** availability
- **Location:** `backend/app/api/metrics.py:17`

**Impact.** `control.inspect().active()` is a synchronous kombu broadcast; awaiting nothing, it parks the uvicorn event loop for up to 3 seconds per call — for every user, not just the caller. /health additionally does a blocking `ensure_connection` (another 3s when RabbitMQ is unresponsive) and is rate-limited by neither nginx nor the middleware, so a trivial unauthenticated loop against /health pins the API to zero throughput. /api/metrics also leaks PRF volumes and failure counts (`ems_prf_total`, `ems_failed_prfs_total`) to anonymous callers, which /api/stats was deliberately closed to.

<details><summary>Evidence</summary>

```
@router.get("/api/metrics")
async def prometheus_metrics(db: AsyncSession = Depends(get_db)):
    """Prometheus-compatible metrics scrape endpoint (no auth)."""
...
        inspector = _celery.control.inspect(timeout=3)
        active = inspector.active()          # synchronous broadcast + 3s wait, inside async def

The same pattern in main.py:346 and 357 (`/health`):
        conn = _celery.connection()
        conn.ensure_connection(max_retries=1, timeout=3)   # blocking kombu socket connect
        ...
        inspector = _celery.control.inspect(timeout=3)
        active = inspector.active()

and the limiter explicitly skips it — app/middleware/rate_limit.py:105:
        if path in ("/", "/health", "/docs", "/openapi.json") or path.startswith("/static"):
            return await call_next(request)
infra/nginx/api.conf:220 agrees: "Location: /health → Backend health endpoint (no rate limit)".
```

</details>

**Recommended fix.** Wrap both `inspect()` and `ensure_connection()` in `asyncio.to_thread(...)`, or cache the broker/worker section for 15-30s. Put /api/metrics behind a scrape token or restrict it in nginx to the monitoring source, and give /health a cheap liveness path (DB ping only) so the deep checks are not reachable anonymously.

<details><summary>Independent verification</summary>

Every element of the claim is confirmed in the code, and no guard/middleware/dependency prevents it.

UNAUTHENTICATED: backend/app/api/metrics.py:17-18 declares `async def prometheus_metrics(db: AsyncSession = Depends(get_db))` — the only dependency is the DB session. The router is registered bare (`app.include_router(metrics_router)`, main.py:265) with no router-level `dependencies=[...]`, and main.py adds only middleware (lines 182-219), no app-level auth dependency. By contrast /api/stats at main.py:445 is `Depends(get_current_user)`, so the claim's "leaks what /api/stats was deliberately closed to" is accurate (ems_prf_total by status, ems_failed_prfs_total, DB pool, queue depth — per-tenant volume/failure counts, though aggregate, not patient records).

BLOCKING CALLS ON THE EVENT LOOP: confirmed verbatim in three places inside `async def` with no run_in_executor/to_thread: metrics.py:73-74 (`inspect(timeout=3)` / `.active()`), main.py:346-347 (`conn.ensure_connection(max_retries=1, timeout=3)` — blocking kombu socket connect), main.py:357-358 (same inspect/.active()). `inspect.active()` is a synchronous kombu broadcast with reply=True and no limit/destination, so it drains for the full 3s even on the healthy path, not only when the broker is down.

RATE-LIMIT EXEMPTION: middleware/rate_limit.py:105 returns call_next before any limiting for path in ("/", "/health", "/docs", "/openapi.json"). The actually-deployed prod config nginx/nginx.conf:90-92 has `location /health { proxy_pass http://ems_api; }` with no limit_req (infra/nginx/api.conf:220-225 agrees). /api/metrics IS limited (middleware api_limit=300/min at main.py:206; nginx location /api/ limit_req 10r/s burst 20) — the claim states this correctly and does not over-reach; the DoS vector is /health, not /api/metrics.

NO MITIGATION FROM THE RESPONSE CACHE: /api/metrics is explicitly listed in NEVER_CACHE (core/response_cache.py:39) and /health matches no CACHE_RULES prefix, so the pre-route cache HIT path cannot absorb either — every request reaches the handler.

IMPACT: an unauthenticated loop on GET /health parks each uvicorn worker's event loop >=3s per request (up to ~6s if RabbitMQ is unresponsive), unthrottled by nginx and by the middleware; with `--workers 2` a few concurrent requests drive API throughput to zero for all users. Additional corroboration: docker-compose.yml:93-97 runs the container HEALTHCHECK against /health every 10s with a 5s timeout against a handler that structurally takes >=3s, which plausibly explains the known "false unhealthy" flags.

Not on the already-fixed or deliberate lists; path is externally reachable in the shipped prod nginx. Relevant for the new client VM: insecure/fragile by default on a fresh deployment. Fix direction: offload the Celery/kombu cal

</details>

---

## MEDIUM (25)

### Tariff and rate-schema pricing is fully mutable by any authenticated user

- **Severity:** medium · **Category:** data-integrity · **Lens:** authz
- **Location:** `backend/app/api/tariff_lines.py:139`

**Impact.** Any account can rewrite or delete the rates every claim is priced against, silently changing what the platform bills medical schemes for every subsequent case, and there is no role trail on who did it. The `rule_builder`/`tariff_billing` permissions that are supposed to gate this exist only in the frontend.

<details><summary>Evidence</summary>

```
@router.post("", status_code=201)
async def create_tariff_line(
    body: TariffLineCreate,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):

Same for PUT /{line_id} (188), DELETE /{line_id} (232), POST /duplicate/{source}/{target} (254), and every rate_schemas.py mutation: POST "" (170), PUT /{schema_id} (213), DELETE /{schema_id} (248). `grep -n "UserRole" app/api/tariff_lines.py app/api/rate_schemas.py` returns nothing — no role check in either module.
```

</details>

**Recommended fix.** Guard all mutating rate-schema and tariff-line routes with require_role(ADMIN, SUPER_ADMIN) plus the rule_builder permission once server-side permission checks exist; keep the GETs on get_current_user.

<details><summary>Independent verification</summary>

Verified in source, not asserted. backend/app/api/tariff_lines.py POST "" (139), PUT /{line_id} (188), DELETE /{line_id} (232), POST /duplicate/{source}/{target} (254) and backend/app/api/rate_schemas.py POST "" (170), PUT /{schema_id} (213), DELETE /{schema_id} (248) all declare exactly one auth dependency: `_user=Depends(get_current_user)`. No guard exists upstream: main.py includes both routers (lines 263, 266) with no `dependencies=` argument, FastAPI() at main.py:146 has no global dependencies, and the middleware chain (CORS/GZip/RateLimit/XSS/CrashHandler/ResponseCache) does no authorization. app/utils/security.py:142 get_current_user only checks token type=="access", blacklist, and user is_active — it returns any User regardless of role; require_role (security.py:194) is imported by only account_security.py, claims.py, users.py and deps.py, never by either tariff module.

The claim's final sentence is also correct: `tariff_billing` and `rule_builder` are entries in ALL_PERMISSIONS (app/models/user.py:13-34), settable via users.py, but there is no require_permission/has_permission helper anywhere in app/utils or app/api — the permissions column is never read for enforcement on any route. Frontend-only gating.

Privilege floor is actually lower than the claim assumes: UserRole = SUPER_ADMIN, ADMIN, DISPATCHER, PARAMEDIC, BILLING_CLERK with column default PARAMEDIC (user.py:56-58), so an ordinary dispatcher/paramedic account can rewrite or delete the rate schemas and tariff lines that services/tariff_engine.py:149-155 and its SchemeTariffLine adapter (:1006) read for pricing. No attribution: `_user` is bound but never referenced in any of the seven handlers, and the logger.info calls record only the code/schema, never the actor.

Two fair qualifications that do not refute it: (1) crew tokens cannot reach these routes — crew_auth.py:168 mints sub = crew.id (a CrewMember UUID), so get_current_user's select(User) lookup misses and 401s; exposure is portal users only. (2) TARIFF_ENGINE_ENABLED defaults to False (app/config.py:90), so mispriced rates would not currently reach a scheme — but that is a config kill-switch, not an access control, and a fresh client VM is exactly where it may be flipped true. The claim's "changes what the platform bills for every subsequent case" therefore overstates present-day effect, while the unauthorized mutation and missing audit trail are real as written. Medium severity is appropriate for a fresh-deployment-insecure-by-default finding.

</details>

---

### The mock scheme authorisation server is mounted unconditionally in production and needs no auth

- **Severity:** medium · **Category:** deploy-readiness · **Lens:** authz
- **Location:** `backend/app/api/mock_scheme.py:15`

**Impact.** A production instance publicly serves an endpoint that mints OAuth tokens and rubber-stamps EMS authorisations. Anyone probing the client's portal finds /api/mock-scheme/authorizations/ems/request returning APPROVED with a plausible AUTH-###### number — trivially mistaken for, or deliberately passed off as, a real scheme decision. It also advertises exactly which fields the real integration validates.

<details><summary>Evidence</summary>

```
router = APIRouter(prefix="/api/mock-scheme", tags=["Mock Scheme API"])

@router.post("/oauth/token")
async def mock_oauth_token(request: Request):
    """Simulates OAuth2 client_credentials grant. Always returns a valid token for testing."""

and @router.post("/authorizations/ems/request") (line 31) which returns `"status": "APPROVED"` with a generated authorization_number and financial_limit. main.py:254 `app.include_router(mock_scheme_router)` is not wrapped in any DEBUG/ENVIRONMENT check, and nginx proxies all of /api/ (nginx.conf:61).
```

</details>

**Recommended fix.** Wrap the include_router in `if settings.ENVIRONMENT == "development"` (the same gate already used for /docs and seeding), so a fresh client deployment never exposes it.

<details><summary>Independent verification</summary>

Claim confirmed by direct code reading. backend/app/api/mock_scheme.py imports only APIRouter/Request/JSONResponse — no Depends, no auth dependency, no env gate anywhere in the module (router declared at line 12, not 15 as cited; minor line-number slip only). POST /api/mock-scheme/oauth/token returns a mock bearer token to any caller; POST /api/mock-scheme/authorizations/ems/request returns 201 with status APPROVED, AUTH-###### and a financial_limit for any body containing three attacker-supplied strings. main.py:32 imports and main.py:254 mounts it in the flat unconditional router list — notably, the same file DOES gate other things on environment (create_tables at :58, seeding at :66, docs_url/redoc_url at :154-155), so the absence of a gate here is a genuine omission, not a pattern I misread. FastAPI(...) at main.py:146 declares no global dependencies. Middleware chain (ErrorLogging, CORS, RateLimit 300/min, XSSProtection, CrashHandler, ResponseCache) contains no authentication, so nothing upstream blocks it. nginx proxies /api/ wholesale with no deny rule in all three configs: nginx/nginx.conf:61, infra/nginx/api.conf:137, frontend/nginx.conf:26. Not on the already-fixed or deliberate list. Tempering the claimed impact fairly: the route touches no DB and no patient data, so there is no data leak or tenant crossing; and the app cannot be tricked into recording a fabricated approval by default, because gateway.py:52-68 fails closed with a 503 audit entry when no SCHEME_<ID>_* env vars are set, and I found zero references to the mock URL in any .env*, compose file, deploy script, or frontend source. The 'advertises which fields the real integration validates' sub-claim is partly blunted since docs_url/openapi are None outside development — but the endpoint's own 422 response body returns an explicit missing_fields list, so field enumeration survives independently. Real residual risk on a client VM: an unauthenticated public endpoint that mints OAuth tokens and returns plausible APPROVED scheme decisions, which is exactly category (c) — insecure by default on a fresh deployment. Medium severity is fair, leaning slightly generous. One-line fix: wrap main.py:254 in the APP_ENV == 'development' check already used three times in that file.

</details>

---

### /api/metrics is unauthenticated and publicly proxied, exposing per-instance operational volumes

- **Severity:** medium · **Category:** authz · **Lens:** authz
- **Location:** `backend/app/api/metrics.py:17`

**Impact.** On a client-run VM this hands any internet caller the client's live call volume, backlog and failure rate — commercially sensitive on its own — plus a free readout of when workers are down or the queue is saturated, which is useful timing information for anyone looking to attack the instance. It is also an unauthenticated DB-query endpoint, so it is a cheap amplification target against the connection pool.

<details><summary>Evidence</summary>

```
@router.get("/api/metrics")
async def prometheus_metrics(db: AsyncSession = Depends(get_db)):
    """Prometheus-compatible metrics scrape endpoint (no auth)."""

It reports PRF counts by status, failed-PRF gauge, DB pool size/checkedout, RabbitMQ queue depth and consumer count, and active Celery worker count. nginx.conf has deny blocks for /docs and /openapi.json but none for /api/metrics, and the /api/ location proxies it straight through.
```

</details>

**Recommended fix.** Either require a scrape credential/require_role, or add `location = /api/metrics { allow 127.0.0.1; allow <monitoring subnet>; deny all; }` to the nginx config that ships with the deployment so it is closed by default on every new instance.

<details><summary>Independent verification</summary>

Verified directly in code; the claim is accurate.

ENDPOINT: backend/app/api/metrics.py:17-18 defines `@router.get("/api/metrics")` with `db: AsyncSession = Depends(get_db)` and NO auth dependency. The docstring states "(no auth)". It emits ems_prf_total by status (raw `digital_prfs` GROUP BY, no tenant filter), ems_failed_prfs_total, ems_db_pool_size/checkedout, ems_queue_depth/consumers via the RabbitMQ management API, and ems_celery_active_workers.

REGISTRATION: main.py:43 imports it; main.py:265 calls app.include_router(metrics_router) with no `dependencies=[...]` and no prefix, so the live path is exactly /api/metrics.

MIDDLEWARE CHAIN CHECKED (per the instruction to check shared guards before concluding): middleware/ contains only crash_handler.py, rate_limit.py, sanitization.py, logging_config.py — none authenticates. The only path logic is rate_limit.py:105 (skip list: /, /health, /docs, /openapi.json, /static*) and the loopback-peer bypass at line 119. So /api/metrics is rate-limited at the 300/min API tier but never authenticated. No global dependency on the app object.

NGINX: production config is nginx/nginx.conf, confirmed mounted at docker-compose.prod.yml:109 as /etc/nginx/conf.d/default.conf:ro. It contains `location /docs { deny all; }` and `location /openapi.json { deny all; }` but no deny/allow-list/auth_basic for /api/metrics; the `location /api/ { limit_req ...; proxy_pass http://ems_api; }` block proxies it straight through. frontend/nginx.conf (dev image) also proxies all /api/ unrestricted. Evidence in the claim is demonstrated, not asserted.

NOT on the already-fixed or deliberate list. Path is reachable and registered.

FAIRNESS ADJUSTMENTS (do not refute, but calibrate):
- Amplification is bounded by nginx (10r/s, burst 20) and the app limiter (300/min per IP), so it is not unbounded. However the per-request cost is HIGHER than the claim states: each call also makes an httpx GET with a 5s timeout to the RabbitMQ management API and a celery.control.inspect(timeout=3) broadcast, so one unauthenticated request can occupy a worker for seconds while touching DB + broker HTTP API + Celery control plane.
- No PHI/patient data is exposed — aggregate counts only. "medium" severity is appropriate, not high.

TENANT RELEVANCE: on a client-run VM this serves that client's live call volume, backlog and failure rate to any internet caller, and nothing in the deploy config closes it, so a fresh deployment is insecure by default. Fix belongs in nginx/nginx.conf (an internal-only `location = /api/metrics` block mirroring the existing /docs deny), since removing it app-side would break the local Prometheus scrape.

</details>

---

### An explicitly empty permissions list is stored and reported as ALL permissions

- **Severity:** medium · **Category:** authz · **Lens:** authz
- **Location:** `backend/app/api/users.py:84`

**Impact.** An admin who creates a locked-down user by clearing every checkbox actually creates a user with all 19 permissions written into the users row, and the admin list view then confirms the (wrong) full set back to them. The mistake is invisible from the UI, and it is the opposite of the operator's intent.

<details><summary>Evidence</summary>

```
permissions=body.permissions or list(ALL_PERMISSIONS),

and in the response builder, users.py:27: `permissions=u.permissions or list(ALL_PERMISSIONS),`. `[] or X` evaluates to X, so an empty list means "grant everything". api/auth.py:305-309 already fixed exactly this on /auth/me with a comment explaining it — "`or` would treat an EMPTY list as 'unset' and grant EVERY permission" — but users.py was never updated, and unlike /auth/me it persists the wrong value to the database.
```

</details>

**Recommended fix.** Use `list(ALL_PERMISSIONS) if body.permissions is None else body.permissions` at line 84 and the same None-test at line 27, matching auth.py:308.

<details><summary>Independent verification</summary>

Verified verbatim in source. backend/app/api/users.py:84 is `permissions=body.permissions or list(ALL_PERMISSIONS)` and users.py:27 is `permissions=u.permissions or list(ALL_PERMISSIONS)`. The Pydantic schema (backend/app/schemas/user.py:16) declares `permissions: Optional[list[str]] = None`, so an explicit empty list is distinguishable from unset, but `or` collapses both to the full 19-key ALL_PERMISSIONS list (backend/app/models/user.py:14-34, 19 entries — the claim's count is correct). The contrast the claim draws is real: backend/app/api/auth.py:305-309 fixes exactly this on /auth/me with an explanatory comment ("`or` would treat an EMPTY list as 'unset' and grant EVERY permission"), and users.py was never updated; unlike /auth/me, users.py:84 persists the wrong value to the users row.

Reachable from the UI, not just the API: frontend/src/pages/EmployeeManagement.tsx:114 posts `permissions: formRole === 'admin' ? null : formPerms`, where formPerms is a free checkbox array (togglePerm, lines 96-98; checkbox grid lines 241-250) with no minimum-selection guard, so unchecking every box sends []. No guard, middleware, or shared dependency prevents it — require_role(UserRole.ADMIN) gates who may call the route, not the value written, and the path is not on the already-fixed or deliberate lists.

Additional amplifier the claim did not state: update_user (users.py:141-142) correctly uses `is not None`, so PATCH stores [] faithfully; but _user_response then reports that [] back as all 19, and startEdit (EmployeeManagement.tsx:126-133) rehydrates editPerms from that response — so the next open-and-save of a correctly locked-down user writes all 19 permissions into the DB. The read-side bug actively corrupts the correctly-stored value.

Fairness correction on impact/severity: `permissions` is enforced client-side only — grep over backend/app shows no server-side permission check; App.tsx:62 and AuthContext use it for nav/route gating, while backend authz is role-based (require_role). So the consequence is extra UI surface for a non-admin, not a direct backend data bypass (an over-permissioned paramedic opening Employee Management still gets 403 from /api/users/). Medium severity is defensible for a fresh client deployment where the operator's least-privilege intent is silently inverted, but this is a privilege-modelling/data-integrity defect rather than an exploitable backend authorization hole. Minor overstatement in the claim: the list view would render the contradictory "19 of 12 pages" (permissions-list returns only 12 of the 19 keys), so it is not literally invisible — but nothing tells the admin they granted everything, and the edit dialog shows every box re-checked.

</details>

---

### GET /api/users/{user_id} exposes any user's record to any authenticated caller

- **Severity:** medium · **Category:** authz · **Lens:** authz
- **Location:** `backend/app/api/users.py:106`

**Impact.** Any low-privilege account can enumerate the staff directory of the instance by UUID — who the admins are, which accounts are deactivated, and precisely which permissions each holds. That is the reconnaissance step that makes the other findings here targetable.

<details><summary>Evidence</summary>

```
@router.get("/{user_id}", response_model=UserResponse)
async def get_user(
    user_id: str,
    db: AsyncSession = Depends(get_db),
    _current: User = Depends(get_current_user),
):

Every other route in this "admin only" module uses require_role; this one is the lone get_current_user, and it applies no self-check (`user_id` is not compared to _current.id). It returns email, role, bhf_practice_number, is_active and the full permissions list.
```

</details>

**Recommended fix.** Either require_role(ADMIN, SUPER_ADMIN) or allow it only when `user_id == str(_current.id)`.

<details><summary>Independent verification</summary>

The code says exactly what the claim says. backend/app/api/users.py:106-117 defines GET /{user_id} with `_current: User = Depends(get_current_user)` and no role guard and no self-check — `_current` is bound but never compared to `user_id`. Every sibling route in the module (POST /, GET /, GET /permissions-list, PATCH /{user_id}, DELETE /{user_id}) uses Depends(require_role(UserRole.ADMIN)); this is the lone exception, in a module whose docstring says "admin only".

No guard prevents it. main.py:246 includes the router with no router-level dependencies, and APIRouter at users.py:15 declares no `dependencies=`. get_current_user (backend/app/utils/security.py:142-189) is authentication only — token type=="access", blacklist, user exists + is_active — and performs zero role checking; require_role at line 194 is the separate gate that is not applied here. Route ordering is fine (/permissions-list is declared before /{user_id}), so the path is reachable. ResponseCacheMiddleware caches /api/users for 60s but keys on the auth token, so it neither blocks nor cross-leaks. Not on the already-fixed or deliberate lists.

Reachable by genuinely low-privilege principals: UserRole (backend/app/models/user.py:37-42) includes DISPATCHER, PARAMEDIC (the UserCreate default), BILLING_CLERK. Any such account with a valid access token retrieves any user row's email, full_name, role, bhf_practice_number, is_active and full permissions list (UserResponse, backend/app/schemas/user.py:28-38). No password hash is exposed.

One correction to the claimed impact, which I do not treat as refuting: "enumerate the staff directory by UUID" is overstated. User.id defaults to uuid.uuid4 (random v4), so it is not brute-forceable, and I found no response schema exposing other users' UUIDs to non-admins (documents.py only writes uploaded_by at line 145; no schema in backend/app/schemas/ returns user_id/created_by/uploaded_by). The real exposure is a known-UUID lookup, not bulk directory extraction — GET /api/users/ (the actual directory) is correctly admin-gated. That argues for low-to-medium rather than medium severity, but the broken access control is real.

Fix is free of collateral: no frontend caller exists — only frontend/src/pages/EmployeeManagement.tsx touches this module (/api/users/, /api/users/permissions-list, POST, PATCH /{id}); nothing calls GET /api/users/{id}. Adding require_role(UserRole.ADMIN, UserRole.SUPER_ADMIN) (both, per the exact-match convention) breaks nothing. Incidental adjacent issue found while verifying reachability: unguarded uuid.UUID(user_id) at lines 113/128/166 turns a non-UUID path segment into a 500 + crash event instead of a 404.

</details>

---

### Provider portal-login has no lockout or failed-attempt counting, while portal-unlock verifying the same secret does

- **Severity:** medium · **Category:** authz · **Lens:** authz
- **Location:** `backend/app/api/providers.py:381`

**Impact.** The company portal password is the credential standing between the internet and a provider's patient PRFs. It can be brute-forced through /portal-login at nginx's 10 req/s budget with no lockout ever engaging and no audit record of the attempt, and the response codes first confirm which slugs exist and which are configured. Tracked in Security Fixes.md, but it is the highest-value unlocked door for a second tenant.

<details><summary>Evidence</summary>

```
@router.post("/{slug}/portal-login")
async def portal_login(slug: str, body: PortalLoginRequest, db: AsyncSession = Depends(get_db)):
    ...
    if not await verify_password_async(body.password, provider.portal_login_password_hash):
        raise HTTPException(status_code=401, detail="Invalid username or password")

No read of provider.locked_until, no increment of provider.failed_login_attempts, no AuditLog. crew_auth.portal_unlock (crew_auth.py:348-364) checks the lockout and increments the counter against the *same* provider.portal_login_password_hash, so the two doors to one secret are guarded unequally. It also leaks provider existence: 404 "Provider not found" vs 403 "No portal credentials configured" vs 401 — the uniform-error handling portal_unlock deliberately added at crew_auth.py:343.
```

</details>

**Recommended fix.** Route portal_login through the same lockout/audit path as portal_unlock (or delegate to it) and return one generic 401 for unknown slug, unset credential, and wrong password.

<details><summary>Independent verification</summary>

The code matches the claim verbatim. providers.py:381-412 verifies provider.portal_login_password_hash with no read of locked_until, no increment of failed_login_attempts, no AuditLog and no client-IP capture, while crew_auth.py:325-364 (portal_unlock) and auth.py:76-125 (the client-portal branch of /api/auth/login) both verify the SAME hash and both enforce the 5-fail/45-min lockout plus PORTAL_* audit rows. Security Fixes.md:165 marks "Lockout on provider portal login" DONE 2026-07-23 — the fix landed in auth.py and crew_auth.py and missed this third verifier.

No guard prevents it. The providers router is included with no dependencies (main.py:260) and the endpoint's only dependency is get_db. RateLimitMiddleware's AUTH_STRICT_PATHS (rate_limit.py:110) contains only /api/auth/login, /api/auth/refresh, /api/crew/login, so this path gets the general api_limit=300/window per IP (main.py:204-206), not the strict 15, and the limiter fails open when Redis is down (rate_limit.py:95-97). nginx confirms the same: nginx/nginx.conf:72 scopes the 5r/m auth zone to location /api/auth/login only, leaving /api/providers/... on api_limit 10r/s burst 20 (:61); infra/nginx/api.conf:137-170 is the same shape with a 100r/s general zone. ResponseCacheMiddleware is irrelevant to a POST. Not on the already-fixed or deliberate list.

Two corrections that shrink the finding without refuting it: (1) the enumeration sub-point is weak, because GET /api/providers/public (providers.py:363-374) already publishes every active provider's name and slug unauthenticated by design — only the 403 "no portal credentials configured" branch leaks anything new; (2) portal-login mints no token, it returns branding only, so it is an oracle rather than a direct door. But that is one step, not a defence: an attacker brute-forces the shared company password here at 300/min with zero audit trail and no lockout ever engaging, then spends a single correct attempt on portal-unlock to obtain the provider-bound grant, nullifying the lockout on the two doors that do enforce it. On a fresh client VM this is insecure by default.

Additional fact for the fixer: grep across the entire repo (frontend/src, tests, scripts, docs) finds no caller of portal-login — it is dead but still registered and internet-reachable, so deleting it is a cheaper and more complete fix than retrofitting lockout; if kept it needs the portal_unlock treatment (lockout check, counter, AuditLog with get_trusted_client_ip, uniform 401) plus addition to AUTH_STRICT_PATHS and an nginx auth-zone location.

</details>

---

### Deleting a crew member silently hard-deletes their submitted patient PRFs

- **Severity:** medium · **Category:** data-integrity · **Lens:** authz
- **Location:** `backend/app/api/providers.py:1215`

**Impact.** Offboarding a paramedic destroys every patient record they attended, including ones already submitted to a scheme, against a 7-year retention obligation and with no soft-delete or export. A "TEMPORARY ENABLEMENT" marked with a warning emoji is live on the go-live path.

<details><summary>Evidence</summary>

```
# ⚠️ TEMPORARY ENABLEMENT: Force-delete dud PRFs associated with this crew member
    await db.execute(
        delete(DigitalPRF).where(
            (DigitalPRF.crew_member_1_id == crew.id) |
            (DigitalPRF.crew_member_2_id == crew.id)
        )
    )

Unfiltered by status — SUBMITTED/PROCESSED/billed PRFs go too. Reachable by the tenant's own crew admin and, per the _assert_settings_access gap above, by any authenticated User of any role (providers.py:1193-1201).
```

</details>

**Recommended fix.** Refuse the delete (409) when non-DRAFT PRFs reference the crew member, or deactivate the crew member and leave the records; only DRAFTs should ever be reaped.

<details><summary>Independent verification</summary>

CONFIRMED — the code says exactly what the claim says, and nothing guards it.

Evidence read first-hand:
1. backend/app/api/providers.py:1193-1227 (delete_crew_member) executes `delete(DigitalPRF).where((crew_member_1_id == crew.id) | (crew_member_2_id == crew.id))` under the comment `# ⚠️ TEMPORARY ENABLEMENT: Force-delete dud PRFs...`, then `db.delete(crew)` and commit. There is NO status predicate.
2. backend/app/models/digital_prf.py:18-24 — PRFStatus = DRAFT/SUBMITTED/PROCESSED/FAILED/CORRECTED. None is excluded, so submitted and pipeline-processed PRFs are destroyed alongside drafts.
3. The row is the patient record itself: form_data JSON ("Full PRF content — patient, clinical, vitals") plus patient/crew signatures (lines 73-76, 118-126). Grep for deleted_at/is_deleted/archived/soft in the model returns nothing — hard delete, no soft-delete, no export.

Reachability (checked, not assumed):
- Tenant's own crew admin: frontend/src/pages/crew/ProviderAdminDashboard.tsx:497-506 issues DELETE /api/providers/{providerId}/crew/{id} behind only `Permanently delete ${name}?`. Admin console: frontend/src/pages/ProviderManagement.tsx:514-523, "Are you sure you want to delete this crew member?". Neither mentions PRFs — "silently" is accurate.
- Authz: providers.py:1201 calls _assert_settings_access, but that helper (providers.py:819-824) only constrains a CrewMember principal (role=="admin" and matching provider_id). A User principal returned by get_admin_or_crew_admin (providers.py:88-131 — authn-only: decode, type=="access", blacklist, is_active) falls straight through with no role check, so any active User of any role can call it. That compounds the finding rather than mitigating it.
- Route is mounted: app/main.py:38,260 include_router(providers_router). No middleware blocks it (ResponseCacheMiddleware is irrelevant for DELETE; RateLimit only throttles).

Counter-arguments considered and rejected:
- No status/"dud" filter exists anywhere else on this path.
- The only FK referencing digital_prfs is the self-referential correction_of_id (models/digital_prf.py:136-139). It could raise IntegrityError only in the narrow case where a correction row belongs to a different crew member — an accidental abort, not a guard, and it does not protect the ordinary case.
- Not on the ALREADY-FIXED or DELIBERATE lists. Contrast providers.py:755 delete_provider, whose docstring openly declares "Hard-delete a provider and ALL related data" — that destruction is at least announced; this one is not.

Impact as claimed is fair: offboarding a paramedic destroys every PRF they attended, including scheme-submitted ones, irrecoverably, against the 7-year retention obligation, on the go-live path for a fresh client tenant. Fix: scope the delete to status == DRAFT (or NULL the cre

</details>

---

### /uploads serves the whole upload volume with a denylist, so scanned patient PRFs in raw/ and processed/ are fetchable with no authentication

- **Severity:** medium · **Category:** authz · **Lens:** tenant-isolation
- **Location:** `backend/app/main.py:288`

**Impact.** Any PRF PDF path that leaks — a copied link, a browser history sync, a referrer header, a proxy or nginx access log, a support screenshot — becomes a permanent unauthenticated bearer token for that patient's full record, readable by anyone on the internet with no session, no tenant check and no audit trail. The uuid4 filename is the only thing standing between a stranger and PHI. More importantly for a second deployment, this is denylist-by-default on a volume that holds patient data: the prf_email/ entry was added reactively after that exact bug shipped, and the next worker spool directory someone adds will be public until somebody notices again.

<details><summary>Evidence</summary>

```
The hardened static mount blocks exactly one subdirectory and serves everything else:

    _PRIVATE_PREFIXES = ("prf_email/", "prf_email\\")

    async def get_response(self, path, scope):
        norm = (path or "").lstrip("/\\")
        if norm.startswith(self._PRIVATE_PREFIXES):
            return PlainTextResponse("Not Found", status_code=404)

    app.mount("/uploads", _HardenedUploads(directory=_upload_dir), name="uploads")   # main.py:303

but uploaded PRF scans go to the same volume under raw/ and processed/ (app/utils/storage.py:14-33):

    upload_dir = Path(settings.UPLOAD_DIR) / subfolder      # subfolder defaults to "raw"
    ...
    return f"{subfolder}/{unique_name}"

and nginx proxies the whole prefix through (nginx/nginx.conf:100-101):

    location ^~ /uploads/ {
        proxy_pass http://ems_api;

The authenticated door exists and is correct — GET /api/documents/{doc_id}/download at documents.py:293-298 requires a User — so there are two doors to the same bytes and one has no lock. app/services/ocr_extraction.py:386 also drops extraction_settings.json (provider profiles, matching keywords) at the volume root, i.e. GET /uploads/extraction_settings.json.
```

</details>

**Recommended fix.** Invert to an allowlist — serve only logos/, crew/ and vehicles/ from the static mount and 404 everything else — so a new subdirectory is private by default. Route all document access through the authenticated /api/documents/{doc_id}/download endpoint.

<details><summary>Independent verification</summary>

Confirmed by reading the code AND by executing the real app. backend/app/main.py:288-303 mounts stock StaticFiles over the entire UPLOAD_DIR with a single denylist entry ("prf_email/"); the get_response override only adds a sandbox CSP and nosniff, no authentication. A TestClient probe against the live upload volume returned: /uploads/raw/06977abf-….pdf -> 200, 124546 bytes, application/pdf (unauthenticated); /uploads/extraction_settings.json -> 200, 14458 bytes; /uploads/guidelines/<scheme manual>.pdf -> 200; /uploads/prf_email/x.pdf -> 404. backend/uploads/raw currently holds 66 PDFs. app/utils/storage.py:14-35 confirms save_upload defaults to subfolder "raw" and save_processed to "processed" on that same volume, and app/api/documents.py:135 uses it for PRF scans. nginx/nginx.conf:100 proxies the whole ^~ /uploads/ prefix to the API with "expires 30d; Cache-Control public". No middleware in the chain (CORS, GZip, RateLimit, XSSProtection, CrashHandler, ResponseCache) performs authentication, and StaticFiles mounts do not run route dependencies. The authenticated alternative door GET /api/documents/{doc_id}/download (documents.py:293-298, Depends(get_current_user)) exists as described, so the two-doors framing is accurate. Fair mitigations that lower but do not eliminate severity: OCR_INTAKE_ENABLED defaults to False (config.py:81), so /api/documents/upload 503s and a brand-new client VM will not accumulate NEW paper-PRF scans in raw/ until the flag is flipped; Digital-PRF PDFs are written to prf_email/, which is correctly blocked; extraction_settings.json holds extraction field/prompt config, not credentials. Exposure is therefore certain for any instance with an existing or inherited volume, and latent-by-default for a fresh one. One point the claim understates: providers.py:1162 names crew photos "<crew_uuid>.jpg" at /uploads/crew/, so staff photos are fetchable unauthenticated and cross-tenant with only a known crew UUID — reinforcing that the correct fix is an allowlist (logos/, crew/, vehicles/) rather than a growing denylist on a volume that also holds patient documents. Claim stands as written.

</details>

---

### shift-start-by-id has no role filter, so a crew member can mint a provider-admin token for their own company

- **Severity:** medium · **Category:** authz · **Lens:** tenant-isolation
- **Location:** `backend/app/api/crew_auth.py:513`

**Impact.** The portal grant proves only that the company password was typed on the device, and per the operational notes every crew member has to be told that password to start a shift. So the sole barrier between an ordinary paramedic and provider-admin is knowing the admin's crew UUID — and once they have it, the minted token unlocks the full /api/providers/{provider_id}/* surface for their company: read and rewrite settings, list and delete crew, reset any colleague's password, change the provider's SMTP account, and read every submitted PRF for the company. The /public-crew filter shows the role split was intended; this endpoint just doesn't enforce it.

<details><summary>Evidence</summary>

```
provider = await require_portal_grant(body.provider_slug, grant, db)

    crew_result = await db.execute(
        select(CrewMember).where(
            CrewMember.id == body.crew_id,
            CrewMember.provider_id == provider.id,
            CrewMember.is_active == True,
        )
    )

There is no `CrewMember.role != 'admin'` condition, and the resulting token copies the row's role verbatim (lines 530-541):

            "role": crew.role,
            "token_scope": "crew",

The companion listing endpoint deliberately excludes admins (providers.py:463-467):

            CrewMember.provider_id == provider.id,
            CrewMember.is_active == True,
            CrewMember.role != 'admin'

A token carrying role=="admin" then satisfies the settings guard (providers.py:819-823):

    if isinstance(principal, CrewMember):
        if principal.role != "admin" or principal.provider_id != provider_id:
            raise HTTPException(status_code=403, detail="Admin access required")
```

</details>

**Recommended fix.** Add `CrewMember.role != 'admin'` to the shift-start-by-id query (and to lookup-hpcsa at line 419-425), so provider-admin sessions can only come from the password-authenticated crew login rather than from name-selection plus a shared company password.

<details><summary>Independent verification</summary>

The code says what the claim says, no guard prevents it, and the route is mounted and reachable.

Verified chain:
1. C:/Users/USER-PC/Desktop/New EMS AUTOMATIONS/backend/app/api/crew_auth.py:500-564 — `shift_start_by_id` selects on `CrewMember.id == body.crew_id AND provider_id == provider.id AND is_active == True` only. I read the whole function; there is no role predicate anywhere, and `require_portal_grant` (crew_auth.py:287-322) only proves provider identity + a portal-grant/crew token bound to that provider. It never inspects the target row's role. The router is mounted (app/main.py:37, 259).
2. The minted token is indistinguishable from a password-authenticated crew session: `/api/crew/login` (crew_auth.py:168-175) and `shift-start-by-id` (crew_auth.py:530-543) both emit `token_scope: "crew"` + `crew_id`. There is no `auth_method` / step-up claim, so no downstream consumer can tell them apart.
3. `get_admin_or_crew_admin` (providers.py:88-131) accepts any `token_scope=="crew"` token, loads the CrewMember by `crew_id`, and returns the row if `is_active`. `_assert_settings_access` (providers.py:819-824) then checks `principal.role != "admin"`. Note a factual correction to the claim's evidence: the guard reads the role from the DB row, not from the token claim — but the outcome is identical, because the token names the admin's crew row, so the row it loads IS the admin. That correction does not weaken the finding.
4. Blast radius confirmed: ~20 endpoints hang off `get_admin_or_crew_admin` + `_assert_settings_access` — GET/PATCH `/settings` (providers.py:835, 871), settings logo, crew list/create/update/photo/reset-password/delete (997-1233), vehicles (1234-1415), and GET `/{provider_id}/prfs` (1416-1527). Provider-admin crew also read every PRF for the company via digital_prf.py:1545-1551 (`is_provider_admin` bypasses the "created by you" check). The admin row is created active with role="admin" and a super-admin-set password (providers.py:714-743), so the password on that row is the credential this path bypasses.
5. The role split is real, not imagined: `/public-crew` (providers.py:462-468) filters `CrewMember.role != 'admin'`, so admins are deliberately absent from the shift-start dropdown that feeds this exact endpoint. The prior hardening commit f80df14 added the portal grant but left the role filter off, so this is not on the already-fixed list.

Fairness adjustments to the claimed impact (the finding stands; the exploit precondition is narrower than stated):
- The escalation is intra-tenant, not cross-tenant. `require_portal_grant` rejects a grant whose `provider_id` differs from the slug's provider (crew_auth.py:318-320), so a crew member can only reach their own company's admin.
- The attacker genuinely needs the admin row's UUID, and no e

</details>

---

### GET /api/metrics is unauthenticated by design and is proxied to the internet, leaking operational volumes and burning ~8s of server work per request

- **Severity:** medium · **Category:** availability · **Lens:** tenant-isolation
- **Location:** `backend/app/api/metrics.py:17`

**Impact.** Two separate problems from one missing dependency. First, disclosure: anyone on the internet learns how many PRFs the business has processed, how many are failing, and the live DB pool depth — the same class of operational leak that /api/stats was fixed for (main.py:444-450 documents that fix). For a bureau serving competing EMS companies that is commercially sensitive on its own. Second, availability: because it is uncached and unauthenticated, a trivial request loop pins up to 8 seconds of latency and a pooled DB connection per request, exhausting DB_POOL_SIZE (20) and starving real crew traffic mid-call. A second client VM inherits both.

<details><summary>Evidence</summary>

```
@router.get("/api/metrics")
async def prometheus_metrics(db: AsyncSession = Depends(get_db)):
    """Prometheus-compatible metrics scrape endpoint (no auth)."""

Each anonymous hit runs two unbounded aggregates over digital_prfs:

    text("SELECT status::text, COUNT(*) FROM digital_prfs GROUP BY status")
    text("SELECT COUNT(*) FROM digital_prfs WHERE status = 'failed'")

plus an outbound HTTP call with a 5s timeout and a Celery control round-trip with a 3s timeout:

            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.get(mgmt_url, auth=(rmq_user, rmq_pass))
    ...
        inspector = _celery.control.inspect(timeout=3)

It sits under /api/, which nginx.conf:61-63 proxies, and the response cache explicitly refuses to cache it (core/response_cache.py:41): NEVER_CACHE = {"/api/auth", "/api/metrics", ...}.
```

</details>

**Recommended fix.** Require an admin token, or restrict /api/metrics to the monitoring network in nginx (allow the scrape source, deny all). Drop the httpx and Celery inspect calls behind a much shorter timeout, or precompute the gauges on a schedule instead of on the request path.

<details><summary>Independent verification</summary>

Claim confirmed on all load-bearing points; evidence is demonstrated, not asserted.

VERBATIM MATCH: backend/app/api/metrics.py:17-19 defines `@router.get("/api/metrics")` / `async def prometheus_metrics(db: AsyncSession = Depends(get_db))` with docstring "(no auth)". `get_db` is the sole dependency — no get_current_user, no require_role, no API key.

NO GUARD IN THE CHAIN (checked, per instruction):
- main.py:146-156 constructs FastAPI() with NO global `dependencies=`; grep for "dependencies=" in main.py returns nothing.
- main.py:265 `app.include_router(metrics_router)` — plain include, no mount-time dependency.
- RateLimitMiddleware (middleware/rate_limit.py) is authn-agnostic; skip list is ("/", "/health", "/docs", "/openapi.json") + /static, so /api/metrics IS limited (300/min per IP) but that is a throttle, not authorization.
- ResponseCacheMiddleware cannot short-circuit: core/response_cache.py:41 NEVER_CACHE includes "/api/metrics", so every hit executes the route body. Evidence accurate.
- ErrorLogging / XSSProtection / CrashHandler perform no auth.

REACHABILITY: nginx/nginx.conf:61-63 is a catch-all `location /api/ { proxy_pass http://ems_api; }` with no allow/deny. docker-compose.prod.yml:109 volume-mounts that exact file over the image-baked one, so it is live. The same file DOES `deny all` on /docs and /openapi.json, proving the author knew how to block internal endpoints and did not here. No other nginx conf (infra/nginx/api.conf, frontend/nginx.conf) contains a metrics rule, and neither is the mounted prod config.

COST: both text() aggregates over digital_prfs are verbatim (lines 26, 35); httpx.AsyncClient(timeout=5.0) line 56; _celery.control.inspect(timeout=3) line 73. get_db holds a pooled connection for the request; config.py:31 DB_POOL_SIZE = 20.

NOT ON THE FIXED/DELIBERATE LIST. Distinct from crashes.py optional-auth (that one returns no data; this returns operational data). It is in fact the same class main.py:444-450 documents fixing for /api/stats.

TWO FAIRNESS CORRECTIONS:
(a) Overstated — "~8s" is worst case only; on the Docker network the RabbitMQ mgmt call resolves or refuses fast, so realistic cost is dominated by the ~3s Celery inspect. The claim also ignores nginx `limit_req rate=10r/s burst=20` and the backend 300/min per-IP bucket, which blunt a naive single-source request loop.
(b) Understated — celery_app.control.inspect().active() is a SYNCHRONOUS kombu call inside an async def with no run_in_executor, so it blocks the whole event loop for up to 3s, stalling every concurrent request in that worker. Throughput collapses before DB pool exhaustion is reached. Availability impact is worse than described, just via a different mechanism.

SCOPE: leak is PRF counts by status, failed count, DB pool size/checkedout, que

</details>

---

### require_role(UserRole.ADMIN) without SUPER_ADMIN locks the super-admin out of all user management and claim void/rebill

- **Severity:** medium · **Category:** deploy-readiness · **Lens:** tenant-isolation
- **Location:** `backend/app/api/users.py:58`

**Impact.** Whoever holds SUPER_ADMIN gets a 403 from create-user, list-users, update-user, delete-user, the permissions list, and claim void/rebill — the highest-privilege account is the one that cannot administer the system. On the second client's instance this bites during onboarding: bootstrap via backend/create_admin.py:19 makes an ADMIN so things work, but the moment that account is promoted to SUPER_ADMIN (which is what the seeding path does, and what the post-incident password rotation encourages) the client can no longer add or remove their own staff and has no in-app way back.

<details><summary>Evidence</summary>

```
require_role is exact-match (utils/security.py:194-203):

    async def role_checker(current_user: User = Depends(get_current_user)):
        if current_user.role not in roles:
            raise HTTPException(status_code=403, ...)

Every users.py endpoint passes ADMIN alone — lines 32, 58, 96, 123, 162:

    _admin: User = Depends(require_role(UserRole.ADMIN)),

Same in claims.py:243 and claims.py:302 for void and rebill:

    current_user: User = Depends(require_role(UserRole.ADMIN)),

Meanwhile account_security.py:104 and 149 do it correctly:

    _admin: User = Depends(require_role(UserRole.ADMIN, UserRole.SUPER_ADMIN)),

and main.py:105-127 seed_super_admin actively promotes the default account away from ADMIN:

            if admin.role != UserRole.SUPER_ADMIN:
                admin.role = UserRole.SUPER_ADMIN
```

</details>

**Recommended fix.** Pass both roles at users.py:32, 58, 96, 123, 162 and claims.py:243, 302, matching account_security.py. Longer term, make require_role treat SUPER_ADMIN as satisfying an ADMIN requirement so the trap cannot recur.

<details><summary>Independent verification</summary>

The code says what the claim says, and nothing guards it. Verified: (1) utils/security.py:194-203 require_role is pure exact membership with no super-admin bypass; (2) models/user.py:37-42 SUPER_ADMIN="super_admin" is a distinct enum member from ADMIN="admin"; (3) api/users.py lines 34, 59, 97, 125, 163 all pass require_role(UserRole.ADMIN) alone; (4) api/claims.py:243 (void) and :302 (rebill) likewise; (5) a repo-wide grep for "require_role(" returns exactly 9 call sites — only account_security.py:51 and :102 pass both roles, so no shared dependency or middleware compensates; (6) ResponseCacheMiddleware keys on the auth token and only serves GETs, so it cannot mask the 403 for another principal; (7) main.py:105-126 seed_super_admin does promote admin@emsclaims.co.za to SUPER_ADMIN. So a SUPER_ADMIN principal receives 403 from create/list/update/delete user, permissions-list, and claim void/rebill.

Not covered by the deliberate list: that entry states call sites deliberately pass BOTH ADMIN and SUPER_ADMIN, which is precisely what these seven call sites fail to do (account_security.py is the only place the convention is honoured). No backend test exercises super_admin.

Extra confirming evidence the claim omitted: frontend/src/App.tsx:61 sets isAdmin = role==='admin' || role==='super_admin', and App.tsx:215 routes /employees to EmployeeManagement, which calls /api/users/, /api/users/permissions-list, POST /api/users/ and PATCH /api/users/{id} (EmployeeManagement.tsx:74,84,108,141) — so the page is offered to a super_admin and then fails at runtime rather than being hidden. Recovery is out-of-band only: demotion requires PATCH /api/users/{id}, which itself needs an ADMIN; create_admin.py returns early if admin@emsclaims.co.za exists; rotate_admin_password.py updates only hashed_password/lockout/password_changed_at and never touches role.

Two parts of the claimed impact are overstated and should be corrected when it is written up, but they do not refute the finding. (a) main.py:66 gates both seeders behind APP_ENV != "production" and config.py:17 defaults APP_ENV to "production"; infra/DEPLOY.md:232 and .env.example:12 both set production. So a correctly configured fresh client VM never runs seed_super_admin — bootstrap via create_admin.py:19 creates an ADMIN and user management works. The "broken by default on a new tenant" framing is wrong. The reachable paths are: any non-production APP_ENV value (the repo's own .env:2 and ci.yml:102 are "development"; the guard is != "production", so "prod"/"staging" also seed), and the API itself, since schemas/user.py types role as a free str coerced by UserRole(body.role), letting an admin create or promote a super_admin. (b) rotate_admin_password.py never modifies role, so "the post-incident password rotation

</details>

---

### The save path cannot clear a field — an erased signature or blanked odometer silently persists on the server

- **Severity:** medium · **Category:** data-integrity · **Lens:** data-integrity
- **Location:** `backend/app/api/digital_prf.py:427`

**Impact.** A crew who captures a signature from the wrong person, or from a patient who then withdraws consent, taps clear and sees it gone — but the server, the billing pipeline and the PDF emailed to the receiving facility all still carry it. The same applies to an odometer the crew blanked after the absurd-delta prompt: the discarded reading stays in `km_*` and is what the mileage engine bills. The crew's screen and the record of truth disagree, with no indication to either side.

<details><summary>Evidence</summary>

```
Every scalar branch of the PATCH handler skips nulls:

```python
    for sig_field in ["patient_signature", "witness_signature", "handover_signature", "crew_signature", "valuables_signature"]:
        val = getattr(body, sig_field, None)
        if val is not None:
            setattr(prf, sig_field, val)
```

same for timestamps (`if parsed is not None`) and km (`if val is not None`). The client contract explicitly relies on the opposite behaviour:

```ts
// frontend/src/pages/crew/prfSaveContract.ts
 * All five signature keys are always present (via the spread), so clearing a
 * signature sends an explicit null rather than omitting the key.
```

and both signature widgets clear to null (`SignaturePad.tsx:101` and `FullscreenSignaturePad.tsx:114`: `onChange(null)`). The km path turns a cleared field into null too (`cleanKms[k] = str.trim() ? str : null`), which is exactly what the "Clear & re-enter" button in the odometer sanity dialog produces.
```

</details>

**Recommended fix.** Distinguish "omitted" from "explicitly null" — use `model_fields_set` (Pydantic v2) or sentinel defaults, and apply an explicit null as a clear for signatures, km and timestamps.

<details><summary>Independent verification</summary>

The claim is accurate and I could not refute it on any of the allowed grounds.

CODE MATCHES THE QUOTE. backend/app/api/digital_prf.py:427-430 (signatures), :419-424 (km), :405-411 (timestamps) all guard with `if val is not None:`. The quoted snippet is verbatim.

THE SERVER STRUCTURALLY CANNOT HONOUR A CLEAR. PRFSaveRequest (digital_prf.py:63-99) declares every scalar as `str | None = None`, and the handler never consults `body.model_fields_set` — grep for `model_fields_set` / `exclude_unset` over the file returns nothing. So "key omitted" and "key sent as explicit null" are indistinguishable to the handler, and the `is not None` guard drops both. This is the mechanism, not a style issue.

THE CLIENT DEMONSTRABLY SENDS EXPLICIT NULLS (not asserted). frontend/src/pages/crew/prfSaveContract.ts buildSavePayload spreads `...s.sigs` (all five keys always present) and computes `cleanKms[k] = str.trim() ? str : null`. SignaturePad.tsx:92-102 `clear()` calls `onChange(null)` and is wired to a visible red "Clear" button rendered whenever hasContent; FullscreenSignaturePad.tsx:114 does the same. DigitalPRFForm.tsx:7581/7594/8497/8546/8992 write that null straight into `sigs`. The odometer "Clear & re-enter" branch at DigitalPRFForm.tsx:9977-9978 sets kms[key]='' which buildSavePayload converts to null.

THE STALE VALUE IS WHAT DOWNSTREAM READS, so impact is real:
- Admin/facility viewer returns the columns (digital_prf.py:1639-1643); PRFView.tsx:2257 renders `fd.tc_patient_signature || prf.signatures?.patient_signature`. Clearing wipes the form_data copy (form_data IS wholesale-replaced at :391-397) so the render falls through to the stale column. The emailed facility PDF is that same client render uploaded to :1689 ("the pixel-perfect render only exists client-side"), so the discarded signature reaches the receiving hospital.
- Adjudication/billing context reads prf.patient_signature etc. at :713-717 and _km(prf.km_*) at :632-641 (mileage distances).
- Reload path DigitalPRFForm.tsx:4759-4765 repopulates sigs from the columns, so on any device without the local draft (new device, cleared cache, post-End-Shift purge) the cleared signature visibly reappears.

NO GUARD/MIDDLEWARE/DEPENDENCY PREVENTS IT. Middleware (ErrorLogging/CORS/RateLimit/XSS/CrashHandler, ResponseCache) does not touch the request body. The route's own guards are status-lock (423, :363), optimistic concurrency (409, :371-382) and tenancy (_load_crew_prf / _assert_provider_owns) — none reject or rewrite a null. scrub-phase (:733) is a hardcoded no-op that returns at :756 and clears nothing. The path is plainly reachable (DRAFT PRFs, ordinary autosave). Not on the already-fixed or deliberate lists.

SECOND INSTANCE: mark_timestamp has the same bug at :946 (`if body.km and hasattr(prf, km_fiel

</details>

---

### geo_locations is absent from the save schema, so GPS captured offline never reaches the server

- **Severity:** medium · **Category:** data-integrity · **Lens:** data-integrity
- **Location:** `backend/app/api/digital_prf.py:63`

**Impact.** Exactly the calls where GPS evidence matters most — rural and dead-zone incidents that schemes query on distance — arrive with an empty geo_locations map, while the timestamps they were captured alongside do persist. The correction path copies `geo_locations=original.geo_locations` (failed_prfs.py:299), so the gap propagates into the corrected billing record. The velocity-based spoofing check in mark_timestamp also never sees those points, so its "most recently captured coordinate" baseline is computed across a hole in the track.

<details><summary>Evidence</summary>

```
`PRFSaveRequest` has form_data, 9 timestamps, 9 km, 5 signatures, vehicle and crew — no geo field. The only writer is the online-only mark-time endpoint:

```python
@router.post("/{prf_id}/mark-time")
...
        existing[body.field] = geo_entry
        prf.geo_locations = existing
```

When that call fails the client keeps the fix locally and nowhere else:

```ts
// DigitalPRFForm.tsx:5294 commitMarkTime
    } catch {
      // Offline / network error — still record locally so the crew isn't blocked.
      setTs(p => ({ ...p, [timeKey]: new Date().toISOString() }));
      if (coords) { setGeos(p => ({ ...p, [timeKey]: { lat: ..., lng: ... } })); }
```

`buildSavePayload` never includes `geos`, and the outbox replays only create / PATCH / submit (syncEngine.ts:130-168) — mark-time is never queued.
```

</details>

**Recommended fix.** Add `geo_locations: dict | None` to PRFSaveRequest and merge it key-by-key into the existing JSONB (never wholesale-replace, or a stale client wipes server-side captures), then include `geos` in `buildSavePayload`.

<details><summary>Independent verification</summary>

Every element of the claim is verified in code; five independent refutation attempts all failed.

1. Schema gap confirmed: PRFSaveRequest (backend/app/api/digital_prf.py:63) has form_data, 9 timestamps, 9 km, 5 signatures, vehicle_id, crew_member_1/2_id, client_base_updated_at — and no geo field.

2. No alternative backend writer: repo-wide grep for geo_locations yields exactly one write site, mark_timestamp (digital_prf.py:956 `existing = dict(prf.geo_locations or {})`, :988 `prf.geo_locations = existing`). save_prf (PATCH /{prf_id}, line 345) never touches prf.geo_locations; its form_data merge only writes the form_data JSONB (and strips underscore keys), so a client cannot smuggle geo into the column. digital_prf.py:1443 is a read in GET; failed_prfs.py:299 is a copy.

3. No alternative client path: prfSaveContract.ts SaveState declares fd, vitals, ivRows, medRows, timestamps, kms, sigs, vehicle, crew2Id — no geos. buildSavePayload returns form_data/vehicle_id/crew_member_2_id/cleanTs/cleanKms/sigs. Geo is structurally absent from the save contract, and DigitalPRFForm.tsx:5127 passes that exact set.

4. Outbox cannot carry it: offlineDb.ts:5 types entries as action: 'create' | 'save' | 'submit'. There is no mark-time action, so it can never be queued/replayed (syncEngine.ts replays only those three).

5. No retry on reconnect: '/mark-time' has exactly one caller in the entire frontend (DigitalPRFForm.tsx:5292) inside commitMarkTime; the catch block only calls setTs/setGeos locally and sets dirtyRef.

Loss is permanent (claim actually understates this): geos is persisted to the local draft (saveToLocal ~4622) and restored (loadFromLocal 4659); setGeos(prf.geo_locations || {}) at 4759 runs only when no local draft exists, so no clobber. But clearLocalDraft() fires on every successful submit path (5987, 5990, 5995, 6042), destroying the device-only coordinate at submit, having never reached the server.

Impact demonstrated, not asserted: (a) the asymmetry is real — cleanTs puts timestamps in the PATCH body so times persist while the coordinate captured in the same tap does not; (b) geo_locations feeds geo_segments_from_prf (services/geo_utils.py:142), consumed by mileage_engine.py:533-541 as the GPS fallback that fills callout_km/loaded_km/rtb_km when odometer segments are missing — i.e. it matters most on exactly the rural/dead-zone calls where odometer data is also likeliest incomplete; (c) failed_prfs.py:299 copies geo_locations into the correction record, propagating the hole into corrected billing; (d) the spoofing baseline `latest_key = max(existing, key=...captured_at)` reads only persisted points, so it is computed across the gap.

Not covered by any already-fixed or deliberate item, and no middleware/dependency prevents it (ResponseCacheMidd

</details>

---

### Odometer strings are written straight into Numeric columns with no validation — one bad character stops the PRF saving

- **Severity:** medium · **Category:** input-validation · **Lens:** data-integrity
- **Location:** `backend/app/api/digital_prf.py:419`

**Impact.** A single stray decimal point in an odometer box turns every subsequent autosave into a 500. `classifySaveError` maps anything unrecognised to `'queue'`, so the client neither surfaces an error nor drops the payload — it retries the same poisoned body forever. The crew keeps working a PRF that has silently stopped persisting, and only discovers it when the device is closed or the outbox count is noticed.

<details><summary>Evidence</summary>

```
```python
    for field in KM_FIELDS:
        val = getattr(body, field, None)
        if val is not None:
            # Empty strings crash asyncpg when written to Numeric columns
            # (decimal.ConversionSyntax). Treat '' as NULL.
            setattr(prf, field, val if val != '' else None)
```

The comment documents that the raw string is handed to decimal conversion; only the empty string is guarded. The client filter permits other non-numeric results — `v = e.target.value.replace(/[^0-9.]/g, '')` (DigitalPRFForm.tsx:697) leaves a bare `"."`, and `fmt()` renders `"."` as `"."` so the crew sees nothing obviously wrong. The column is `Numeric(8, 1)`, so a value over 9 999 999.9 overflows as well. `mark_timestamp` has the same unguarded assignment: `setattr(prf, km_field, body.km)`.
```

</details>

**Recommended fix.** Validate km fields in the Pydantic model (a field validator that parses to Decimal, bounds-checks against Numeric(8,1) and rejects with 422), so a bad value fails loudly on one field instead of silently killing the whole record.

<details><summary>Independent verification</summary>

Verified in source, not asserted. (1) backend/app/api/digital_prf.py:83-91 declares all nine km_* fields as `str | None` on PRFSaveRequest, so Pydantic does no numeric coercion. (2) L419-424 is exactly as quoted: only '' is mapped to None; every other string is setattr'd raw onto a Numeric(8,1) column (models/digital_prf.py:91-99). (3) I inspected the installed SQLAlchemy 2.0.48 AsyncpgNumeric: bind_processor returns None, so the raw str reaches the driver/PG. Decimal('.') raises InvalidOperation/ConversionSyntax identically to Decimal(''), the failure the in-code comment documents empirically; '1.' and '.5' are valid, so the bare '.' is the poison value, plus any >=8-digit reading (numeric field overflow on Numeric(8,1), max 9999999.9). (4) No try/except around `await db.commit()` in the route, so it is a 500. (5) Middleware chain checked: XSSProtectionMiddleware only scans for XSS markup and passes the body through unmodified; rate-limit/crash-handler/response-cache do not sanitize or block. No dependency validates km. (6) mark_timestamp (L946-947) is the second unguarded instance, gated only on truthiness, so '.' passes and the timestamp commit fails too. (7) Frontend reachability confirmed: DigitalPRFForm.tsx:697 filter permits a lone '.', fmt() renders it as '.', handleKmCommit (L5429) does parseFloat then `if (isNaN) return false` (declines, never corrects), and prfSaveContract.buildSavePayload sends it because str.trim() is truthy. classifySaveError maps 500 -> 'queue' -> queueToOutbox + setSaveState('offline'), so the crew sees an offline indicator rather than an error. Impact is if anything worse than claimed: handleSubmit (L5920-5950) breaks out of the authoritative final PATCH on a 500 and falls through to POST /submit, which succeeds and locks the PRF; the queued saves then 423 and syncEngine treats 404/423 saves as obsolete and markSynced (deletes) them, so everything captured after the bad keystroke, including signatures, is silently lost against a locked record. Only softening: the trigger is an unusual typo and the value never persists (gone on reload), and syncEngine does markDead after 5 retries in the autosave-only case, so it is not a literal infinite silent retry. Medium severity stands. Fix: one shared _to_decimal() helper used at both L419 and L947 that parses, range-checks against Numeric(8,1), and silently treats unparseable input as NULL (silent, per the no-mid-call-validation rule).

</details>

---

### Submit is only idempotent against two of the five statuses — a superseded PRF can be re-submitted into a second Case and Claim

- **Severity:** medium · **Category:** data-integrity · **Lens:** data-integrity
- **Location:** `backend/app/api/digital_prf.py:1246`

**Impact.** An outbox entry that drains after an admin has corrected the PRF (or a crew retap on a FAILED-then-corrected record) resubmits the superseded original, producing a second Case and Claim for one incident — the same patient billed twice to the same scheme. Deleting a case then resubmitting does the same thing. The row lock in the worker prevents concurrent duplication but not sequential duplication, because the marker it locks on is mutable and is cleared elsewhere.

<details><summary>Evidence</summary>

```
```python
    if prf.status == PRFStatus.PROCESSED and prf.case_id:
        ... return existing result
    if prf.status == PRFStatus.SUBMITTED:
        ... return pending
    # everything else falls through to a fresh submit
    prf.status = PRFStatus.SUBMITTED
    prf.submitted_at = datetime.now(timezone.utc)
    await db.commit()
```

FAILED and CORRECTED fall through. A CORRECTED original has already been replaced by a new row that is itself queued for billing (failed_prfs.py:311-314), and its `case_id` is still NULL, so the worker's guard does not fire either:

```python
# app/tasks/prf_processing.py:152
    if prf.status == PRFStatus.PROCESSED or prf.case_id is not None:
        ... skip
```

The PROCESSED check is also conditioned on `prf.case_id`, which `delete_case` nulls while leaving the status intact (cases.py:388-392: `.values(case_id=None, document_id=None)`).
```

</details>

**Recommended fix.** Reject submit for CORRECTED outright, and make the idempotency marker immutable — key off `submitted_at`/a dedicated processed flag rather than `case_id`, which other endpoints null.

<details><summary>Independent verification</summary>

Verified against source; the core defect is real and reachable.

CONFIRMED:
- digital_prf.py:1216-1269 — idempotency guards are only (status==PROCESSED AND case_id) and status==SUBMITTED. FAILED, CORRECTED, and PROCESSED-with-null-case_id all fall through to `prf.status = SUBMITTED` + a fresh `process_prf_submission.apply_async`.
- failed_prfs.py:268-314 — correction creates a NEW PRF row (status=SUBMITTED, enqueued ~line 340) and sets original.status = CORRECTED, never setting original.case_id. A FAILED PRF always has case_id NULL: the worker's Case insert only lands on the single final commit, and the watchdog escalation (prf_processing.py:445-460) selects on case_id.is_(None).
- prf_processing.py:151-157 — worker guard is `status == PROCESSED or case_id is not None`. On the resubmitted CORRECTED original both are false, so it proceeds to db.add(case)/Document/Claim (lines 238-282). No dedupe on incident/patient/case_number/correction_of_id and no unique constraint, so a second Case + Document + Claim is created for one incident.
- cases.py:388-392 — `.values(case_id=None, document_id=None)` does null case_id while leaving status PROCESSED, killing both guards as claimed.

REACHABILITY (checked, not assumed):
- syncEngine.ts:145-176 drains a queued submit entry via PATCH-then-POST /submit, swallowing 423 on the PATCH and relying on a comment asserting the submit is idempotent. A CORRECTED PRF returns 423 on PATCH (digital_prf.py:363) then falls through submit. Dead outbox entries are deliberately retained for manual crew resend (syncEngine.ts:101-111).
- _validate_prf_for_submission (digital_prf.py:1145-1175) only checks non-empty form_data, call_type, and crew_member_1_id — all present on a real PRF, so it does not block the replay.
- _load_crew_prf passes: the correction copies crew_member_1_id.
- ResponseCacheMiddleware (app/core/response_cache.py:133-137) invalidates and passes through on POST, so it is not a barrier.
- No middleware/dependency in the chain blocks it; not on the already-fixed or deliberate list.

WHERE THE CLAIM OVERREACHES (does not change the verdict):
- The FAILED fall-through alone is not a duplication source — no Case exists, and reprocess_failed_prf (failed_prfs.py:384-395) treats resubmitting a FAILED PRF as intended remediation.
- "Deleting a case then resubmitting does the same thing" is mechanically accurate but does not yield a second Case for one incident — the first was deleted. It resurrects a deliberately deleted billing record instead. Same broken invariant, different consequence.

NET: the guard keys on a mutable marker (case_id) that two other endpoints clear or never set, so the worker's FOR UPDATE lock prevents only concurrent, not sequential, duplication. The CORRECTED path genuinely produces a duplicate Ca

</details>

---

### The offline self-heal re-creates a PRF without client_id, defeating the create endpoint's idempotency

- **Severity:** medium · **Category:** data-integrity · **Lens:** data-integrity
- **Location:** `frontend/src/services/syncEngine.ts:50`

**Impact.** A flaky link during outbox drain — the exact condition this code exists to handle — produces two or more server-side PRFs for one incident, each consuming a provider PRF number, and each that reaches submit producing its own Case and Claim. Duplicate patient records and duplicate scheme billing for a single call.

<details><summary>Evidence</summary>

```
The normal drain path is idempotent because it replays the device-chosen id:

```ts
          await axios.post('/api/digital-prf', { ...entry.payload, client_id: prfId }, ...);
```

The 404 self-heal path is not:

```ts
  const createRes = await axios.post('/api/digital-prf', {
    vehicle_id: payload?.vehicle_id || storedVehicle?.id || null,
    crew_member_2_id: payload?.crew_member_2_id || null,
    supervising_practitioner_pr: supervisor?.hpcsa_number || null,
    ...
  }, { headers, timeout: 10000 });          // no client_id
  ...
  await axios.patch(`/api/digital-prf/${newId}`, payload, ...);
  await axios.post(`/api/digital-prf/${newId}/submit`, null, ...);
```

The server's replay check is keyed entirely on that field (`create_prf`, digital_prf.py:238: `select(DigitalPRF).where(DigitalPRF.id == client_uuid)`), so with it omitted every call mints a new row. If the PATCH or the submit then fails, the outbox entry stays pending against the *original* prfId, the next drain 404s again and re-enters this function.
```

</details>

**Recommended fix.** Mint a UUID on the device inside `recreateAndSubmit` and pass it as `client_id`, persisting it on the outbox entry so a retry converges on the same row instead of creating another.

<details><summary>Independent verification</summary>

The claim is accurate as written and no guard prevents it. Verified in source: syncEngine.ts:130-133 (normal drain) sends client_id: prfId, while recreateAndSubmit at syncEngine.ts:50-56 omits it entirely, sending only vehicle_id, crew_member_2_id and the three supervising_practitioner_* fields. Server-side, backend/app/api/digital_prf.py:232 gates the whole replay check behind `if body.client_id:`, so with the field absent execution falls through to the provider FOR UPDATE lock, _next_prf_number, _generate_case_number and a brand-new DigitalPRF row. No content-based dedup exists: prf_processing.py:132-154 dedups only per-PRF-id via SELECT FOR UPDATE, which cannot see that two distinct ids describe one incident.

Reachability confirmed three ways: (1) end_shift/delete_prf hard-delete an empty draft, the documented case where the create landed but queued saves did not; (2) a create entry given up on is marked dead, and offlineDb.ts:128 excludes dead from getPending, so it stops populating blockedPrfIds and the submit entry drains against a nonexistent row; (3) on any throw inside recreateAndSubmit the outer catch calls markFailed, the entry keeps its original ${prfId}:submit key, and the next pass 404s and mints another row — bounded only by the retries>5 cap (~6 rows), not by idempotency.

Impact is real but worth calibrating. The common partial failure (create ok, PATCH fails) leaves orphan empty drafts that each burn a provider prf_number from the monotonic max()+1 counter, though end_shift later sweeps them since _draft_has_captured_work is false. The serious outcome — two submitted PRFs, each producing its own Case and Claim, i.e. duplicate patient records and duplicate scheme billing — requires the narrower window where the submit lands but its response is lost (15s timeout), or the submit 422s after a successful PATCH. Both are plausible on the flaky mobile links this code exists to handle.

Provenance indicates oversight rather than intent: commit abf7a80 added the self-heal BEFORE b69ea03 introduced client_id idempotency, and the covering test (offlineSync.test.ts:280) asserts only expect.objectContaining({ vehicle_id: 'veh-1' }), unlike the drain tests at lines 360 and 457 which explicitly assert client_id. Not on the already-fixed or deliberate lists.

Two caveats for the fix: passing client_id is not a blind one-liner, because a 404 from _load_crew_prf also occurs when the row exists but require_owner fails, in which case the create would hit the same-provider replay branch and return a row the device still cannot PATCH. And the identical omission exists in the inline form self-heal at DigitalPRFForm.tsx:6024-6035. Also noted in passing: syncEngine.ts:96 skips the cross-tenant refusal when providerNow is undefined (missing crew_profile), l

</details>

---

### docker-compose.db.yml publishes Postgres 5432 and PgBouncer 6432 on every interface, and Docker's rules bypass the ufw policy harden-vm.sh installs

- **Severity:** medium · **Category:** tenant-isolation · **Lens:** deploy-readiness
- **Location:** `docker-compose.db.yml:39`

**Impact.** Docker inserts its publish rules into the nat/DOCKER chains, which are traversed before ufw's INPUT rules — so a `-p 5432:5432` publish is reachable from the internet even with ufw default-deny active. The in-file comment "Firewalled" is therefore false. Our production instance is unaffected (it uses Azure managed Postgres and never brings up this compose file), but a client who takes the documented self-hosted option exposes the entire patient database to the internet, authenticated only by POSTGRES_PASSWORD — which the same template ships as `CHANGE_ME_STRONG_PASSWORD_HERE`. Password guessing against 5432 is unrate-limited and invisible to the app's own rate limiter.

<details><summary>Evidence</summary>

```
docker-compose.db.yml:39 and :87 — no bind address, so Docker publishes on 0.0.0.0:

    ports:
      - "5432:5432"                    # Firewalled — only PgBouncer & standby allowed
    ...
    ports:
      - "6432:6432"                    # App servers connect here (firewalled)

The only host firewall in the repo is deploy/scripts/harden-vm.sh:26-30:

    echo "== 3/4  ufw host firewall: default-deny inbound, allow only 22/80/443 =="
    sudo ufw allow OpenSSH
    sudo ufw allow 80/tcp
    sudo ufw allow 443/tcp
    sudo ufw --force enable

The worker compose gets this right and shows the correct idiom (docker-compose.worker.yml:50-51):

    - "127.0.0.1:5672:5672"          # AMQP — firewalled, only app servers allowed
    - "127.0.0.1:15672:15672"        # Management UI — localhost only (SSH tunnel)

.env.prod.template:20 explicitly offers the self-hosted path: "If self-hosting Postgres via docker-compose.db.yml on the same VM, leave as: DATABASE_URL=...@ems_postgres:5432/..."
```

</details>

**Recommended fix.** Bind both to loopback (`"127.0.0.1:5432:5432"`, `"127.0.0.1:6432:6432"`) as the worker compose already does, or drop the publishes entirely and let the app reach them over the ems_db_net bridge. Correct the misleading comments, and if the self-hosted path is to stay supported, add an Azure NSG / iptables DOCKER-USER rule to harden-vm.sh.

<details><summary>Independent verification</summary>

CONFIRMED. The code says what the claim says, and no guard compensates.

VERIFIED FACTS:
1. docker-compose.db.yml:38-39 publishes "5432:5432" and :86-87 publishes "6432:6432", both with no bind address -> Docker publishes on 0.0.0.0. In-file comments claim "Firewalled — only PgBouncer & standby allowed" / "(firewalled)".
2. No compensating control exists anywhere in the repo: a case-insensitive grep across the whole repo for DOCKER-USER, daemon.json, and iptables returns ZERO matches. There is no DOCKER-USER chain rule and no "iptables": false daemon config. Docker's publish rules DNAT in nat/PREROUTING and are evaluated in FORWARD via the DOCKER chain; ufw's default-deny sits on INPUT, which forwarded container traffic never traverses. So ufw default-deny does not close a -p 5432:5432 publish. The claimed mechanism is correct (the claim's wording "traversed before ufw's INPUT rules" is slightly imprecise — the real reason is the traffic is forwarded, not input-destined — but the operational conclusion is right).
3. The repo states the very invariant being violated: deploy/scripts/verify-security.sh:20 — "Listening sockets (want: only 22/80/443 on 0.0.0.0; rest on 127.0.0.1)".
4. Every other compose file honours that idiom; docker-compose.db.yml is the sole exception, and it is the one holding patient data. docker-compose.worker.yml:50-51 uses 127.0.0.1:5672 / 127.0.0.1:15672; infra/monitoring/docker-compose.monitoring.yml binds all five ports (9090, 3000, 9093, 3100, 3001) to 127.0.0.1. This is an oversight, not a deliberate choice.
5. Path is reachable on a fresh client deploy: infra/DEPLOY.md:165 and :188 give the literal `docker compose -f docker-compose.db.yml up -d` for BOTH the DB primary and the standby (two internet-exposed copies of the patient DB), and .env.prod.template:20 documents the same-VM self-host option.
6. Password compounding verified: .env.prod.template ships POSTGRES_PASSWORD=CHANGE_ME_STRONG_PASSWORD_HERE and repeats the same placeholder inside the self-host DATABASE_URL line.

ONE CORRECTION TO THE EVIDENCE — it strengthens the finding rather than weakening it:
The claim asserts "the only host firewall in the repo is deploy/scripts/harden-vm.sh". That is FALSE. A second, more thorough script exists — infra/security/ufw-setup.sh — and it is the one actually paired with this compose file (infra/DEPLOY.md:129 invokes it). Lines 51 and 56 write `ufw allow from 10.0.0.0/8 to any port 5432` and `... port 6432` with comments "PostgreSQL - internal" / "PgBouncer - internal". Those rules are equally inert against Docker-published ports, so an operator sees authoritative-looking "internal" entries in `ufw status verbose` while the ports are open to the internet. The false assurance is worse than the claim described, not better.

COUNT

</details>

---

### Every secret in .env.prod is injected into containers that have no use for it, including Postgres, PgBouncer and RabbitMQ

- **Severity:** medium · **Category:** secret-config · **Lens:** deploy-readiness
- **Location:** `docker-compose.db.yml:36`

**Impact.** The JWT signing key and the POPIA Fernet key are readable from the environment of the Postgres, PgBouncer and RabbitMQ containers, and from `docker inspect` output on the host. Any RCE or container escape in an off-the-shelf image (postgres:16-alpine, edoburu/pgbouncer:latest — an unpinned `:latest` tag, so its content changes under you) yields the key needed to forge SUPER_ADMIN tokens for the whole instance. It also widens the blast radius of routine ops: a support engineer given read access to logs or `docker inspect` on the DB container gets the crypto keys.

<details><summary>Evidence</summary>

```
The single .env.prod file — which holds SECRET_KEY, ENCRYPTION_KEY, and every third-party API key (its key list: SECRET_KEY, ENCRYPTION_KEY, CLAID_API_KEY, LLAMA_CLOUD_API_KEY, MISTRAL_API_KEY, INFOBIP_API_KEY, TWILIO_AUTH_TOKEN, VITE_GOOGLE_MAPS_KEY, ...) — is loaded wholesale into five containers:

    docker-compose.db.yml:36      env_file: [.env.prod]   # ems_postgres
    docker-compose.db.yml:84      env_file: [.env.prod]   # ems_pgbouncer
    docker-compose.worker.yml:47  env_file: [.env.prod]   # ems_rabbitmq
    docker-compose.worker.yml:82  env_file: [.env.prod]   # ems_celery_worker
    docker-compose.worker.yml:121 env_file: [.env.prod]   # ems_celery_beat

Only POSTGRES_USER/PASSWORD/DB are needed by the DB containers and only RABBITMQ_USER/PASS by the broker.
```

</details>

**Recommended fix.** Split into per-service env files (.env.db, .env.broker, .env.app) so each container receives only what it needs, or move to Docker secrets / a file-mounted secret read at startup. Pin edoburu/pgbouncer to a digest rather than :latest.

<details><summary>Independent verification</summary>

The code says what the claim says, and nothing mitigates it. All five `env_file: [.env.prod]` lines exist at the exact cited line numbers (docker-compose.db.yml:36 ems_postgres, :84 ems_pgbouncer; docker-compose.worker.yml:47 ems_rabbitmq, :82 ems_celery_worker, :121 ems_celery_beat). .env.prod does hold SECRET_KEY, ENCRYPTION_KEY, CLAID_API_KEY, LLAMA_CLOUD_API_KEY, MISTRAL_API_KEY, INFOBIP_API_KEY, TWILIO_AUTH_TOKEN and VITE_GOOGLE_MAPS_KEY in a single file, and Docker's env_file injects the entire file (the sibling `environment:` blocks override same-named keys but do not restrict the rest). Not on the already-fixed or deliberate list; no guard exists.

However the scope is materially overstated in three ways, and severity should be downgraded to low/medium accordingly.

(1) Three containers, not five. ems_celery_worker and ems_celery_beat build from backend/Dockerfile.prod and import app.config, where SECRET_KEY (config.py:52) and ENCRYPTION_KEY (config.py:135) are declared with NO default — the process cannot start without them, and the worker genuinely executes OCR/notification code paths needing the third-party keys. Those two env_file lines are correct, not over-provisioning. The claim's evidence block nonetheless presents all five as the defect.

(2) Postgres and PgBouncer are not on the deployed path. .github/workflows/deploy.yml and deploy/GO-LIVE-RUNBOOK.md invoke only docker-compose.prod.yml and docker-compose.worker.yml; production uses Azure Database for PostgreSQL, off-VM. docker-compose.db.yml is referenced only by infra/DEPLOY.md, whose topology gives the dedicated DB host its own .env.prod containing ONLY POSTGRES_USER/PASSWORD/DB (~line 158) — so in its own documented deployment it does not leak app secrets either. The leak materialises only if someone self-hosts Postgres on the single app VM beside the full .env.prod, which .env.prod.template:17 does explicitly contemplate. That makes it a real client-VM footgun but not a current production condition.

(3) The `docker inspect` / support-engineer impact is inflated: docker socket access is root-equivalent on the host and already permits reading /opt/ems/.env.prod directly. Only the contained-RCE argument (compromise inside postgres:16-alpine or the unpinned edoburu/pgbouncer:latest at db.yml:65 yielding SECRET_KEY without host root) is legitimate.

What survives and is worth hardening: ems_rabbitmq (worker.yml:47) runs on the live production VM today and receives the JWT signing key and POPIA Fernet key for no reason. It already declares RABBITMQ_DEFAULT_USER/PASS explicitly at lines 42-43, so deleting the env_file line is a zero-behaviour-change edit. Same for ems_postgres (POSTGRES_* already declared at lines 30-32) and ems_pgbouncer (its DATABASE_URL at line 69 uses shell `${PO

</details>

---

### create_admin.py hardcodes a known admin password, and it is not on the rotation tool's burned list

- **Severity:** medium · **Category:** secret-config · **Lens:** deploy-readiness
- **Location:** `backend/create_admin.py:18`

**Impact.** Because seeding is (correctly) disabled in production, a deployer bootstrapping a client instance will reach for this script — it is the only thing in the repo that creates a first admin. Every instance bootstrapped this way shares one published credential on a same-named account, `admin@emsclaims.co.za`, at the client's own domain. Nothing forces a rotation afterwards, and the rotation tool would happily accept `Admin@2026!` as the "new" password since it is not in BURNED. The account is created with permissions=None, the widest setting, and main.py:105 seed_super_admin would elevate that same email to SUPER_ADMIN if the instance is ever restarted with APP_ENV != production.

<details><summary>Evidence</summary>

```
backend/create_admin.py:15-21 — the only non-dev bootstrap path for an admin account:

    admin = User(
        email="admin@emsclaims.co.za",
        hashed_password=hash_password("Admin@2026!"),
        full_name="System Administrator",
        role=UserRole.ADMIN,
        is_active=True,
        permissions=None # Full access
    )

This file is tracked in git (`git ls-files` includes it) and the repo was public 2026-05-27 to 2026-07-27. The rotation tool's rejection list, backend/rotate_admin_password.py:44, does not contain it:

    # Anything that ever appeared in the repository is burned — refuse it outright.
    BURNED = {"admin@2024!", "admin@2024", "password", "changeme"}
```

</details>

**Recommended fix.** Rewrite create_admin.py to take the email and a getpass-prompted password (reusing rotate_admin_password.py's complexity check and refusing BURNED), never a literal. Add "Admin@2026!" and "DevSeed!Change#2026" to BURNED. Make first admin creation an explicit, documented first-deploy step that produces a per-instance credential.

<details><summary>Independent verification</summary>

Claim confirmed by direct code reading; the defect is real and deploy-relevant.

VERIFIED:
1. backend/create_admin.py:17 (claim says :18, off by one) hardcodes hash_password("Admin@2026!") for email admin@emsclaims.co.za, role=UserRole.ADMIN, is_active=True, permissions=None. Quoted evidence is verbatim.
2. Tracked in git since 63a1c82 "Initial commit" dated 2026-05-27 -- the exact first day of the public window (2026-05-27 to 2026-07-27). The literal was published for the full two months.
3. rotate_admin_password.py:45 BURNED = {"admin@2024!","admin@2024","password","changeme"} does NOT contain admin@2026!. Repo-wide grep shows the inversion sharply: the ONLY password literal still present anywhere in the repo is Admin@2026! (unburned), while admin@2024! IS burned but no longer appears anywhere. The remediation burned the value purged from CLAUDE.md and missed the one still sitting in a tracked file.
4. Reachability demonstrated, not asserted. main.py:66 gates both seed_admin_user() and seed_super_admin() behind APP_ENV != "production", so neither runs on a client VM. No admin-bootstrap procedure is documented anywhere -- grep across deploy/ and all root *.md for "first admin|bootstrap|create the admin|create_admin" returns ZERO hits. create_admin.py is genuinely the only thing in the repo that creates a first admin. Dockerfile.prod:54 is "COPY . ." so the script ships inside the prod image; "docker exec ems_backend python create_admin.py" is available exactly like the documented rotate_admin_password.py invocation.
5. Escalation path confirmed: main.py:109-122 seed_super_admin looks up admin@emsclaims.co.za by email and unconditionally sets role=SUPER_ADMIN plus rule_builder permission. Any instance ever restarted with APP_ENV != production promotes the account this script created.

NO GUARD PREVENTS IT: no middleware/dependency is involved -- this is an offline CLI script run against the DB directly, so the middleware chain and route dependencies are irrelevant to it. It is not on the already-fixed or deliberate lists.

ONE SUB-ASSERTION REFUTED (does not change the verdict): the claim that "the rotation tool would happily accept Admin@2026! as the new password since it is not in BURNED" is wrong. Admin@2026! is 11 characters and fails MIN_LEN=12 at rotate_admin_password.py:29, so it would be rejected -- but accidentally by length, not by the burned check. Variants clearing 12 chars pass. The BURNED gap is real; only this specific exploitation is incidentally blocked.

ADDITIONAL (beyond the claim): create_admin.py sets permissions=None while the dev seeder sets bhf_practice_number="0000000" and omits it, so the two bootstrap paths produce differently-shaped admin rows.

Severity medium is fair, arguably medium-high for this audit: hits category (

</details>

---

### Per-instance values that would be silently inherited from our .env.prod, including the Google Maps key baked into image layers as a build arg

- **Severity:** medium · **Category:** secret-config · **Lens:** deploy-readiness
- **Location:** `docker-compose.prod.yml:93`

**Impact.** Copying .env.prod to the client box is the path of least resistance and nothing detects it. Sharing SECRET_KEY means a token minted on our instance authenticates on the client's — a direct tenant-boundary crossing. Sharing ENCRYPTION_KEY means either instance can decrypt the other's stored provider SMTP passwords. Sharing the Maps key means either the client's maps break (if we referrer-restrict to portal.emsmca.co.za) or an unrestricted key sits in the client's public JS bundle billing our Google account. Because the key is a build arg it also survives in the image's layer metadata, so it leaks to anyone who can pull or `docker history` the image, not just to browser users. Sharing AZURE_SAS_URL would write the client's patient backups into our storage container.

<details><summary>Evidence</summary>

```
docker-compose.prod.yml:93-95 passes the Maps key as a build arg, which persists in image history and in the shipped JS bundle:

      args:
        VITE_API_URL: /api
        VITE_GOOGLE_MAPS_KEY: ${VITE_GOOGLE_MAPS_KEY}

and the runbook reads it straight out of our production env file (deploy/GO-LIVE-RUNBOOK.md:138):

    sudo VITE_GOOGLE_MAPS_KEY="$(sudo grep -oP '(?<=VITE_GOOGLE_MAPS_KEY=).*' /opt/ems/.env.prod)" docker compose ... up -d --build

while restricting that key is deferred to after go-live (GO-LIVE-RUNBOOK.md:111): "Restrict the Google Maps API key by HTTP referrer to portal.emsmca.co.za".

The values that MUST be regenerated per instance, none of which any script or check enforces: SECRET_KEY (config.py:52), ENCRYPTION_KEY (config.py:127), POSTGRES_PASSWORD + DATABASE_URL (config.py:20 defaults to `postgresql+asyncpg://ems_admin:ems_secure_2024@localhost:5432/ems_claims`), RABBITMQ_PASS + CELERY_BROKER_URL (config.py:37 defaults to `amqp://ems_rabbit:rabbit_secure_2024@localhost:5672//`), FRONTEND_URL / CORS_ORIGINS / PUBLIC_APP_URL, nginx server_name + cert paths, VITE_GOOGLE_MAPS_KEY, the admin account credential, AZURE_SAS_URL and HEALTHCHECK_URL in /etc/default/ems-backup, the deploy SSH key, and the LLAMA_CLOUD/MISTRAL/CLAID/INFOBIP/TWILIO keys (shared keys mean the client's usage bills and rate-limits against our accounts).
```

</details>

**Recommended fix.** Add a bootstrap script that generates SECRET_KEY, ENCRYPTION_KEY, POSTGRES_PASSWORD and RABBITMQ_PASS and writes a fresh .env.prod, plus a preflight check that refuses to start if any secret matches a known template value or a recorded fingerprint of our own. Move VITE_GOOGLE_MAPS_KEY to runtime config fetched from /api rather than a build arg, and issue a separate referrer-restricted key per instance.

<details><summary>Independent verification</summary>

CONFIRMED. Every cited line matches the source verbatim: docker-compose.prod.yml:93-95 passes VITE_GOOGLE_MAPS_KEY as a build arg; deploy/GO-LIVE-RUNBOOK.md:138 greps it straight out of /opt/ems/.env.prod; GO-LIVE-RUNBOOK.md:111 defers referrer-restricting the key to "After go-live (same day, not urgent)"; config.py:20 and :37 contain the literal ems_secure_2024 / rabbit_secure_2024 credential defaults; config.py:52 SECRET_KEY and config.py:135 (claim says 127 -- minor citation error) ENCRYPTION_KEY are required-no-default.

No guard exists. deploy/scripts/verify-security.sh audits SSH/ufw/fail2ban/open ports/certs/backups and never checks secret uniqueness or placeholder values. config.py has no validator rejecting the shipped defaults, so a missing env var silently falls back to embedded credentials. .env.prod.template is documentation not enforcement, and is incomplete -- it omits VITE_GOOGLE_MAPS_KEY, PUBLIC_APP_URL, AZURE_SAS_URL, HEALTHCHECK_URL, INFOBIP_*, TWILIO_*, SEED_ADMIN_PASSWORD. nginx/nginx.conf:23,48,50-51 hardcodes server_name portal.emsmca.co.za / 172.209.218.22 and the Let's Encrypt cert paths with no parameterization. Grepping all .md for "new client / second instance / per-instance / new tenant / fresh instance" returns zero hits: there is no second-instance provisioning procedure anywhere, so copying .env.prod really is the path of least resistance.

The tenant-crossing impact is understated rather than overstated: auth.py:171 mints data={"sub": str(user.id)} -- an integer PK. Both instances number users from 1 and seed_super_admin() promotes admin@emsclaims.co.za (user 1) to SUPER_ADMIN, so a shared SECRET_KEY yields a token that resolves to a real super-admin on the other instance by construction, not by lucky collision.

Two evidence errors that do not change the verdict: (1) "survives in the image's layer metadata / docker history / anyone who can pull the image" is wrong for this Dockerfile -- frontend/Dockerfile.prod:26-27 declares the ARG/ENV only in build stage 1, while the shipped image is stage 2 (nginx:1.27-alpine) which declares neither, so docker history on the final image will not show it; there is also no registry push (deploy.yml:86 and runbook:138 both build on the VM), so no pull path exists. The exposure is nonetheless real by a simpler route the claim under-uses: frontend/index.html:15-19 substitutes %VITE_GOOGLE_MAPS_KEY% into the served HTML, publicly readable by any browser. (2) "shipped JS bundle" -- it lands in index.html, not the JS bundle. Also a nuance on "the admin account credential": main.py:70 gates seeding behind APP_ENV and main.py:85 DEV_SEED_ADMIN_PASSWORD is dev-only, so a fresh prod instance does not auto-seed an admin -- inheritance there would come from copying a DB, not .env.prod.

None o

</details>

---

### Unbounded list queries on growing tables: /api/authorization/queue (cases, plus N+1), /api/failed-prfs, /api/documents/export-spreadsheet

- **Severity:** medium · **Category:** availability · **Lens:** availability
- **Location:** `backend/app/api/authorization.py:300`

**Impact.** /api/authorization/queue is the worst: at 10k unauthorised cases it issues 10,001 queries in a single request and serialises the whole result into JSON. It will time out behind nginx (proxy_read_timeout) long before that, and because it holds a pooled connection for the duration it starves DB_POOL_SIZE=20 for everyone else. /api/documents/export-spreadsheet loads every document row including full `extracted_data` JSON into memory. These are the endpoints that go from "fine in the pilot" to "page never loads" somewhere between 5k and 20k records — i.e. within the first year on the client VM.

<details><summary>Evidence</summary>

```
@router.get("/queue")
async def get_auth_queue(...):
    result = await db.execute(
        select(Case)
        .where(and_(or_(Case.preauth_number == None, Case.preauth_number == ""), ...))
        .order_by(Case.created_at.desc())
    )
    cases = result.scalars().all()
    for c in cases:
        auth_result = await db.execute(
            select(SchemeAuthRequest).where(SchemeAuthRequest.case_id == c.id)
            .order_by(SchemeAuthRequest.requested_at.desc()).limit(1)
        )

No LIMIT, no OFFSET, and one extra round-trip per row. Same pattern elsewhere:
- failed_prfs.py:149 — `select(DigitalPRF).where(or_(status == FAILED, _stuck_condition())).order_by(...)` then `result.scalars().all()`, no limit, on digital_prfs.
- documents.py:543 — `query = select(Document).order_by(Document.created_at.desc())` then `.all()`, no limit, on documents.
- adjudication.py:576 — `select(RFI).join(Claim).join(Case).outerjoin(Document).order_by(RFI.created_at.desc())`, no limit, on rfis.
- documents.py:519 — reprocess-pending loads all PENDING/FAILED docs and fires `.delay()` per row.
cases.py:169 and providers.py:1477 do it correctly with offset/limit, which shows the intended pattern.
```

</details>

**Recommended fix.** Add `skip`/`limit` with a hard server-side maximum to all four, plus a companion `/count` (cases.py:200 already models this). Replace the auth-queue N+1 with a single lateral/window query. Stream or background the spreadsheet export rather than building it in-request.

<details><summary>Independent verification</summary>

Code matches the claim at every cited line. authorization.py:314-341 does select(Case) with no limit/offset then a per-row SchemeAuthRequest query inside the loop (real N+1). failed_prfs.py:131-150, documents.py:543-548 and adjudication.py:576-590 all end in .scalars().all()/.all() with no limit on tables that grow one row per call (prf_processing.py:231/261 creates a Case AND a Document with full extracted_data for every submitted Digital PRF). No mitigation neutralises it: all five are behind Depends(get_current_user) (staff-only, so not anonymous DoS, but still a real availability/pool problem); ResponseCacheMiddleware caches /api/authorization 20s and /api/failed-prfs 30s but that caps only repeat cost, is invalidated by any write to the prefix, and is explicitly cache-busted by the frontend caller (Cases.tsx:453 `?cb=${Date.now()}`); /api/adjudication and /api/documents are not in CACHE_RULES at all. There is no statement_timeout or command_timeout anywhere — database.py:43-53 sets pool params only — and DB_POOL_SIZE=20 (config.py:31) is confirmed, so the pool-starvation mechanism is as described. cases.py:169 with skip/limit=50 confirms the intended pattern. Two calibration corrections, neither of which refutes: (1) the documents.py:519 reprocess-pending sub-bullet IS guarded — lines 508-512 raise 503 unless OCR_INTAKE_ENABLED, which defaults False in config.py:82 and .env.example:75, so it is inert on a fresh client VM until the flag is flipped; (2) the two endpoints the claim calls worst have no frontend caller — grep of frontend/src finds only POST /api/authorization/request/{caseId} and no reference to the queue response shape (latest_request/auth_flag_reason), and no caller for export-spreadsheet — so "page never loads" literally applies instead to /api/adjudication/rfis (fetched unfiltered on Cases page load, returns every RFI ever created including resolved, plus an outerjoin(Document) that row-multiplies) and /api/failed-prfs. The structural defect, the affected files and the fix are unchanged; medium severity stands.

</details>

---

### ResponseCacheMiddleware stores full response bodies in an unbounded dict with no eviction

- **Severity:** medium · **Category:** availability · **Lens:** availability
- **Location:** `backend/app/core/response_cache.py:119`

**Impact.** Entries whose key is never requested again — which is the normal case for a per-session, per-PRF key — are never freed. Over a shift, hundreds of crew sessions × their PRF detail responses (hundreds of KB each with signatures) accumulate in the uvicorn worker's heap. The prod container is capped at 2G (docker-compose.prod.yml `memory: 2G`), so this ends in an OOM kill of the API mid-shift rather than a graceful degradation. Secondarily, it means plaintext PHI accumulates unboundedly in process memory.

<details><summary>Evidence</summary>

```
def _set_cached(self, key: str, body: bytes, headers: list, ttl: int, path: str = "", auth_fp: str = "") -> None:
        self._store[key] = {
            "body": body,
            "headers": headers,
            "expires": time.monotonic() + ttl,
            ...
        }

There is no max size and no sweeper. The only deletion paths are `_get_cached`, which evicts one entry and only when that exact key is requested again after expiry:
        if time.monotonic() > entry["expires"]:
            del self._store[key]
and `_invalidate_prefix`, which fires only on a write to a matching prefix. The key includes a per-session token hash (`_make_key`, line 85), so every distinct crew session mints its own entries, and `/api/digital-prf` is a cached prefix (CACHE_RULES line 25) whose detail responses embed five base64 PNG signature fields.
```

</details>

**Recommended fix.** Cap the store (LRU with a max entry count and a max total byte budget), or move it onto the Redis instance that is already running for the rate limiter — Redis is configured with `--maxmemory 128mb --maxmemory-policy allkeys-lru` and would bound this correctly. At minimum add a periodic sweep of expired entries.

<details><summary>Independent verification</summary>

The code says exactly what the claim says, and nothing guards it. Verified in backend/app/core/response_cache.py: `_store` is a plain dict (line 56) with no max size, no LRU and no sweeper; `_set_cached` (119) inserts unconditionally; the only deletions are lazy expiry in `_get_cached` (114-116, requires the same key to be re-requested after expiry) and `_invalidate_prefix` (95-108, write-triggered only). `_make_key` (85-88) hashes the FULL Authorization header, so each session — and each 60-minute access-token rotation (config.py:54 ACCESS_TOKEN_EXPIRE_MINUTES=60) — mints a new key namespace whose predecessors are orphaned forever on any prefix that gets no writes. `/api/digital-prf` is a cached prefix (line 25) and GET /{prf_id} does return all five base64 signature fields plus full form_data (digital_prf.py:1445-1449). Registered unconditionally at main.py:219; a grep for `_store` outside the module finds only the logout purge, so no sweeper exists anywhere. The docker-compose.prod.yml comment claiming Redis backs "the response cache" is stale — this cache is process-local. Gunicorn runs 4 workers with no --max-requests (backend/Dockerfile.prod) and restart: unless-stopped, so workers are never recycled to reclaim it. Not on the already-fixed or deliberate lists; the fixed-list item covers the logout purge existing, not bounding the store.

The claim does overreach on impact, and severity should be adjusted rather than the finding dropped. The OOM-mid-shift figure is asserted, not demonstrated: no entry count and no signature byte size were measured, and the byte math leans on /api/digital-prf, which is precisely the prefix that `_invalidate_prefix` wipes wholesale on every POST/PATCH/DELETE beneath it — and crew autosave PATCH /api/digital-prf/{id} (digital_prf.py:345, updating the signature fields at 426-427) is the highest-frequency write in the application, so that prefix is churned continuously in every worker serving traffic. The durable growth is instead the orphaned hourly/per-session fingerprint namespaces on write-free prefixes (/api/rate-schemas 300s, /api/users, /api/providers, /api/analytics), whose bodies are small JSON: a slow leak over days, not a 2G exhaustion within a shift.

What keeps this a real finding for a client-tenant deployment is the claim's secondary point, which is the stronger one: expired entries holding plaintext PHI (patient names, ID numbers, clinical notes, signature images) are never reclaimed on TTL expiry, and purge_session_cache (196-204) clears only the fingerprint of the token presented at logout, in the single worker that handled that request — prior hourly fingerprints of the same user, and that same user's entries in the other three workers, all survive. So: confirm the defect, reclassify it as a bounde

</details>

---

### XSS middleware regex-scans up to 1 MB of every JSON body on the event loop, and false-positives on base64 signatures

- **Severity:** medium · **Category:** input-validation · **Lens:** availability
- **Location:** `backend/app/middleware/sanitization.py:106`

**Impact.** Two problems. (1) Correctness: with five padded signature blobs per PRF the collision chance is roughly 1 in 800 submissions — a crew's completed PRF is rejected with "Potentially unsafe content detected", non-deterministically and unreproducibly, at handover. (2) Performance: ten regex passes over up to 1 MB run synchronously in middleware on every autosave from every tablet, blocking the event loop for all users. And the `< 1_000_000` guard means the largest bodies — the ones most worth scanning — silently skip the check entirely, so the protection is inverted.

<details><summary>Evidence</summary>

```
if request.method in ("POST", "PUT", "PATCH"):
            if "application/json" in content_type and path not in _SKIP_BODY_SCAN_PATHS:
                    body = await request.body()
                    if body and len(body) < 1_000_000:  # Skip huge payloads
                        body_data = json.loads(body)
                        if _scan_value(body_data):
                            return JSONResponse(status_code=400, content={"detail": "Potentially unsafe content detected in request body."})

`_scan_value` recurses every string through all ten XSS_PATTERNS. One of them is:
    re.compile(r'on\w+\s*=', re.IGNORECASE),  # onclick=, onerror=, etc.
PRF saves carry `patient_signature`, `witness_signature`, `handover_signature`, `crew_signature`, `valuables_signature` — base64 PNG data URLs (digital_prf.py model lines 122-126). Base64 padding is a literal `=`, so any blob whose final characters before the pad are `on` + one word char matches `on\w+\s*=` and the save is rejected.
```

</details>

**Recommended fix.** Scan only string fields that can be rendered as HTML, skip known base64/data-URL fields by key or by a `data:` prefix check, anchor the `on\w+=` pattern to a tag context, and either offload the scan with `asyncio.to_thread` or drop it in favour of output-side escaping. The >1 MB skip should fail closed, not open.

<details><summary>Independent verification</summary>

CONFIRMED, and the correctness impact is ~7x worse than claimed; the performance impact is overstated.

CODE VERIFIED AS QUOTED
- backend/app/middleware/sanitization.py:105-121 matches the evidence verbatim, including `len(body) < 1_000_000` and `on\w+\s*=` (line 19).
- XSSProtectionMiddleware IS registered (backend/app/main.py:211), and app/middleware/__init__.py maps it to sanitization.py.
- _SKIP_BODY_SCAN_PATHS (lines 81-83) contains ONLY "/api/documents/upload".

PATH IS REACHABLE AND IS THE PRF HOT PATH
- frontend/src/pages/crew/prfSaveContract.ts:70 spreads all five signature keys into the PATCH body (`...s.sigs`).
- Sent as application/json to PATCH /api/digital-prf/{prfId} (DigitalPRFForm.tsx:5166 autosave, :5925 pre-submit authoritative save, :6034 offline-drain create). Router prefix confirmed at app/api/digital_prf.py:32; PATCH route at :345.
- FullscreenSignaturePad.tsx:251 emits canvas.toDataURL('image/png').
- No middleware or dependency intercepts first: ResponseCache is GET-only, RateLimit/CrashHandler do not inspect bodies.

THE CLAIM'S MECHANISM IS WRONG BUT ITS CONCLUSION IS RIGHT, AND THE RATE IS MUCH HIGHER
The claim asserts the match needs "on" + one word char immediately before the pad. That is not how the regex behaves: `\w+` is unbounded and 62 of the 64 base64 characters are word chars (only + and / break a run), so the word-char run terminating at the `=` pad averages ~50 chars. The literal on/On/oN/ON can sit anywhere inside that run. The fixed PNG trailer encodings (...AAAABJRU5ErkJggg== and ...AAAAASUVORK5CYII=) are entirely word chars, so the run always extends backwards through them into the random deflate-tail/adler32/IDAT-CRC bytes.

MEASURED (I generated PNGs and ran the actual pattern):
- Synthetic 600x200 RGBA signature PNGs (sparse ink strokes, n=1500): 1.20% per blob -> 5.9% of PRFs carrying five signatures.
- Uniformly random PNG payloads (n=20000): 3.03% per blob -> 14.3% per PRF.
So roughly 1 in 17 completed PRFs, not 1 in 800.

WORSE THAN "NON-DETERMINISTIC": once a poisoned signature blob is captured it is a fixed string, so every subsequent autosave AND the pre-submit PATCH return 400 permanently for that PRF. classifySaveError (prfSaveContract.ts) routes 400 to the default 'queue' branch, so the outbox retries the identical payload forever and the PRF can never be submitted.

WIDER THAN STATED: form_data also carries fd.crew_signoff_sigs (DigitalPRFForm.tsx:9326) and fd.tc_patient_signature (:8757) - more PNG data URLs beyond the five - so a multi-crew call exceeds 5.9%.

TWO CORRECTIONS THAT NARROW THE CLAIM
1. JPEG blobs are IMMUNE. Every JPEG ends FF D9, whose base64 tail is .../9k= or .../2Q== ; the `/` is not a word char and truncates the run to 2 chars. Measured 0/20000. So DocumentsCapture.tsx, Pa

</details>

---

### create_prf accepts another provider's vehicle_id and crew_member_2_id without the ownership check save_prf performs

- **Severity:** medium · **Category:** tenant-isolation · **Lens:** availability
- **Location:** `backend/app/api/digital_prf.py:293`

**Impact.** A crew member can create a PRF bound to a different company's ambulance and a different company's paramedic, and the value persists (both are real FKs). Billing attribution, vehicle utilisation reporting and the "in use" dashboard in providers.py:1256 are all corrupted across the tenant boundary, and the foreign crew member's full name is then echoed back in the PRF list and detail responses. save_prf blocks exactly this; create_prf is the hole.

<details><summary>Evidence</summary>

```
prf = DigitalPRF(
        provider_id=crew.provider_id,
        crew_member_1_id=crew.id,
        crew_member_2_id=uuid.UUID(body.crew_member_2_id) if body.crew_member_2_id else None,
        vehicle_id=uuid.UUID(body.vehicle_id) if body.vehicle_id else None,
        ...
    )

No `_assert_provider_owns` call. The helper exists at line 202 with the comment "Used to stop a crew from attaching another company's vehicle or crew member to their PRF (which would corrupt tenant isolation and billing attribution)" and is invoked only from save_prf, lines 438 and 443:
            await _assert_provider_owns(db, Vehicle, new_vehicle_id, crew.provider_id, "vehicle")
            await _assert_provider_owns(db, CrewMember, new_c2, crew.provider_id, "crew member")
The crew-name resolution that reads it back is also unscoped — line 1354:
            c2 = await db.execute(select(CrewMember.full_name).where(CrewMember.id == p.crew_member_2_id))
```

</details>

**Recommended fix.** Call `_assert_provider_owns` for both ids in create_prf before constructing the row, and guard the two `uuid.UUID(...)` conversions so a malformed id returns 422 rather than 500. Scope the crew-name lookups at lines 1352-1356 by `provider_id == crew.provider_id`.

<details><summary>Independent verification</summary>

The code says what the claim says, and no guard prevents it.

CONFIRMED BY DIRECT READ:
- backend/app/api/digital_prf.py:293-302 create_prf builds DigitalPRF with crew_member_2_id and vehicle_id taken verbatim from the request body, with no ownership validation.
- PRFCreateRequest (lines 37-61) types both as bare `str | None` with no pydantic validator.
- The router (line 32) declares no `dependencies=`, and app/main.py:262 includes it plainly, so there is no route-level or middleware guard. get_current_crew is authn-only: it yields the caller's own provider_id and never inspects the body. ResponseCacheMiddleware is irrelevant here (POST, not a cache-served GET).
- grep of the entire backend for `_assert_provider_owns` returns exactly 3 hits: the definition at line 202 and the two call sites at 438 and 443, both inside save_prf. git log -S confirms the helper landed in b76b69d wired only into the PATCH path; neither b69ea03 (client-supplied ids) nor b3b1d70 (tenant-leak fixes) extended it to create_prf. So this is a never-covered gap, not an already-fixed item.
- No DB backstop: app/models/digital_prf.py declares plain single-column FKs to vehicles.id and crew_members.id (no composite (provider_id, id) FK), so a foreign-tenant UUID commits successfully and persists.
- Readback is genuinely unscoped: list_prfs line 1354-1356 selects CrewMember.full_name by id with no provider filter, and the detail endpoint does the same for crew (line ~1595) and vehicle (line 1601, returning callsign/registration/vehicle_type). A foreign tenant's crew name and vehicle identifiers are echoed back to the attacker.
- Not on the deliberate or already-fixed list; the path is reachable (POST /api/digital-prf with any authenticated crew session).

ONE PART OF THE CLAIMED IMPACT IS WRONG and should be corrected in the writeup: the "in use" dashboard in providers.py list_vehicles is NOT corrupted. Its in_use_ids subquery filters DigitalPRF.provider_id == pid, so a foreign vehicle bound to the attacker's PRF carries the attacker's provider_id and never surfaces on the victim's dashboard, nor matches any vehicle in the attacker's own list. Billing/utilisation attribution stored on the DigitalPRF row itself is still wrong, and the name/registration echo is a real cross-tenant read.

SEVERITY CALIBRATION: exploitation requires already possessing a valid vehicles.id or crew_members.id belonging to another provider; UUID4 is unguessable and the prior tenant-isolation work (17/0 cross-tenant leaks) does not hand those out. That bounds this to medium, matching the claim. It remains worth hardening before the client VM deployment: the sibling write path on the same two columns already enforces the invariant, so this is an inconsistent enforcement of an established tenant-boundary rule

</details>

---

### Celery publish is a blocking socket call inside the async submit route; broker downtime stalls the event loop

- **Severity:** medium · **Category:** availability · **Lens:** availability
- **Location:** `backend/app/api/digital_prf.py:1292`

**Impact.** When RabbitMQ is down or slow, each submit blocks the whole event loop for up to ~16 seconds — not just the submitting crew, but every other request the worker is serving. At shift change, when submits cluster, the API appears completely dead rather than degraded. The compensating logic in this route is otherwise good (status reverted to DRAFT, 503 returned), but the two failed_prfs call sites have no handler: a broker outage there produces an unhandled exception and a 500 after the DB has already been committed.

<details><summary>Evidence</summary>

```
try:
        process_prf_submission.apply_async(args=[str(prf.id)], queue=target_queue)
    except Exception as enqueue_err:
        ...
        prf.status = PRFStatus.DRAFT
        prf.submitted_at = None
        await db.commit()
        raise HTTPException(status_code=503, detail="Could not queue PRF for processing. Please try submitting again.")

`apply_async` is synchronous kombu I/O called without `await` from an `async def` route. celery_app.py sets no `broker_connection_timeout` or `broker_transport_options`, so Celery's defaults apply (4s connect timeout, publish retried up to 3 times).

The same call appears twice more with no try/except at all — failed_prfs.py:339 (`process_prf_submission.delay(str(corrected_prf.id))`) and failed_prfs.py:409 in reprocess.
```

</details>

**Recommended fix.** Wrap the publish in `asyncio.to_thread(...)`, set an explicit short `broker_transport_options={'max_retries': 1}` plus `broker_connection_timeout`, and give the failed_prfs enqueues the same try/except-and-revert treatment the submit route has.

<details><summary>Independent verification</summary>

Every element of the claim verified against the code; nothing mitigates it.

1) digital_prf.py:1199-1292 — route is `async def submit_prf` under `@router.post("/{prf_id}/submit", status_code=202)`. Line 1292 is `process_prf_submission.apply_async(args=[str(prf.id)], queue=target_queue)` with no `await`, no `asyncio.to_thread`, no `run_in_threadpool`. This is synchronous kombu socket I/O executed directly on the event loop. The quoted try/except (revert to DRAFT, clear submitted_at, commit, 503) is verbatim correct.

2) celery_app.py read in full — conf.update sets only serializers, DLQ queues, task_time_limit/soft limit, worker events and beat schedule. No broker_connection_timeout, no broker_transport_options, no task_publish_retry_policy. A repo-wide grep for broker_connection|broker_transport_options|task_publish_retry|broker_pool_limit|task_always_eager across .py/.yml/.yaml/.txt/.env* returned ZERO hits. requirements.txt pins celery==5.4.0 / kombu==5.4.2, so stock defaults apply: 4s connect timeout, task_publish_retry=True, retry policy max_retries=3 (interval_start 0, step 0.2, max 0.2) => 4 attempts x 4s + ~0.6s ≈ 16.6s worst case. The claim's ~16s figure is arithmetically correct.

3) failed_prfs.py:339 (`process_prf_submission.delay(str(corrected_prf.id))` in the correction endpoint) and failed_prfs.py:409 (in reprocess_failed_prf) confirmed bare — no try/except — and both sit immediately after an `await db.commit()`. A broker failure there propagates to CrashHandler and returns 500 with the DB already mutated (original.status=CORRECTED and new corrected_prf persisted; or prf.status=SUBMITTED with processing_attempts reset). Exactly as claimed.

4) No guard/middleware/dependency prevents this. The chain (ErrorLogging -> CORS -> RateLimit -> XSSProtection -> CrashHandler) is all ASGI middleware running in the same event loop; it cannot un-block the loop, and CrashHandler only converts the unhandled exception to a 500 after the fact. ResponseCacheMiddleware is irrelevant (POST /submit is not a cached GET). Route deps get_current_crew/get_db do not touch the broker.

5) The codebase demonstrably knows the correct pattern and did not apply it at the enqueue sites: providers.py:340 and utils/net_guard.py:104 both wrap blocking sync work in `await asyncio.to_thread(...)`. The Celery publishes do not.

6) Paths are reachable: submit is the primary crew submit endpoint; the failed_prfs endpoints are live admin routes behind get_current_user.

Additional unguarded sites the claim did not list (strengthening it): documents.py:353 and documents.py:524, the latter calling preprocess_document.delay inside a `for doc in stuck_docs` loop, so a broker stall multiplies by the number of stuck docs. documents.py:154 IS correctly wrapped in try/except with a co

</details>

---

## LOW (11)

### Unauthenticated outbound geocoding proxy

- **Severity:** low · **Category:** availability · **Lens:** authz
- **Location:** `backend/app/api/geocode.py:8`

**Impact.** Anyone can use the client's server as a free anonymising relay to Nominatim under the shared "EMS-Forms-Claim-Adjudication/1.0" User-Agent. Nominatim's usage policy is enforced by UA/IP, so third-party abuse gets the client's geocoding blocked for real crews mid-call, and each request holds a backend worker for up to 5 s.

<details><summary>Evidence</summary>

```
@router.get("/{query}")
async def geocode_query(query: str):
    """Proxy to OpenStreetMap Nominatim. Bypasses browser CORS rules and user-agent restrictions."""

No auth dependency; mounted at /api/geocode (main.py:258) and so publicly proxied. The destination host is hard-coded, so this is not SSRF — net_guard is not needed here.
```

</details>

**Recommended fix.** Add Depends(get_current_crew) or get_current_user — the only legitimate callers are logged-in crew typing an address.

<details><summary>Independent verification</summary>

low severity, reported as-is

</details>

---

### Crash reporter hand-decodes the JWT and cannot tell a crew or portal token from a User token

- **Severity:** low · **Category:** input-validation · **Lens:** authz
- **Location:** `backend/app/api/crashes.py:76`

**Impact.** Optional auth here is deliberate, so the missing blacklist/is_active checks are harmless (nothing is returned). The scope confusion is not: any caller presenting a crew or portal-grant token makes the insert violate the FK, so the crash reporter itself 500s and the report is lost. Today ErrorBoundary.tsx:31 only attaches `access_token`, so crew-PWA crashes merely arrive unattributed — but the crew app is the surface that crashes in front of patients, and the moment anyone attaches crew_token there its telemetry disappears silently (the caller .catch()es and swallows the error).

<details><summary>Evidence</summary>

```
payload = jose_jwt.decode(
    auth_header.split(" ", 1)[1],
    _settings.SECRET_KEY,
    algorithms=[_settings.ALGORITHM],
)
uid = payload.get("sub")
if uid:
    user_id = uuid.UUID(uid)

This verifies the signature and nothing else — no type check, no token_scope check, no blacklist, no user-exists, no is_active. But `sub` is not always a users.id: crew_auth.py:451 sets `"sub": str(crew.id)` and crew_auth.py:376 sets `"sub": str(provider.id)`, while CrashEvent.user_id is `ForeignKey("users.id")` (models/crash_event.py:60).
```

</details>

**Recommended fix.** Only attribute when `payload.get("type") == "access" and payload.get("token_scope") != "crew"`, and wrap the insert so an unresolvable subject records the crash with user_id=None instead of failing.

<details><summary>Independent verification</summary>

low severity, reported as-is

</details>

---

### GET /api/users/{user_id} is the only users endpoint without an admin gate

- **Severity:** low · **Category:** authz · **Lens:** tenant-isolation
- **Location:** `backend/app/api/users.py:106`

**Impact.** Any authenticated back-office account — including the lowest-privileged PARAMEDIC or BILLING_CLERK — can walk user ids and map the entire staff directory: who is an admin, who holds rule_builder or tariff_billing, and which accounts are inactive. That is precise target selection for a follow-on credential attack, and it is a plain inconsistency with the rest of the router rather than a deliberate exception.

<details><summary>Evidence</summary>

```
@router.get("/{user_id}", response_model=UserResponse)
async def get_user(
    user_id: str,
    db: AsyncSession = Depends(get_db),
    _current: User = Depends(get_current_user),
):

Every sibling in the file uses require_role(UserRole.ADMIN) (lines 32, 58, 96, 123, 162). The response includes the full profile (_user_response, lines 18-29): email, full_name, role, bhf_practice_number, is_active and the complete permissions list.
```

</details>

**Recommended fix.** Change the dependency to require_role(UserRole.ADMIN, UserRole.SUPER_ADMIN), or restrict the handler to `user_id == _current.id` if the intent was self-profile lookup (which /api/auth/me at auth.py:295 already covers).

<details><summary>Independent verification</summary>

low severity, reported as-is

</details>

---

### GET /api/failed-prfs returns every failed and stuck PRF with no limit

- **Severity:** low · **Category:** availability · **Lens:** tenant-isolation
- **Location:** `backend/app/api/failed_prfs.py:120`

**Impact.** Across all providers over a seven-year retention window this loads every failed and stuck PRF into memory on a single request, signatures included. During an incident — precisely when this page gets opened, and when the failed count is highest — the query balloons and can push the backend into memory pressure or a timeout, taking down the tool needed to diagnose the incident. The correct pattern already exists a few files away.

<details><summary>Evidence</summary>

```
query = (
        select(DigitalPRF)
        .where(
            or_(
                DigitalPRF.status == PRFStatus.FAILED,
                _stuck_condition(),
            )
        )
        .order_by(DigitalPRF.last_processing_at.desc().nullsfirst())
    )
    ...
    result = await db.execute(query)
    prfs = result.scalars().all()

No .offset()/.limit() anywhere, and full ORM rows are loaded — each DigitalPRF carries the form_data blob and five base64 signature columns. The response then derives patient names from that blob:

            "patient_name": (
                (prf.form_data or {}).get("patient_name", "")
                + " "
                + (prf.form_data or {}).get("patient_surname", "")
            ).strip(),

The provider-scoped equivalent at providers.py:1416-1478 does this correctly: it selects summary columns only, paginates with skip/limit, and explains why ("full rows carry five base64 signatures each, which would bloat a list response badly").
```

</details>

**Recommended fix.** Mirror list_provider_prfs: select only the summary columns, add skip/limit with an X-Total-Count header, and keep the existing search filter.

<details><summary>Independent verification</summary>

low severity, reported as-is

</details>

---

### The billing worker has no status guard — it will process a PRF that is still a DRAFT

- **Severity:** low · **Category:** data-integrity · **Lens:** data-integrity
- **Location:** `backend/app/tasks/prf_processing.py:152`

**Impact.** The crew is told "Could not queue PRF for processing. Please try submitting again", goes back to editing a PRF that reads as an editable draft, and meanwhile the worker bills it from the half-finished snapshot. Their subsequent edits are then rejected with 423 against a record that has already gone to the scheme.

<details><summary>Evidence</summary>

```
```python
                if prf.status == PRFStatus.PROCESSED or prf.case_id is not None:
                    ... skip
```

That is the only status check; DRAFT proceeds to Case/Document/Claim creation and is force-set to PROCESSED. The submit endpoint can leave a PRF in DRAFT while its task is live on the broker:

```python
    try:
        process_prf_submission.apply_async(args=[str(prf.id)], queue=target_queue)
    except Exception as enqueue_err:
        prf.status = PRFStatus.DRAFT
        prf.submitted_at = None
        await db.commit()
```

Any failure *after* the message is published (connection reset on confirm, timeout) reverts the row while the task still runs.
```

</details>

**Recommended fix.** Have the worker require `status in (SUBMITTED, FAILED)` before processing and return `not_submitted` otherwise; the watchdog and the admin retry both set SUBMITTED first, so nothing legitimate is blocked.

<details><summary>Independent verification</summary>

low severity, reported as-is

</details>

---

### Unauthenticated /health exposes broker, worker and queue internals; /health/ready reports whether any account exists

- **Severity:** low · **Category:** authz · **Lens:** deploy-readiness
- **Location:** `backend/app/main.py:319`

**Impact.** Anyone on the internet can read the client instance's queue depth, worker node count, uptime and per-subsystem health, which maps the internal architecture and reveals when workers are down — useful timing information for an attacker wanting a submission to sit unprocessed. `"seeded": has_users` confirms whether the instance has been bootstrapped yet, i.e. whether the default-credential window is still open. Each request also triggers an outbound management-API call and three subsystem probes, so the endpoint is a cheap amplification target (it sits outside the /api/ limit_req zone).

<details><summary>Evidence</summary>

```
nginx proxies it with no auth and no rate-limit zone (nginx/nginx.conf):

    location /health {
        proxy_pass http://ems_api;
    }

and the response body (main.py:392-396, 433) includes:

    checks["queue"] = {"status": q_status, "depth": depth, "consumers": consumers}
    ...
    checks["celery_workers"] = f"healthy ({wc} nodes)"
    ...
    return {"ready": True, "seeded": has_users}

The handler also parses broker credentials out of CELERY_BROKER_URL and calls the RabbitMQ management API on every request (main.py:374-379).
```

</details>

**Recommended fix.** Split the probe: keep an unauthenticated liveness endpoint that returns only `{"status":"ok"}`, and require auth (or restrict to the Docker network / loopback via is_loopback_peer) for the detailed /health body. Drop `seeded` from /health/ready. Point the container HEALTHCHECK at the minimal endpoint.

<details><summary>Independent verification</summary>

low severity, reported as-is

</details>

---

### DB_SSL_MODE defaults to empty and only the exact string "require" enables TLS to the database

- **Severity:** low · **Category:** secret-config · **Lens:** deploy-readiness
- **Location:** `backend/app/config.py:25`

**Impact.** The default is plaintext. `DB_SSL_MODE=verify-full`, `=true`, `=Require`, or a trailing space all silently fall through to an unencrypted connection with no warning logged — the only positive signal is the `Database SSL: verify-full` INFO line, which nobody will notice missing at LOG_LEVEL=WARNING (which .env.prod.template sets). On a client VM where Postgres runs on the same host or a peer VM rather than Azure managed Postgres (which enforces TLS server-side), patient data and the DB password cross the network in the clear. Related: config.py:123 defaults LOG_LEVEL to "DEBUG", so an instance that does not set it logs at DEBUG in production, though sqlalchemy.engine and uvicorn.access are pinned to WARNING (logging_config.py:93-94) which limits the exposure.

<details><summary>Evidence</summary>

```
config.py:25:

    # Set to 'require' in production (Azure PostgreSQL enforces SSL).
    # Leave empty for local dev (plain Docker Postgres needs no SSL).
    DB_SSL_MODE: str = ""

database.py:38-40 is an exact string comparison:

    if settings.DB_SSL_MODE == "require":
        import ssl as _ssl
        _connect_args["ssl"] = _ssl.create_default_context()
```

</details>

**Recommended fix.** Default DB_SSL_MODE to "require", accept the standard libpq spellings (require/verify-ca/verify-full) plus a `disable` opt-out, log a WARNING whenever a non-loopback DATABASE_URL is used without TLS, and flip the LOG_LEVEL default to "INFO".

<details><summary>Independent verification</summary>

low severity, reported as-is

</details>

---

### TrustedHostMiddleware is imported but never installed — no Host header validation

- **Severity:** low · **Category:** input-validation · **Lens:** deploy-readiness
- **Location:** `backend/app/main.py:11`

**Impact.** The backend accepts any Host header. The impact is limited today because outbound links use PUBLIC_APP_URL/FRONTEND_URL rather than the request Host, and gunicorn is not internet-reachable directly — so this is defence-in-depth rather than a live exploit. It matters more per-instance: an unvalidated Host plus the ResponseCacheMiddleware sitting in front of route dependencies is the shape that turns into cache poisoning the moment any cached response starts interpolating the request host, and it also means the client instance answers to any DNS name pointed at its IP.

<details><summary>Evidence</summary>

```
main.py:11 imports it:

    from fastapi.middleware.trustedhost import TrustedHostMiddleware

but `grep -n "TrustedHostMiddleware" backend/app/main.py` shows that line is the only occurrence — it is never passed to app.add_middleware. Meanwhile nginx forwards whatever Host arrives (nginx/nginx.conf:64: `proxy_set_header Host $host;`) and the port-80 server block accepts any name (`server_name portal.emsmca.co.za 172.209.218.22 _;`).
```

</details>

**Recommended fix.** Install TrustedHostMiddleware with allowed_hosts derived from FRONTEND_URL/CORS_ORIGINS (plus localhost for in-container probes), or delete the unused import so it stops reading as implemented protection.

<details><summary>Independent verification</summary>

low severity, reported as-is

</details>

---

### 97 unguarded uuid.UUID() conversions in routers turn a malformed path parameter into a 500 plus a persisted crash row

- **Severity:** low · **Category:** input-validation · **Lens:** availability
- **Location:** `backend/app/api/digital_prf.py:1533`

**Impact.** The response body itself is safe — CrashHandlerMiddleware returns only `{"detail": "An internal error occurred...", "crash_id": ...}` with no stack trace. The damage is behind it: each one writes a CrashEvent with the full stacktrace and (per the finding above) up to 2000 bytes of request body. An attacker or a buggy client can therefore inflate crash_events without limit, drown genuine crashes in the System Health dashboard, and drive the body-capture leak deliberately. Users also see a scary 500 where a 422 is correct.

<details><summary>Evidence</summary>

```
result = await db.execute(
        select(DigitalPRF).where(DigitalPRF.case_id == uuid.UUID(case_id))
    )

`case_id: str` is an unvalidated path parameter; `uuid.UUID("abc")` raises ValueError. A grep of app/api/*.py finds 97 such conversions outside a try block — cases.py:228/248/363, claims.py:129/178/249/309, adjudication.py:105/171/183/238, documents.py:36/192/239, main.py:597, and so on. `_load_crew_prf` (digital_prf.py:182) and failed_prfs.py:192 show the correct pattern:
    try:
        pid = uuid.UUID(prf_id)
    except (ValueError, TypeError):
        raise HTTPException(400, "Invalid PRF id")
```

</details>

**Recommended fix.** Type the path parameters as `uuid.UUID` in the function signature so FastAPI returns 422 automatically, or route every conversion through a shared `_parse_uuid()` helper that raises HTTPException(400).

<details><summary>Independent verification</summary>

low severity, reported as-is

</details>

---

### Unauthenticated open proxy to OpenStreetMap Nominatim at /api/geocode/{query}

- **Severity:** low · **Category:** authz · **Lens:** availability
- **Location:** `backend/app/api/geocode.py:8`

**Impact.** Anyone on the internet can use the client's server as a free, attributable geocoding proxy. Nominatim's usage policy is enforced by IP block, so sustained abuse gets the client VM's address banned and the crew app's address lookup stops working for everyone. The `str(e)` in the error body also echoes httpx internals back to an anonymous caller. The 5s timeout is present and correct, so this is abuse rather than a hang risk.

<details><summary>Evidence</summary>

```
@router.get("/{query}")
async def geocode_query(query: str):
    """Proxy to OpenStreetMap Nominatim. Bypasses browser CORS rules and user-agent restrictions."""
    ...
        except Exception as e:
            return JSONResponse(status_code=502, content={"error": str(e), "results": []})

No `Depends(get_current_user)` and no `Depends(get_current_crew)`. Mounted at `/api/geocode` (main.py:258) and explicitly excluded from the response cache (response_cache.py:39 NEVER_CACHE), so every call goes out to the third party.
```

</details>

**Recommended fix.** Add the crew/user auth dependency, cache results in the existing Redis for a day, and replace `str(e)` with a fixed message.

<details><summary>Independent verification</summary>

low severity, reported as-is

</details>

---

### crashes.py role check excludes SUPER_ADMIN from the System Health dashboard

- **Severity:** low · **Category:** authz · **Lens:** availability
- **Location:** `backend/app/api/crashes.py:119`

**Impact.** The seeded default account is promoted to SUPER_ADMIN by `seed_super_admin` (main.py:113), so on a fresh instance the highest-privileged account is the one account that gets 403 from every crash-monitoring endpoint. On the client VM the operator most likely to be debugging a live incident cannot see the crash dashboard, resolve entries, or run the purge.

<details><summary>Evidence</summary>

```
if current_user.role.value != "admin":
        raise HTTPException(403, "Admin access required")

Repeated at lines 164, 263, 287 and 308 (list, stats, resolve, delete, purge). Elsewhere the codebase deliberately passes both roles to avoid exactly this — the exact-match behaviour of `require_role(ADMIN)` is a known trap and every other call site enumerates ADMIN and SUPER_ADMIN.
```

</details>

**Recommended fix.** Change the comparison to accept both roles, e.g. `if current_user.role not in (UserRole.ADMIN, UserRole.SUPER_ADMIN)`, in all five places.

<details><summary>Independent verification</summary>

low severity, reported as-is

</details>

---

## Refuted on independent review (12)

- **Any authenticated user can read any patient PRF and email it to an arbitrary address from the tenant's own mailbox**
  - The quoted code is accurate — the admin branch of _resolve_case_prf_access (backend/app/api/digital_prf.py:1471-1553) checks blacklist, type=="access", user exists and is_active, then stops; role is never read and no ownership predicate is applied — but the claimed impact does not follow.

(1) That branch is a faithful re-implementation of the shared get_current_user dependency (app/utils/security.py:142-189): identi
- **docker-compose.yml hardcodes the DB password in DATABASE_URL while the server takes it from an env var — every instance shares one publicly-burned credential**
  - The quoted lines exist verbatim, but the claim's file is the LOCAL-DEV compose and is not used by any deployment path, so every part of the claimed impact fails.

WRONG FILE: docker-compose.yml is the dev stack (header: "Replaces the remote Supabase instance for local development"; postgres on 5433, backend on 8001, ./backend:/app bind mounts, frontend dev port 5173). Repo-wide grep finds it referenced only in CLAUDE
- **End-shift's "has captured work" guard ignores signatures, odometers and vehicle assignment**
  - The claim's reading of the guard is textually accurate (backend/app/api/digital_prf.py:859 checks only non-supervising form_data keys plus the nine time_* columns), but the claimed data-loss path is unreachable, and part of the claim is affirmatively wrong.

1) Only two backend writers touch the columns in question. `grep "setattr(prf"` across app/ returns exactly five sites, all in digital_prf.py: save_prf (411 time
- **The only working path to a bootable fresh instance is APP_ENV=development, which seeds a source-hardcoded SUPER_ADMIN password and opens /redoc**
  - The claim's code citations are accurate but the three impacts that make it high-severity do not hold.

(1) /redoc is NOT exposed. nginx/nginx.conf proxies only `location /api/`, `/api/auth/login`, `/health`, and `^~ /uploads/`. There is no `/redoc` location, so it falls through to `location / { try_files $uri $uri/ /index.html; }` and serves the React SPA index.html — it never reaches FastAPI. The `deny all` blocks f
- **Every /api/failed-prfs endpoint is un-roled and un-tenanted — full patient form_data of all providers to any logged-in user**
  - REFUTED as stated (the "cross-tenant PHI breach" framing and the high severity). The literal code reading is accurate, but the tenant boundary the claim invokes does not exist for the token type this router accepts, and two of the specific assertions are wrong.

What the code actually says (verified):
- C:\Users\USER-PC\Desktop\New EMS AUTOMATIONS\backend\app\api\failed_prfs.py — all five endpoints (/stats:58, "" :12
- **Database and broker passwords are hard-coded in docker-compose.yml and were published while the repo was public**
  - The claim quotes the file text accurately but attributes it to the wrong deployment path, and the claimed impact is contradicted by the files that actually deploy.

WHAT IS TRUE: docker-compose.yml:75/113/169 hard-code `ems_secure_2024`; lines 30/76/114/170 carry `${RABBITMQ_PASS:-rabbit_secure_2024}`; ports 5672/15672 are unbound there; backend/app/config.py:20,37 carry the identical literals. The reading of the fil
- **The crash handler copies raw request bodies — including login passwords and patient PRF data — into crash_events, readable via GET /api/crashes**
  - REFUTED — the code at backend/app/middleware/crash_handler.py:72-77 exists exactly as quoted, but it is inert for every path the claim names. The evidence was asserted (quoted source) rather than demonstrated (executed); when executed, the body read always fails.

Mechanism the claim misses: `record_crash_event` calls `await request.body()` AFTER `call_next` has already returned/raised. In Starlette's `BaseHTTPMiddle
- **OCR Celery tasks reuse the API's module-level engine inside a fresh event loop and have no failure handler — documents strand in EXTRACTING with no recovery path**
  - REFUTED as stated — the headline ("no recovery path", "disappears into a state nothing can reach", "active data-loss path") is contradicted by code in the same file the claim cites, and the whole path is flag-off by default on a fresh deploy.

What the claim gets RIGHT (do not discard):
- backend/app/tasks/extraction.py:18-33 and backend/app/tasks/preprocessing.py:19-34 both create a fresh event loop per invocation w
- **The dead-letter queue is decorative: nothing consumes ems_dead_letter, and Celery failures never reach it**
  - The claim's mechanics are partly right but its impact — the thing that makes it a medium availability finding — is refuted by code in the same file it cites.

VERIFIED TRUE: celery_app.py:41-54 sets x-dead-letter-exchange/ems_dlx on all three queues; a repo-wide grep (all file types) for ems_dead_letter/ems_dlx hits only celery_app.py and dlq_setup.py, so nothing consumes the DLQ; and task_acks_late=True (line 32) wi
- **digital_prfs is missing indexes on status, case_id, crew_member_1_id and created_at — every hot query is a sequential scan**
  - The claim's load-bearing evidence is factually wrong, and the two most alarming impact scenarios collapse with it. A small real kernel survives (case_id), but not the defect as described.

FALSE PREMISE 1 — "The only shipped index migration ... adds just two". There are SIX index-creating statements against digital_prfs across five migrations (verified by grep over C:/Users/USER-PC/Desktop/New EMS AUTOMATIONS/backend
- **Auth rate limiting is per-IP, so one shared-NAT company gets 15 crew logins per minute total (nginx: 5/min)**
  - The claim reads the mechanism correctly but the load-bearing impact is demonstrably false. Confirmed real: rate_limit.py:110-142 keys AUTH_STRICT_PATHS ("/api/auth/login", "/api/auth/refresh", "/api/crew/login") on get_trusted_client_ip at auth_limit=15/60s (main.py:203-208), and behind NAT that resolves to one shared public IP. Refuted: crews never traverse those paths. Crew shift start is POST /api/crew/portal-unlo
- **CORS runs innermost, so every 429, 413, 400 and 500 reaches the browser without CORS headers**
  - REFUTED — the ordering observation is correct, but the claimed impact is unreachable in every shipped deployment shape, and one of its two sub-claims is factually inverted.

1) The mechanical half of the claim is TRUE. Starlette 0.52.1 `Starlette.add_middleware` does `self.user_middleware.insert(0, ...)` and `build_middleware_stack` wraps `reversed(middleware)`, so index 0 is outermost. With the add order in backend/
