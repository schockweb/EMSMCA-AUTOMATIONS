"""
Fine-grained permissions must be enforced by the server, not just the UI.

`permissions` was stored on the user, echoed back at login, and used by the
frontend to hide nav links — and consulted by no endpoint. A user created with
permissions=['dashboard'] still had a token that reached the rule builder, the
tariff engine, the failed-PRF queue (including the endpoint that rewrites
clinical data), EDI generation and submission, and adjudication. The whole model
was a UI convention that looked like access control.

Survivable while the only account on the box is a SUPER_ADMIN, which is the
current production state. Not survivable once a client creates limited staff
logins on their own VM and believes the checkboxes mean something.
"""
import pytest
import pytest_asyncio
from sqlalchemy import select

from app.models.user import ALL_PERMISSIONS, User, UserRole
from app.utils.security import has_permission, hash_password

_PASSWORD = "PermTest@2026!Strong"

# (route, every permission key that unlocks it)
#
# Some routers accept EITHER of two keys, so the denial test has to strip them
# all — an earlier version removed only one and the route stayed (correctly)
# reachable via the other, which read as a missing gate.
GATED_ROUTES = [
    ("/api/rate-schemas", ("rule_builder", "tariff_billing")),
    ("/api/tariff-lines/by-schema/1", ("tariff_billing", "rule_builder")),
    ("/api/failed-prfs", ("failed_forms",)),
    ("/api/adjudication/rfis", ("adjudication",)),
    # The documents router: every route was authentication-only, and
    # /export-spreadsheet bulk-exports EVERY document's extracted patient data
    # with no provider filter whatsoever.
    ("/api/documents/", ("upload", "document_review", "admin_queue")),
    ("/api/documents/export-spreadsheet", ("upload", "document_review", "admin_queue")),
]


async def _user_with(email: str, permissions, role=UserRole.ADMIN):
    from tests.conftest import _TestSession

    async with _TestSession() as db:
        user = (await db.execute(select(User).where(User.email == email))).scalar_one_or_none()
        if user is None:
            user = User(
                email=email,
                hashed_password=hash_password(_PASSWORD),
                full_name="Permission Fixture",
                role=role,
                bhf_practice_number="0000000",
            )
            db.add(user)
        user.role = role
        user.permissions = permissions
        await db.commit()
    return email


async def _login(client, email):
    resp = await client.post("/api/auth/login", data={"username": email, "password": _PASSWORD})
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


# ── The helper's semantics ─────────────────────────────────────────────────

def test_none_permissions_means_all():
    """Every existing account was created this way — the column being NULL must
    keep meaning 'not configured', i.e. everything."""
    user = User(email="x@y.z", hashed_password="x", full_name="x",
                role=UserRole.ADMIN, permissions=None)
    assert has_permission(user, "rule_builder") is True


def test_empty_permissions_means_none():
    """`or` would collapse this into the NULL case and hand a deliberately
    stripped user the full set — the same bug already fixed in /api/auth/me."""
    user = User(email="x@y.z", hashed_password="x", full_name="x",
                role=UserRole.ADMIN, permissions=[])
    assert has_permission(user, "rule_builder") is False


def test_super_admin_bypasses_even_with_empty_permissions():
    user = User(email="x@y.z", hashed_password="x", full_name="x",
                role=UserRole.SUPER_ADMIN, permissions=[])
    assert has_permission(user, "rule_builder") is True


def test_any_of_the_keys_is_enough():
    user = User(email="x@y.z", hashed_password="x", full_name="x",
                role=UserRole.ADMIN, permissions=["tariff_billing"])
    assert has_permission(user, "rule_builder", "tariff_billing") is True
    assert has_permission(user, "rule_builder") is False


# ── End to end ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize("route,keys", GATED_ROUTES)
@pytest.mark.asyncio
async def test_route_denied_without_its_permission(client, route, keys):
    """An ADMIN holding every permission EXCEPT this route's must be refused."""
    others = [p for p in ALL_PERMISSIONS if p not in keys]
    email = await _user_with(f"perm_missing_{keys[0]}@emsclaims.test", others)
    headers = await _login(client, email)

    resp = await client.get(route, headers=headers)
    assert resp.status_code == 403, (
        f"{route} was reachable without any of {list(keys)} ({resp.status_code})"
    )


