"""
The 2026-08-02 hostile-review findings, each pinned by a test.

Four themes, all variants of one mistake — a control that was written correctly
in one place and never propagated to the second door into the same thing:

  * PRIVILEGE. `PATCH /api/users/{id}` let any ADMIN write `role: super_admin`
    onto their own row. SUPER_ADMIN short-circuits every guard in the product,
    and `DELETE /api/cases/all` then erases every tenant's records. Unaudited.
  * TENANCY. The claims router declared no dependencies at all, so any token —
    including a PARAMEDIC-default account narrowed to one page — read every
    provider's claims and could rewrite the amounts billed to a scheme.
  * PHI AT REST. The identifier was encrypted in two tables and left in clear in
    three more: the scanned-PRF pipeline, the other identifier keys in the same
    PRF blob, and an unauthenticated Redis with append-only persistence.
  * AVAILABILITY. Provider-wide lockout, driven by a public slug list, let an
    anonymous caller take an ambulance service off the air.
"""
from datetime import datetime, timezone

import pytest
import pytest_asyncio
from sqlalchemy import select

from app.models.audit_log import AuditLog
from app.models.user import User, UserRole
from app.utils.security import hash_password

pytestmark = pytest.mark.asyncio

_PW = "Hardening-Test-2026!"


@pytest_asyncio.fixture
async def plain_admin():
    """A back-office ADMIN — the role handed to client office staff."""
    from tests.conftest import _TestSession

    async with _TestSession() as db:
        user = (await db.execute(
            select(User).where(User.email == "plain_admin_pytest@emsclaims.test")
        )).scalar_one_or_none()
        if user is None:
            user = User(
                email="plain_admin_pytest@emsclaims.test",
                hashed_password=hash_password(_PW),
                full_name="PyTest Plain Admin",
                role=UserRole.ADMIN,
            )
            db.add(user)
        else:
            user.role = UserRole.ADMIN
            user.is_active = True
            user.hashed_password = hash_password(_PW)
            user.tokens_revoked_at = None
        await db.commit()
        return str(user.id)


@pytest_asyncio.fixture
async def admin_headers(client, plain_admin):
    r = await client.post("/api/auth/login", data={
        "username": "plain_admin_pytest@emsclaims.test", "password": _PW,
    })
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


# ════════════════════════════════════════════════════════════════════
# Privilege escalation
# ════════════════════════════════════════════════════════════════════

async def test_admin_cannot_promote_themselves_to_super_admin(
    client, admin_headers, plain_admin
):
    """The whole chain starts here. SUPER_ADMIN bypasses require_role AND
    has_permission unconditionally, and reaches DELETE /api/cases/all."""
    from tests.conftest import _TestSession

    r = await client.patch(f"/api/users/{plain_admin}",
                           headers=admin_headers, json={"role": "super_admin"})
    assert r.status_code == 403, "an ADMIN just made themselves SUPER_ADMIN"

    async with _TestSession() as db:
        role = (await db.execute(
            select(User.role).where(User.id == plain_admin)
        )).scalar_one()
    assert role == UserRole.ADMIN, "the role was written despite the refusal"


async def test_admin_cannot_promote_someone_else_to_super_admin(
    client, admin_headers
):
    """Blocking self-edit alone is not enough — two colluding admins, or one
    admin and a dormant account they control, would walk straight around it."""
    from tests.conftest import _TestSession

    async with _TestSession() as db:
        victim = (await db.execute(
            select(User).where(User.email == "escalation_target_pytest@emsclaims.test")
        )).scalar_one_or_none()
        if victim is None:
            victim = User(
                email="escalation_target_pytest@emsclaims.test",
                hashed_password=hash_password(_PW),
                full_name="PyTest Target", role=UserRole.PARAMEDIC,
            )
            db.add(victim)
            await db.commit()
        vid = str(victim.id)

    r = await client.patch(f"/api/users/{vid}",
                           headers=admin_headers, json={"role": "super_admin"})
    assert r.status_code == 403


