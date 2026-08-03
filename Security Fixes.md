# Security Fixes — Pre-Go-Live Hardening

**Status:** CRITICAL items 1 + 2 FIXED 2026-07-23 (lockout on all three login paths;
trusted client-IP + limiter re-enabled + Redis added to prod). Items 3–8 still open.
**When to apply:** Before `portal.emsmca.co.za` is opened to external service providers.
**Owner:** Tom
**Related:** `deploy/GO-LIVE-RUNBOOK.md`, memory `project_golive_deploy`, `project_provider_authz_guard`.

> These are authentication/authorization hardening items found during the login
> code review on 2026-07-21. They were **intentionally left out** of the login
> code-cleanup pass (which only removed stale/duplicate code and fixed
> crash/robustness bugs). Each item below changes security *behavior* and needs
> its own test + review before going live. Do not tick "go live" until the two
> CRITICAL items are done.

---

## CRITICAL

### 1. Portal + crew logins have NO account lockout
The admin `User` login enforces lockout (5 fails → 45 min), but two other
password login paths have **none** — unlimited password guessing:

- **Provider portal login** — `backend/app/api/auth.py:82-98`. When the email
  matches a `ServiceProvider.portal_login_email`, the password is checked with
  no failed-attempt counter, no lockout, and no audit-log entry.
- **Crew login** — `backend/app/api/crew_auth.py:91-102`. `crew_login` verifies
  the password with no lockout and no audit entry.

**Risk:** Once these are shared with providers, every provider account and every
crew account is brute-forceable. This is the headline item.

**Fix:**
- Add `failed_login_attempts` + `locked_until` columns to `ServiceProvider` and
  `CrewMember` (mirror the `User` model), or introduce a shared lockout helper
  keyed by (identity_type, identity_id).
- Reuse `MAX_FAILED_ATTEMPTS` / `LOCKOUT_DURATION_MINUTES` from
  `app/utils/security.py`.
- Write a `LOGIN_FAILED` / `LOGIN_FAILED_LOCKED` audit entry on each path, the
  same way `_record_login_audit` does for admins.
- Remember the DB is `create_all`-managed in dev (memory
  `project_db_createall_unmanaged`) — hand-apply the ALTER, don't
  `alembic upgrade head`.

**Effort:** Medium (schema + logic + migration on 2 models).

---

### 2. Rate-limiter client IP is attacker-spoofable
`backend/app/middleware/rate_limit.py:63-67` derives the client IP from the
**first** entry of the `X-Forwarded-For` header. Nginx *appends* the real client
IP to any client-supplied XFF, so an attacker can send a different fake
`X-Forwarded-For` on every request and get a fresh rate-limit bucket each time —
the auth limit never binds. The same spoofable IP also drives the internal-IP
bypass at `rate_limit.py:122-128`, so `X-Forwarded-For: 192.168.1.1` exempts a
request from API rate limiting entirely.

Combined with item 1, this means **unlimited, un-throttled brute force** against
the provider/crew login endpoints.

Two secondary bugs in the same block:
- `client_ip.startswith("172.")` matches public ranges (e.g. Google's
  `172.217.x.x`), not just private `172.16–31.x.x`.
- `_get_client_ip` is duplicated in `auth.py:38-43` and `rate_limit.py:63-67` —
  fix the trust logic **once** in a shared helper so the two can't drift.

**Fix:**
- Trust only the hop **your own nginx** sets. Prefer a dedicated `X-Real-IP` that
  nginx sets from `$remote_addr`, or take the **last** XFF entry (nginx-appended),
  not the first. Confirm the nginx `proxy_set_header` config while doing this.
- Extract one `get_trusted_client_ip(request)` helper; use it in both files.
- Lower `auth_limit` from `100`/min to ~`10–15`/min once keying is trustworthy.
- Fix the `172.` private-range check (match `172.16.` – `172.31.` only), or drop
  the internal-IP string-prefix bypass in favour of a proper CIDR check.

**Effort:** Medium — mostly nginx header config + one helper.

---

## HIGH / MEDIUM

### 3. `/api/auth/me` fails OPEN on permissions
`backend/app/api/auth.py:254` returns
`current_user.permissions or list(ALL_PERMISSIONS)`. An **empty list** `[]` is
falsy in Python, so a user whose permissions were deliberately stripped to none
is handed **every** permission.

**Fix:** Fall back to full permissions only when `permissions is None`, never on
`[]`. Better: stop defaulting to `ALL_PERMISSIONS` on the read path — set a
user's default permissions explicitly at creation.

**Effort:** Low (one line + a test).

### 4. No refresh-token reuse detection; concurrent double-refresh
`backend/app/api/auth.py:155-199`. A presented-but-blacklisted refresh token
just 401s. A blacklisted refresh token being replayed usually means a **stolen
token** — best practice is to treat reuse as compromise and revoke the whole
token family for that user. Separately, two genuinely concurrent `/refresh`
calls with the same token can *both* pass the blacklist check and both mint fresh
pairs; the duplicate-insert `IntegrityError` is swallowed in
`app/utils/security.py:133-137`.

**Fix:** On reuse of an already-blacklisted refresh JTI, revoke all outstanding
tokens for that `user_id` and force re-login. Consider a per-user refresh
serialization or a DB unique constraint that makes the second concurrent
rotation fail closed.

**Effort:** Medium.

### 5. `/api/auth/refresh` doesn't check `is_active`
`backend/app/api/auth.py:179-184` only checks the user still exists. A
deactivated user's refresh token keeps minting new token pairs for up to 7 days.
(Contained today because `get_current_user` re-checks `is_active`, so the minted
*access* tokens fail — but it should fail at the source.)