@pytest.mark.parametrize("route,keys", GATED_ROUTES)
@pytest.mark.asyncio
async def test_route_allowed_with_its_permission(client, route, keys):
    """And granting only that key must be enough — otherwise the gate is
    mismapped and a client's staff would be locked out of their own page.

    Anything other than 403 counts: a 404 or 422 from the handler still proves
    the request got past the gate.
    """
    key = keys[0]
    email = await _user_with(f"perm_only_{key}@emsclaims.test", [key])
    headers = await _login(client, email)

    resp = await client.get(route, headers=headers)
    assert resp.status_code != 403, (
        f"{route} refused a user holding exactly its {key!r} permission — "
        f"the permission key is mismapped"
    )


@pytest.mark.asyncio
async def test_super_admin_reaches_everything(client):
    """The production account. It must be unaffected by all of the above."""
    email = await _user_with(
        "perm_superadmin@emsclaims.test", [], role=UserRole.SUPER_ADMIN
    )
    headers = await _login(client, email)

    for route, _keys in GATED_ROUTES:
        resp = await client.get(route, headers=headers)
        assert resp.status_code != 403, f"SUPER_ADMIN was refused {route}"


@pytest.mark.asyncio
async def test_null_permissions_admin_reaches_everything(client):
    """Existing accounts have permissions=NULL. Rolling this out must not lock
    any of them out."""
    email = await _user_with("perm_null@emsclaims.test", None)
    headers = await _login(client, email)

    for route, _keys in GATED_ROUTES:
        resp = await client.get(route, headers=headers)
        assert resp.status_code != 403, (
            f"an existing NULL-permissions admin was refused {route}"
        )


# ─────────────────────────────────────────────────────────────────────────────
# Routers that were authentication-only until 2026-08-02.
# ─────────────────────────────────────────────────────────────────────────────

_NEWLY_GATED = [
    # Instance-wide scheme authorisation queue: patient identity, membership
    # number and clinical justification for every provider.
    ("/api/authorization/queue", "authorization"),
    # Instance-wide financial and operational figures across every provider.
    ("/api/analytics/dashboard", "analytics"),
    # An identity oracle — scheme + membership number in, name, SA ID number
    # and contact details out, for people who need not be patients here.
    ("/api/member-lookup/gems/1234567", "member lookup"),
]


@pytest.mark.parametrize("route,label", _NEWLY_GATED, ids=[r[1] for r in _NEWLY_GATED])
@pytest.mark.asyncio
async def test_a_low_privilege_account_is_refused(client, route, label):
    """The default role for a carelessly-created user is PARAMEDIC."""
    email = await _user_with(
        "newgate_paramedic@emsclaims.test", None, role=UserRole.PARAMEDIC
    )
    headers = await _login(client, email)
    res = await client.get(route, headers=headers)
    assert res.status_code == 403, (
        f"a PARAMEDIC account reached {label} ({route}): {res.status_code}"
    )


@pytest.mark.parametrize("route,label", _NEWLY_GATED, ids=[r[1] for r in _NEWLY_GATED])
@pytest.mark.asyncio
async def test_an_admin_is_not_locked_out(client, route, label):
    """Refusing everybody would pass the test above. It must not."""
    email = await _user_with("newgate_admin@emsclaims.test", None, role=UserRole.ADMIN)
    headers = await _login(client, email)
    res = await client.get(route, headers=headers)
    assert res.status_code != 403, f"an ADMIN was locked out of {label} ({route})"


@pytest.mark.asyncio
async def test_super_admin_reaches_the_crash_dashboard(client):
    """These routes tested `role.value != "admin"`, an EXACT match that refuses
    SUPER_ADMIN. Production has exactly one back-office account and it is a
    SUPER_ADMIN, so the crash dashboard was refusing the only person who could
    use it. Same trap as the one already documented on require_role."""
    email = await _user_with(
        "newgate_superadmin@emsclaims.test", None, role=UserRole.SUPER_ADMIN
    )
    headers = await _login(client, email)
    for route in ("/api/crashes", "/api/crashes/stats"):
        res = await client.get(route, headers=headers)
        assert res.status_code != 403, (
            f"SUPER_ADMIN was refused {route} — the highest privilege in the "
            f"system cannot read the crash log"
        )