async def test_admin_cannot_seize_the_super_admin_account(client, admin_headers):
    """Password reset had no current-password check and no target check, so an
    ADMIN could simply take the SUPER_ADMIN's account instead of escalating."""
    from tests.conftest import _TestSession

    async with _TestSession() as db:
        su = (await db.execute(
            select(User).where(User.email == "super_pytest@emsclaims.test")
        )).scalar_one_or_none()
        if su is None:
            su = User(email="super_pytest@emsclaims.test",
                      hashed_password=hash_password(_PW),
                      full_name="PyTest Super", role=UserRole.SUPER_ADMIN)
            db.add(su)
            await db.commit()
        sid = str(su.id)

    for body in ({"password": "Seized-Account-2026!"}, {"is_active": False},
                 {"role": "paramedic"}):
        r = await client.patch(f"/api/users/{sid}", headers=admin_headers, json=body)
        assert r.status_code == 403, f"an ADMIN modified a SUPER_ADMIN with {body}"


async def test_admin_cannot_widen_their_own_permissions(client, admin_headers, plain_admin):
    r = await client.patch(
        f"/api/users/{plain_admin}", headers=admin_headers,
        json={"permissions": ["dashboard", "settings", "rule_builder", "providers"]},
    )
    assert r.status_code == 403


async def test_a_role_change_is_audited(client, auth_headers, plain_admin):
    """This was the only privileged write in the product leaving no trace."""
    from tests.conftest import _TestSession

    if not auth_headers:
        pytest.skip("seed admin unavailable")

    r = await client.patch(f"/api/users/{plain_admin}",
                           headers=auth_headers, json={"role": "billing_clerk"})
    assert r.status_code == 200, r.text

    async with _TestSession() as db:
        rows = (await db.execute(
            select(AuditLog).where(
                AuditLog.action == "USER_UPDATED",
                AuditLog.entity_id == plain_admin,
            )
        )).scalars().all()
    assert rows, "a role change wrote no audit row"
    assert rows[-1].before_state["role"] == "admin"
    assert rows[-1].after_state["role"] == "billing_clerk"


async def test_an_admin_password_reset_ends_the_old_sessions(client, auth_headers, plain_admin):
    """A reset that leaves the old sessions alive has not locked anyone out."""
    from tests.conftest import _TestSession

    if not auth_headers:
        pytest.skip("seed admin unavailable")

    login = await client.post("/api/auth/login", data={
        "username": "plain_admin_pytest@emsclaims.test", "password": _PW,
    })
    assert login.status_code == 200, login.text
    old = {"Authorization": f"Bearer {login.json()['access_token']}"}
    assert (await client.get("/api/auth/me", headers=old)).status_code == 200

    r = await client.patch(f"/api/users/{plain_admin}", headers=auth_headers,
                           json={"password": "Rotated-By-Admin-2026!"})
    assert r.status_code == 200, r.text

    assert (await client.get("/api/auth/me", headers=old)).status_code == 401, \
        "the session minted by the OLD password still works after a reset"


# ════════════════════════════════════════════════════════════════════
# Cross-tenant claims access
# ════════════════════════════════════════════════════════════════════

async def test_claims_router_is_not_authentication_only(client):
    """No credential at all must not reach billing data."""
    for path in ("/api/claims/", "/api/claims/00000000-0000-0000-0000-000000000000"):
        res = await client.get(path)
        assert res.status_code in (401, 403), f"{path} answered {res.status_code} anonymously"


async def test_a_narrowed_account_cannot_read_or_rewrite_claims(client):
    """The exact account the permission checkboxes promise to constrain."""
    from tests.conftest import _TestSession

    async with _TestSession() as db:
        u = (await db.execute(
            select(User).where(User.email == "dashboard_only_pytest@emsclaims.test")
        )).scalar_one_or_none()
        if u is None:
            u = User(email="dashboard_only_pytest@emsclaims.test",
                     hashed_password=hash_password(_PW),
                     full_name="PyTest Dashboard Only", role=UserRole.ADMIN)
            db.add(u)
        u.role = UserRole.ADMIN
        u.is_active = True
        u.permissions = ["dashboard"]
        u.hashed_password = hash_password(_PW)
        u.tokens_revoked_at = None
        await db.commit()

    login = await client.post("/api/auth/login", data={
        "username": "dashboard_only_pytest@emsclaims.test", "password": _PW,
    })
    assert login.status_code == 200, login.text
    hdr = {"Authorization": f"Bearer {login.json()['access_token']}"}

    assert (await client.get("/api/claims/", headers=hdr)).status_code == 403, \
        "an account limited to the dashboard read every tenant's claims"

    patch = await client.patch(
        "/api/claims/00000000-0000-0000-0000-000000000000/lines",
        headers=hdr, json={"lines": []},
    )
    assert patch.status_code == 403, \
        "an account limited to the dashboard could rewrite billed amounts"


