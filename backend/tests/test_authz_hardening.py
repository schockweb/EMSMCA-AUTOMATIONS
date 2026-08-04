"""
Authorisation hardening — the pre-client-deployment findings.

Every test here corresponds to a route that was reachable by a principal who
should never have had it. They are written to FAIL if the guard is removed:
each one asserts the 401/403, and the "allowed" counterpart asserts the route is
still reachable by the principal that legitimately needs it, so a guard that is
simply too tight also fails.

Context: the product is being installed on a client's own VM. Several of these
were survivable while we were the only tenant on the only box.
"""
import uuid

import pytest
import pytest_asyncio
from sqlalchemy import select

from app.models.user import User, UserRole
from app.utils.security import hash_password


# ── Fixtures: one user per role we need to distinguish ──────────────────────

_LOW_PRIV_EMAIL = "paramedic_authz_pytest@emsclaims.test"
_ADMIN_EMAIL = "admin_authz_pytest@emsclaims.test"
_SUPER_EMAIL = "superadmin_authz_pytest@emsclaims.test"
_PASSWORD = "AuthzTest@2026!Strong"


async def _ensure_user(email: str, role: UserRole) -> None:
    from tests.conftest import _TestSession

    async with _TestSession() as db:
        existing = (await db.execute(select(User).where(User.email == email))).scalar_one_or_none()
        if existing is None:
            db.add(User(
                email=email,
                hashed_password=hash_password(_PASSWORD),
                full_name=f"Authz Fixture {role.value}",
                role=role,
                bhf_practice_number="0000000",
            ))
            await db.commit()
        elif existing.role != role:
            existing.role = role
            await db.commit()


async def _login(client, email: str) -> dict:
    resp = await client.post("/api/auth/login", data={"username": email, "password": _PASSWORD})
    assert resp.status_code == 200, f"fixture login failed for {email}: {resp.text}"
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


@pytest_asyncio.fixture
async def low_priv_headers(client):
    """A PARAMEDIC — the User model's DEFAULT role for a new account.

    This is the whole point: 'authenticated' was being treated as 'privileged',
    and the least-privileged account in the system is what you get by default.
    """
    await _ensure_user(_LOW_PRIV_EMAIL, UserRole.PARAMEDIC)
    return await _login(client, _LOW_PRIV_EMAIL)


@pytest_asyncio.fixture
async def plain_admin_headers(client):
    """An ADMIN, pinned to that role by the fixture itself.

    Not the shared `auth_headers` seed admin: what role THAT account holds is a
    property of the database the suite is pointed at, not of the test. On a
    developer's dev DB it has been promoted to SUPER_ADMIN by the app lifespan,
    which turned the deny-assertion below into a call that sailed past the guard
    and into the route body — the 403 the test claimed to be proving had not
    been proven on that machine for as long as the promotion had been in place.
    A test that asserts a refusal has to own the principal being refused.
    """
    await _ensure_user(_ADMIN_EMAIL, UserRole.ADMIN)
    return await _login(client, _ADMIN_EMAIL)


@pytest_asyncio.fixture
async def super_admin_headers(client):
    await _ensure_user(_SUPER_EMAIL, UserRole.SUPER_ADMIN)
    return await _login(client, _SUPER_EMAIL)


@pytest_asyncio.fixture
async def provider_id():
    """The provider the shared crew fixture creates."""
    from tests.conftest import _TestSession
    from app.models.service_provider import ServiceProvider

    async with _TestSession() as db:
        res = await db.execute(
            select(ServiceProvider).where(ServiceProvider.slug == "pytest-prf-provider")
        )
        provider = res.scalar_one()
        return str(provider.id)


# ── 1. POST /api/invoices/{id}/submit had NO auth dependency at all ─────────

@pytest.mark.asyncio
async def test_invoice_submit_rejects_anonymous(client):
    """Unauthenticated callers must not reach the invoice router.

    The route carried only Depends(get_db). nginx proxies /api/ straight to the
    backend, so any caller with a claim UUID could flip that claim to SUBMITTED
    and overwrite its dispatch reference, unattributably.
    """
    resp = await client.post(f"/api/invoices/{uuid.uuid4()}/submit")
    assert resp.status_code == 401, (
        f"anonymous invoice submit returned {resp.status_code}, expected 401"
    )


