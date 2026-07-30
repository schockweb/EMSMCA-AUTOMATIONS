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