async def test_provider_list_and_detail_are_not_authentication_only(client):
    """These return every tenant's portal_login_username."""
    for path in ("/api/providers", "/api/providers/00000000-0000-0000-0000-000000000000"):
        res = await client.get(path)
        assert res.status_code in (401, 403), f"{path} answered {res.status_code} anonymously"


# ════════════════════════════════════════════════════════════════════
# PHI at rest
# ════════════════════════════════════════════════════════════════════

def test_every_identifier_in_the_prf_blob_is_encrypted():
    """Encrypting only `patient_id_number` left three identifiers in clear in
    the SAME column — including the only identifier a foreign national has."""
    from app.utils.encrypted_types import FormDataWithEncryptedPatientID

    t = FormDataWithEncryptedPatientID()
    blob = {
        "patient_id_number": "9001015800083",
        "debtor_id_number": "8505125800084",
        "patient_passport_number": "A01234567",
        "debtor_passport_number": "B07654321",
        "chief_complaint": "chest pain",       # must NOT be touched
    }
    stored = t.process_bind_param(dict(blob), None)

    for key in ("patient_id_number", "debtor_id_number",
                "patient_passport_number", "debtor_passport_number"):
        assert stored[key] != blob[key], f"{key} was written in plaintext"
        assert stored[key].startswith("gAAAAA"), f"{key} is not a Fernet token"

    assert stored["chief_complaint"] == "chest pain", "clinical text was mangled"
    assert t.process_result_value(stored, None) == blob, "round-trip lost data"


def test_scanned_prf_extraction_is_encrypted():
    """documents.extracted_data was a bare JSON column holding the SA ID read
    off a scanned form. The conversion script never touched this table."""
    from app.utils.encrypted_types import ExtractedDataWithEncryptedIDs

    t = ExtractedDataWithEncryptedIDs()
    blob = {"patient_id_number": "9001015800083",
            "main_member_id": "8505125800084",
            "patient_name": "Test Patient"}
    stored = t.process_bind_param(dict(blob), None)

    assert stored["patient_id_number"].startswith("gAAAAA")
    assert stored["main_member_id"].startswith("gAAAAA")
    assert t.process_result_value(stored, None) == blob


def test_document_model_actually_uses_the_encrypted_type():
    """A type that exists but is not attached to the column encrypts nothing —
    the single most repeated failure in this codebase."""
    from app.models.document import Document
    from app.utils.encrypted_types import ExtractedDataWithEncryptedIDs

    col = Document.__table__.c.extracted_data
    assert isinstance(col.type, ExtractedDataWithEncryptedIDs), \
        "Document.extracted_data is not using the encrypting column type"


def test_attacker_chosen_prefix_is_not_mistaken_for_ciphertext():
    """`looks_encrypted` is a prefix test on six characters the user types.

    Gating the WRITE path on it meant anything beginning 'gAAAAA' was stored
    verbatim in the clear, then read back as blank.
    """
    from app.utils.patient_id import encrypt_id

    planted = "gAAAAAnot-actually-encrypted"
    out = encrypt_id(planted)
    assert out != planted, "attacker-chosen plaintext was stored as-is"
    from app.utils.crypto import decrypt_str
    assert decrypt_str(out) == planted, "value did not survive real encryption"