@pytest.mark.asyncio
async def test_invoice_submit_rejects_low_privilege_user(client, low_priv_headers):
    resp = await client.post(f"/api/invoices/{uuid.uuid4()}/submit", headers=low_priv_headers)
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_invoice_submit_reaches_handler_for_admin(client, auth_headers):
    """An ADMIN gets past the guard — proving the guard is not simply blanket-deny.

    404 is the correct answer for a claim UUID that does not exist; what matters
    is that it is the HANDLER's 404 and not the guard's 401/403.
    """
    if auth_headers is None:
        pytest.skip("seed admin unavailable")
    resp = await client.post(f"/api/invoices/{uuid.uuid4()}/submit", headers=auth_headers)
    assert resp.status_code not in (401, 403), (
        f"ADMIN was blocked from invoice submit with {resp.status_code}"
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_invoice_submit_malformed_uuid_is_404_not_500(client, auth_headers):
    """uuid.UUID() on a non-UUID path segment raised ValueError → 500."""
    if auth_headers is None:
        pytest.skip("seed admin unavailable")
    resp = await client.post("/api/invoices/not-a-uuid/submit", headers=auth_headers)
    assert resp.status_code == 404, f"expected 404, got {resp.status_code}"


# ── 2. _assert_settings_access never constrained User principals ────────────

@pytest.mark.asyncio
async def test_provider_settings_denied_to_low_privilege_user(client, low_priv_headers, provider_id):
    """A PARAMEDIC must not read another tenant's provider settings.

    get_admin_or_crew_admin is AUTHENTICATION only — it returns any active User
    without inspecting role — and _assert_settings_access had no User branch, so
    this returned 200 with the provider's configuration.
    """
    resp = await client.get(f"/api/providers/{provider_id}/settings", headers=low_priv_headers)
    assert resp.status_code == 403, (
        f"low-privilege user read provider settings ({resp.status_code})"
    )


@pytest.mark.asyncio
async def test_provider_settings_patch_denied_to_low_privilege_user(client, low_priv_headers, provider_id):
    """The write path matters more than the read: this body sets the portal
    password, which is the secret that unlocks a crew device."""
    resp = await client.patch(
        f"/api/providers/{provider_id}/settings",
        headers=low_priv_headers,
        json={"portal_login_password": "Attacker@Owns2026!"},
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_crew_reset_password_denied_to_low_privilege_user(client, low_priv_headers, provider_id):
    """This endpoint returns a PLAINTEXT temporary password in its response."""
    resp = await client.post(
        f"/api/providers/{provider_id}/crew/{uuid.uuid4()}/reset-password",
        headers=low_priv_headers,
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_provider_prf_history_denied_to_low_privilege_user(client, low_priv_headers, provider_id):
    """PRF history is patient data: names, ID numbers, clinical notes."""
    resp = await client.get(f"/api/providers/{provider_id}/prfs", headers=low_priv_headers)
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_provider_settings_still_allowed_for_admin(client, auth_headers, provider_id):
    """The guard must not lock out the back-office admin who needs this page."""
    if auth_headers is None:
        pytest.skip("seed admin unavailable")
    resp = await client.get(f"/api/providers/{provider_id}/settings", headers=auth_headers)
    assert resp.status_code == 200, f"ADMIN blocked from provider settings: {resp.text}"


@pytest.mark.asyncio
async def test_provider_settings_allowed_for_super_admin(client, super_admin_headers, provider_id):
    """SUPER_ADMIN must not be caught by the new role check either."""
    resp = await client.get(f"/api/providers/{provider_id}/settings", headers=super_admin_headers)
    assert resp.status_code == 200


# ── 3. Provider lifecycle routes ran on bare get_current_user ───────────────

@pytest.mark.asyncio
async def test_provider_delete_denied_to_low_privilege_user(client, low_priv_headers, provider_id):
    """DELETE /api/providers/{id} cascades: crew, vehicles and every PRF."""
    resp = await client.delete(f"/api/providers/{provider_id}", headers=low_priv_headers)
    assert resp.status_code == 403, (
        f"low-privilege user could delete a provider ({resp.status_code})"
    )


@pytest.mark.asyncio
async def test_provider_patch_denied_to_low_privilege_user(client, low_priv_headers, provider_id):
    resp = await client.patch(
        f"/api/providers/{provider_id}",
        headers=low_priv_headers,
        json={"name": "Renamed By Paramedic"},
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_provider_create_denied_to_low_privilege_user(client, low_priv_headers):
    resp = await client.post(
        "/api/providers",
        headers=low_priv_headers,
        json={"name": "Paramedic Made This"},
    )
    assert resp.status_code == 403


# ── 4. DELETE /api/cases/all — the most destructive route in the API ────────

@pytest.mark.asyncio
async def test_delete_all_cases_denied_to_low_privilege_user(client, low_priv_headers):
    resp = await client.delete("/api/cases/all", headers=low_priv_headers)
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_delete_all_cases_denied_to_plain_admin(client, plain_admin_headers):
    """Deliberately SUPER_ADMIN-only, not ADMIN.

    NOTE: this test never asserts a successful wipe. Doing so would delete every
    case in whatever database the suite is pointed at — so the allowed path is
    proven in tests/test_delete_all_cases_ordering.py, which builds a database of
    its own to be destroyed. Without that counterpart this assertion is only half
    a guard: a route that 500s, or 403s, for EVERY caller passes it too.
    """
    resp = await client.delete("/api/cases/all", headers=plain_admin_headers)
    assert resp.status_code == 403, (
        f"a plain ADMIN reached the wipe-everything route ({resp.status_code})"
    )


@pytest.mark.asyncio
async def test_delete_all_cases_denied_to_anonymous(client):
    resp = await client.delete("/api/cases/all")
    assert resp.status_code == 401


# ── 5. POST /gateway/ forwards caller-controlled payloads to a scheme ───────

@pytest.mark.asyncio
async def test_gateway_rejects_anonymous(client):
    resp = await client.post("/gateway/", json={
        "internal_claim_id": str(uuid.uuid4()),
        "scheme_destination_code": "discovery",
        "action": "SUBMIT_CLAIM",
        "payload_data": {"injected": "content"},
    })
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_gateway_rejects_low_privilege_user(client, low_priv_headers):
    resp = await client.post("/gateway/", headers=low_priv_headers, json={
        "internal_claim_id": str(uuid.uuid4()),
        "scheme_destination_code": "discovery",
        "action": "SUBMIT_CLAIM",
        "payload_data": {"injected": "content"},
    })
    assert resp.status_code == 403


# ── 6. require_role must not lock SUPER_ADMIN out ──────────────────────────

@pytest.mark.asyncio
async def test_super_admin_can_reach_admin_only_user_management(client, super_admin_headers):
    """require_role matched exactly, so require_role(ADMIN) returned 403 to a
    SUPER_ADMIN — locking the highest-privileged account out of user management.

    The trailing slash is required: the route is registered as "/" under the
    /api/users prefix, and without it Starlette answers 307 before the guard
    ever runs, which would make this test pass for the wrong reason.
    """
    resp = await client.get("/api/users/", headers=super_admin_headers)
    assert resp.status_code != 403, "SUPER_ADMIN was refused an ADMIN-guarded route"
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_low_privilege_user_still_denied_user_management(client, low_priv_headers):
    """The SUPER_ADMIN allowance must not have widened the guard for everyone."""
    resp = await client.get("/api/users/", headers=low_priv_headers)
    assert resp.status_code == 403


# ── 7. The mock scheme server must not be mounted in production ─────────────

def test_mock_scheme_mount_is_guarded_by_app_env():
    """The mock scheme server answers unauthenticated and ALWAYS approves.

    Asserted against the source rather than over HTTP: this suite runs with
    APP_ENV=test, where the router is legitimately mounted. What must hold is
    that mounting is conditional on APP_ENV at all.

    Searching BACKWARDS from the mount is deliberate. The same guard string also
    appears in the lifespan handler far earlier in the file, so a forward
    str.index() finds that unrelated one and the test passes even if the mount
    is completely unguarded.
    """
    import inspect
    import app.main as main_module

    source = inspect.getsource(main_module)
    guard = 'if settings.APP_ENV != "production":'

    mount_pos = source.index("app.include_router(mock_scheme_router)")
    guard_pos = source.rfind(guard, 0, mount_pos)

    assert guard_pos != -1, "mock scheme router is mounted with no APP_ENV guard before it"
    between = source[guard_pos + len(guard):mount_pos]
    assert between.strip() == "", (
        "the nearest APP_ENV guard is not the one wrapping the mock scheme mount; "
        f"unexpected code between them: {between.strip()[:120]!r}"
    )


def test_mock_scheme_routes_exist_when_not_production():
    """Counterpart: the router still works where it is supposed to.

    Without this, deleting the router entirely would also make the guard test
    pass, and the pipeline would lose its offline scheme simulator.

    Reads the OpenAPI schema rather than walking app.routes. FastAPI 0.141 wraps
    each include_router() result in a `_IncludedRouter` instead of flattening its
    routes into app.routes, so the old traversal saw 8 paths where there are 121
    and this test failed on the dependency upgrade even though nothing was
    wrong. The schema is the stable public contract; the internal route-tree
    shape is not.
    """
    from app.main import app as fastapi_app

    paths = set(fastapi_app.openapi().get("paths", {}))
    assert any(p.startswith("/api/mock-scheme") for p in paths), (
        "mock scheme routes are absent even though APP_ENV is not production"
    )