**Fix:** Add `if not user.is_active: raise 401` in the refresh handler.

**Effort:** Low (one line).

### 6. Account / credential enumeration
`backend/app/api/auth.py`. An unknown email skips bcrypt entirely, so it returns
measurably faster than a real account (~200 ms gap) — a timing oracle for "does
this account exist". The distinct `Account locked` / `Account is deactivated`
messages also only appear for real accounts.

**Fix:** Verify the submitted password against a dummy bcrypt hash on the
not-found path so timing is constant. Consider returning a generic "invalid
credentials" for locked/inactive to external-facing logins.

**Effort:** Low–Medium.

### 7. Crew change-password takes passwords as QUERY PARAMETERS
`backend/app/api/crew_auth.py:170-182`. `crew_change_password(current_password:
str, new_password: str, ...)` — because these are bare scalars, FastAPI reads
them from the **query string**, so passwords land in the URL (server logs, nginx
access logs, browser history, referer headers).

**Fix:** Move them into a Pydantic request-body model (`ChangePasswordRequest`).
Update the frontend caller at the same time (contract change). Add password
complexity validation via `validate_password_complexity`.

**Effort:** Low, but it's a request-contract change — coordinate FE + BE.

---

## ARCHITECTURAL (evaluate, may defer past go-live)

### 8. JWTs stored in `localStorage`
Both auth systems store access/refresh (admin) and `crew_token` (crew) in
`localStorage`, readable by any XSS. The robust fix is httpOnly, `Secure`,
`SameSite` cookies — but that's a real refactor with CSRF implications across
both systems.

**Interim mitigations if cookies are deferred:**
- Add a strict Content-Security-Policy header (does more than the current
  XSSProtection middleware).
- Keep access-token lifetime short (already 60 min).
- Audit every place untrusted strings are rendered into the DOM.

**Effort:** High (cookie migration) / Low (CSP interim).

---

## Pre-go-live checklist
- [x] 1 — Lockout on provider portal login + crew login (+ audit entries) — DONE 2026-07-23:
      `failed_login_attempts`/`locked_until` on ServiceProvider + CrewMember (5 fails → 45 min,
      same constants as User); PORTAL_/CREW_ audit actions; idempotent ALTERs in
      `migrate_security.py` + alembic `c7d9e1f3a5b8`.
- [x] 2 — Trustworthy client-IP — DONE 2026-07-23: `app/utils/client_ip.get_trusted_client_ip`
      (X-Real-IP from our nginx, honoured only when the TCP peer is internal; else rightmost
      XFF; else raw peer) shared by rate limiter + auth audit; internal bypass now
      loopback-peer-only (72./192.168. prefix checks removed); RateLimitMiddleware
      RE-ENABLED in main.py (auth 15/min per client IP, api 300/min); `redis` service added
      to docker-compose.prod.yml (limiter previously failed open on prod — no Redis there).
- [x] 3 — `/me` permission fallback only on `None` — DONE. Also fixed in
      `has_permission` and, on 2026-08-02, in `users._user_response`, where the
      admin UI was still showing a stripped account as holding every permission.
- [x] 4 — Refresh-token reuse → revoke family — DONE 2026-08-02:
      `tokens_revoked_at` on `users`, `crew_members` and `service_providers`
      (migration `e5a8c2d47f19`), checked in `get_current_user`,
      `get_current_crew`, `require_portal_grant` and `/api/auth/refresh`.
      Replaying a spent refresh token is treated as theft and kills the family.
      Tokens carry `iat_ms`, not just `iat`: reuse fires milliseconds after the
      exchange that minted the attacker's token, so whole-second resolution let
      it survive the revocation aimed at it.
- [x] 5 — `/refresh` checks `is_active` — DONE.
- [x] 6 — Constant-time unknown-account path — DONE 2026-08-02:
      `verify_password_or_dummy` on all THREE password doors (admin login, crew
      login, provider portal-login/portal-unlock). An unknown identity now costs
      the same bcrypt as a real one, so response time no longer discloses which
      paramedics and which ambulance companies exist.
- [x] 7 — Crew change-password moved to request body — DONE.
- [x] 8 — CSP header shipped — DONE in `nginx/security-headers.conf` (CSP +
      HSTS), which is what `ems_nginx` serves in production. The cookie
      migration off `localStorage` is still open and tracked separately.

---

## Added 2026-08-02 — still open

- [ ] Redis `--requirepass` in production. Needs `REDIS_PASSWORD` **and** the
      matching `REDIS_URL` set in `.env.prod` in the same change, or the backend
      cannot authenticate. See the comment in `docker-compose.prod.yml`.
      Mitigated meanwhile: no published port, no on-disk persistence, and
      cached patient records are encrypted before they reach Redis.
- [ ] JWTs in `localStorage` (was item 8's second half) — httpOnly cookie
      migration, with the CSRF work it implies, across both auth systems.
- [ ] The emailed PRF PDF is client-supplied and never compared to the stored
      record, so the audit trail proves a transmission happened and to whom, but
      not what it contained. Fixing it properly means rendering the PDF
      server-side.
- [ ] Medical-aid MEMBERSHIP numbers (`med_aid_number`, `medical_aid_number` in
      the PRF blob, `cases.scheme_member_number` as a column) are personal
      information under POPIA and are **not** encrypted at rest. Deliberately
      out of scope on 2026-08-03 rather than overlooked: the membership number
      is the billing key used by EDI generation, adjudication and scheme member
      lookup, so encrypting it needs those three paths assessed together, and
      the form copy and the column must move in the same change.
      `gateway.sanitize_payload` already redacts it from stored scheme payloads.