async def test_cached_patient_record_is_not_plaintext_in_redis():
    """Redis persists to an append-only file with no password. Caching the
    decrypted record there contradicts the at-rest claim outright."""
    import json
    from unittest.mock import AsyncMock, patch

    from app import cache as cache_mod

    fake = AsyncMock()
    with patch.object(cache_mod, "_get_redis", AsyncMock(return_value=fake)):
        await cache_mod.set_cache(
            "prf:detail:x", {"form_data": {"patient_id_number": "9001015800083"}},
            ttl=60, sensitive=True,
        )
    stored = fake.set.await_args.args[1]
    assert "9001015800083" not in stored, "the SA ID went to Redis in cleartext"
    assert stored.startswith("enc:v1:")

    fake2 = AsyncMock()
    fake2.get = AsyncMock(return_value=stored)
    with patch.object(cache_mod, "_get_redis", AsyncMock(return_value=fake2)):
        back = await cache_mod.get_cache("prf:detail:x")
    assert back["form_data"]["patient_id_number"] == "9001015800083", \
        "encrypted cache entry did not round-trip"


def test_crash_reports_do_not_capture_patient_identifiers():
    """Any 500 on a PRF autosave wrote the whole form blob into crash_events."""
    from app.middleware.crash_handler import _redact, _redact_body
    import json

    body = json.dumps({
        "patient_id_number": "9001015800083",
        "patient_name": "Jane Doe",
        "form_data": {"debtor_id_number": "8505125800084", "pulse": 88},
    }).encode()

    out = _redact_body(body)
    assert "9001015800083" not in out
    assert "8505125800084" not in out, "nested identifier survived redaction"
    assert "Jane Doe" not in out
    assert "pulse" in out, "clinical context was destroyed along with the PHI"

    assert _redact({"id_number": "9001015800083"})["id_number"] == "<redacted>"
    # An unparseable body cannot be redacted, so it must not be stored at all.
    assert "not stored" in _redact_body(b"\x80\x81 raw bytes")


async def test_the_crash_recorder_actually_calls_the_redactor():
    """The test above proves the redactor works. This proves it is WIRED.

    Mutation testing caught the gap: replacing the call site with the original
    `body.decode(...)[:2000]` left every redaction test green while real crash
    rows went back to storing plaintext SA IDs. A guard that exists but is not
    called is the single most repeated defect in this codebase, and testing the
    helper in isolation is exactly how it stays invisible.
    """
    import json
    from unittest.mock import AsyncMock, MagicMock, patch

    from app.middleware import crash_handler

    body = json.dumps({"patient_id_number": "9001015800083",
                       "patient_name": "Jane Doe", "pulse": 88}).encode()

    request = MagicMock()
    request.method = "POST"
    request.url.path = "/api/cases"
    request.query_params = {"id_number": "9001015800083"}
    request.client.host = "203.0.113.4"
    request.headers = {"user-agent": "pytest", "content-type": "application/json"}
    request.state = MagicMock(spec=[])          # no user_id attribute
    request.body = AsyncMock(return_value=body)

    captured = {}

    class _Session:
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        def add(self, row): captured["row"] = row
        async def commit(self): pass

    with patch.object(crash_handler, "AsyncSessionLocal", lambda: _Session()):
        await crash_handler.record_crash_event(request, ValueError("boom"))

    blob = json.dumps(captured["row"].metadata_blob, default=str)
    assert "9001015800083" not in blob, \
        "the crash recorder stored a plaintext SA ID — redaction is not wired in"
    assert "Jane Doe" not in blob
    assert "pulse" in blob, "diagnostic context was lost"


# ════════════════════════════════════════════════════════════════════
# Availability: lockout must throttle the attacker, not the ambulance service
# ════════════════════════════════════════════════════════════════════

async def test_a_wrong_password_does_not_lock_out_the_whole_provider(client):
    """`GET /api/providers/public` is unauthenticated and lists every slug.

    With a provider-keyed lock, five anonymous guesses per slug took an entire
    ambulance service off the air for 45 minutes — a crew on scene could not
    unlock a tablet or create a patient record.
    """
    from tests.conftest import _TestSession
    from sqlalchemy import select as sa_select
    from app.models.service_provider import ServiceProvider
    from app.utils import login_throttle

    portal_pw = "Portal-Availability-2026!"
    async with _TestSession() as db:
        provider = (await db.execute(
            sa_select(ServiceProvider).where(ServiceProvider.slug == "pytest-prf-provider")
        )).scalar_one()
        provider.portal_login_password_hash = hash_password(portal_pw)
        provider.failed_login_attempts = 0
        provider.locked_until = None
        await db.commit()
        pid, slug = str(provider.id), provider.slug

    login_throttle._MEM.clear()

    # The attacker burns the provider's attempt budget from their own address.
    for _ in range(6):
        await client.post("/api/crew/portal-unlock",
                          json={"provider_slug": slug, "password": "wrong-guess"})

    # A crew who knows the password must still get in. httpx/ASGI reports the
    # same client host for both, so the throttle is cleared to stand in for
    # "a different device" — the property under test is that the PROVIDER is
    # not what got locked.
    async with _TestSession() as db:
        provider = (await db.execute(
            sa_select(ServiceProvider).where(ServiceProvider.id == pid)
        )).scalar_one()
        assert provider.locked_until is None, \
            "a provider-wide lock was set — an anonymous caller can ground the fleet"

    login_throttle._MEM.clear()
    ok = await client.post("/api/crew/portal-unlock",
                           json={"provider_slug": slug, "password": portal_pw})
    assert ok.status_code == 200, \
        f"a crew with the correct password was refused: {ok.status_code} {ok.text[:200]}"


async def test_the_guessing_source_is_still_throttled(client):
    """Removing the DoS must not remove the brute-force protection."""
    from tests.conftest import _TestSession
    from sqlalchemy import select as sa_select
    from app.models.service_provider import ServiceProvider
    from app.utils import login_throttle

    async with _TestSession() as db:
        provider = (await db.execute(
            sa_select(ServiceProvider).where(ServiceProvider.slug == "pytest-prf-provider")
        )).scalar_one()
        provider.portal_login_password_hash = hash_password("Portal-Throttle-2026!")
        await db.commit()
        slug = provider.slug

    login_throttle._MEM.clear()
    codes = []
    for _ in range(7):
        r = await client.post("/api/crew/portal-unlock",
                              json={"provider_slug": slug, "password": "wrong-guess"})
        codes.append(r.status_code)

    assert 403 in codes, f"the guessing source was never throttled: {codes}"
    login_throttle._MEM.clear()


# ════════════════════════════════════════════════════════════════════
# Rate limiter identity
# ════════════════════════════════════════════════════════════════════

def test_rate_limit_bucket_cannot_be_chosen_by_the_caller():
    """The key was sha256 of whatever followed 'Bearer ', unvalidated — so a
    fresh random nonce per request meant a fresh 600-request bucket per
    request, and the application limiter never fired for anyone."""
    from types import SimpleNamespace
    from app.middleware.rate_limit import RateLimitMiddleware

    mw = RateLimitMiddleware(app=None)

    def req(auth):
        return SimpleNamespace(
            headers={"authorization": auth, "x-real-ip": "203.0.113.9"},
            client=SimpleNamespace(host="203.0.113.9"),
        )

    a = mw._get_identity_key(req("Bearer nonce-one"))
    b = mw._get_identity_key(req("Bearer nonce-two"))
    assert a == b, "two forged tokens landed in different buckets"
    assert a.startswith("ip:"), "a forged token was accepted as an identity"

    from app.utils.security import create_access_token
    real = create_access_token({"sub": "11111111-1111-1111-1111-111111111111"})
    key = mw._get_identity_key(req(f"Bearer {real}"))
    assert key.startswith("tok:"), "a genuine token was not given its own bucket"


# ════════════════════════════════════════════════════════════════════
# Filesystem escape via provider slug
# ════════════════════════════════════════════════════════════════════

def test_provider_slug_cannot_traverse_out_of_the_upload_directory():
    """_slugify was applied only to a slug DERIVED from the name; an explicit
    slug was stored verbatim and later concatenated into a filesystem path."""
    from fastapi import HTTPException
    from app.api.providers import _validate_slug

    for bad in ("../../../../tmp/pwn", "a/b", "a\\b", "..", "with space",
                "-leading", "", "x" * 101, "null\x00byte"):
        with pytest.raises(HTTPException):
            _validate_slug(bad)

    # Case is NORMALISED, not rejected — a provider named "Netcare 911" should
    # onboard without an error message about capital letters.
    assert _validate_slug("Netcare-911") == "netcare-911"
    assert _validate_slug("er24") == "er24"
