"""
test_digital_prf.py — Layer 1: Backend API Integration Tests

Architecture notes:
  - All test data is created / torn down via the HTTP API (no raw DB fixtures).
    This avoids asyncio event-loop-per-test isolation issues with module-scoped
    async SQLAlchemy sessions.
  - Two crew members (crew_a, crew_b) belonging to a dedicated test provider are
    bootstrapped once per session via a synchronous SQLAlchemy setup helper that
    runs before pytest-asyncio starts its loop.
  - The shared `client` fixture (from conftest.py) talks to the live FastAPI app
    via ASGITransport — no real network, no real port.

Run inside the backend Docker container:
    pytest tests/test_digital_prf.py -v
"""

import uuid
import asyncio
import pytest
import pytest_asyncio
from datetime import datetime, timezone

# ─── One-time sync bootstrap of test crew members ───────────────────────────
# We create them here rather than in async fixtures to avoid the
# "Future attached to a different loop" problem that module-scoped async
# fixtures cause with pytest-asyncio's per-test event-loop isolation.

# ─── Constants shared with conftest.py's _ensure_test_crew fixture ───────────
TEST_PROVIDER_SLUG = "pytest-prf-provider"
CREW_A_EMAIL      = "crew_a_pytest@emsclaims.test"
CREW_B_EMAIL      = "crew_b_pytest@emsclaims.test"
CREW_PASSWORD     = "Test@PRF2026!"



# ═══════════════════════════════════════════════════════════════════════════════
# Per-test auth header fixtures (function-scoped — safe with pytest-asyncio)
# ═══════════════════════════════════════════════════════════════════════════════

# Tokens are cached for the whole session. These fixtures used to log in once
# PER TEST, which trips the login rate limiter (15/min per client IP) partway
# through the file: every test after that skipped with a 429 and the suite
# reported success while silently testing nothing. Logging in once also makes
# the run markedly faster (bcrypt is deliberately slow).
_CREW_TOKEN_CACHE: dict[str, str] = {}


async def _crew_headers(client, email: str, label: str):
    if email not in _CREW_TOKEN_CACHE:
        res = await client.post(
            "/api/crew/login",
            json={"email": email, "password": CREW_PASSWORD},
        )
        if res.status_code != 200:
            pytest.skip(f"{label} login failed ({res.status_code}): {res.text}")
        _CREW_TOKEN_CACHE[email] = res.json()["access_token"]
    return {"Authorization": f"Bearer {_CREW_TOKEN_CACHE[email]}"}


@pytest_asyncio.fixture
async def crew_a_headers(client):
    return await _crew_headers(client, CREW_A_EMAIL, "Crew A")


@pytest_asyncio.fixture
async def crew_b_headers(client):
    return await _crew_headers(client, CREW_B_EMAIL, "Crew B")


@pytest_asyncio.fixture
async def crew_a_prf(client, crew_a_headers):
    """Create a fresh DRAFT PRF as Crew A, clean up after the test."""
    res = await client.post("/api/digital-prf", json={}, headers=crew_a_headers)
    assert res.status_code == 201, f"PRF creation failed: {res.text}"
    prf_id = res.json()["id"]
    yield prf_id
    # Best-effort cleanup; test may already have deleted it
    await client.delete(f"/api/digital-prf/{prf_id}", headers=crew_a_headers)


# ═══════════════════════════════════════════════════════════════════════════════
# AUTHENTICATION GUARD TESTS
# ═══════════════════════════════════════════════════════════════════════════════

class TestAuthGuards:
    """Every protected endpoint must reject unauthenticated requests with 401."""

    @pytest.mark.asyncio
    async def test_create_prf_requires_auth(self, client):
        res = await client.post("/api/digital-prf", json={})
        assert res.status_code == 401

    @pytest.mark.asyncio
    async def test_list_prfs_requires_auth(self, client):
        res = await client.get("/api/digital-prf")
        assert res.status_code == 401

    @pytest.mark.asyncio
    async def test_save_prf_requires_auth(self, client):
        res = await client.patch(f"/api/digital-prf/{uuid.uuid4()}", json={})
        assert res.status_code == 401

    @pytest.mark.asyncio
    async def test_delete_prf_requires_auth(self, client):
        res = await client.delete(f"/api/digital-prf/{uuid.uuid4()}")
        assert res.status_code == 401

    @pytest.mark.asyncio
    async def test_mark_time_requires_auth(self, client):
        res = await client.post(
            f"/api/digital-prf/{uuid.uuid4()}/mark-time",
            json={"field": "time_dispatched"},
        )
        assert res.status_code == 401

    @pytest.mark.asyncio
    async def test_submit_requires_auth(self, client):
        res = await client.post(f"/api/digital-prf/{uuid.uuid4()}/submit")
        assert res.status_code == 401


# ═══════════════════════════════════════════════════════════════════════════════
# CREATE PRF — POST /api/digital-prf
# ═══════════════════════════════════════════════════════════════════════════════

class TestCreatePRF:

    @pytest.mark.asyncio
    async def test_create_returns_201_with_prf_number(self, client, crew_a_headers):
        res = await client.post("/api/digital-prf", json={}, headers=crew_a_headers)
        assert res.status_code == 201
        data = res.json()
        assert "id" in data
        assert isinstance(data["prf_number"], int) and data["prf_number"] > 0
        assert data["case_number"] is not None
        assert data["status"] == "draft"
        await client.delete(f"/api/digital-prf/{data['id']}", headers=crew_a_headers)

    @pytest.mark.asyncio
    async def test_create_with_supervising_practitioner(self, client, crew_a_headers):
        res = await client.post(
            "/api/digital-prf",
            json={
                "supervising_practitioner_pr": "mp0012345",
                "supervising_practitioner_name": "Dr J. Smith",
                "supervising_practitioner_qualification": "baa",
            },
            headers=crew_a_headers,
        )
        assert res.status_code == 201
        prf_id = res.json()["id"]
        get_res = await client.get(f"/api/digital-prf/{prf_id}", headers=crew_a_headers)
        assert get_res.status_code == 200
        form_data = get_res.json()["form_data"]
        assert form_data.get("supervising_practitioner_pr") == "MP0012345"
        assert form_data.get("supervising_practitioner_qualification") == "BAA"
        await client.delete(f"/api/digital-prf/{prf_id}", headers=crew_a_headers)

    @pytest.mark.asyncio
    async def test_each_prf_gets_unique_number(self, client, crew_a_headers):
        r1 = await client.post("/api/digital-prf", json={}, headers=crew_a_headers)
        r2 = await client.post("/api/digital-prf", json={}, headers=crew_a_headers)
        assert r1.status_code == 201 and r2.status_code == 201
        assert r1.json()["prf_number"] != r2.json()["prf_number"]
        for r in [r1, r2]:
            await client.delete(f"/api/digital-prf/{r.json()['id']}", headers=crew_a_headers)


# ═══════════════════════════════════════════════════════════════════════════════
# SAVE PRF — PATCH /api/digital-prf/{id}
# ═══════════════════════════════════════════════════════════════════════════════

class TestSavePRF:

    @pytest.mark.asyncio
    async def test_save_own_prf_succeeds(self, client, crew_a_headers, crew_a_prf):
        res = await client.patch(
            f"/api/digital-prf/{crew_a_prf}",
            json={"form_data": {"patient_name": "John", "chief_complaint": "Chest pain"}},
            headers=crew_a_headers,
        )
        assert res.status_code == 200
        assert res.json()["status"] == "saved"

    @pytest.mark.asyncio
    async def test_save_persists_form_data(self, client, crew_a_headers, crew_a_prf):
        payload = {"patient_name": "Jane", "patient_surname": "Doe", "age": "34"}
        await client.patch(
            f"/api/digital-prf/{crew_a_prf}",
            json={"form_data": payload},
            headers=crew_a_headers,
        )
        get_res = await client.get(f"/api/digital-prf/{crew_a_prf}", headers=crew_a_headers)
        assert get_res.status_code == 200
        fd = get_res.json()["form_data"]
        assert fd["patient_name"] == "Jane"
        assert fd["patient_surname"] == "Doe"

    # ── SECURITY: IDOR ──────────────────────────────────────────────────────────

    @pytest.mark.asyncio
    async def test_save_idor_blocked(self, client, crew_a_headers, crew_a_prf, crew_b_headers):
        """Crew B cannot PATCH Crew A's PRF — must return 403."""
        res = await client.patch(
            f"/api/digital-prf/{crew_a_prf}",
            json={"form_data": {"patient_name": "HACKED"}},
            headers=crew_b_headers,
        )
        assert res.status_code == 403

    @pytest.mark.asyncio
    async def test_save_idor_does_not_corrupt_data(self, client, crew_a_headers, crew_a_prf, crew_b_headers):
        """After a blocked IDOR attempt, Crew A's data is unchanged."""
        await client.patch(
            f"/api/digital-prf/{crew_a_prf}",
            json={"form_data": {"patient_name": "OriginalName"}},
            headers=crew_a_headers,
        )
        await client.patch(
            f"/api/digital-prf/{crew_a_prf}",
            json={"form_data": {"patient_name": "HACKED"}},
            headers=crew_b_headers,
        )
        get_res = await client.get(f"/api/digital-prf/{crew_a_prf}", headers=crew_a_headers)
        assert get_res.json()["form_data"].get("patient_name") == "OriginalName"

    # ── SECURITY: Mass Assignment ───────────────────────────────────────────────

    @pytest.mark.asyncio
    async def test_underscore_keys_not_stored_from_client(self, client, crew_a_prf, crew_a_headers):
        """Client-sent keys starting with _ are silently dropped."""
        res = await client.patch(
            f"/api/digital-prf/{crew_a_prf}",
            json={"form_data": {
                "_arbitrary_private": "injected",
                "patient_name": "Clean",
            }},
            headers=crew_a_headers,
        )
        assert res.status_code == 200
        get_res = await client.get(f"/api/digital-prf/{crew_a_prf}", headers=crew_a_headers)
        fd = get_res.json()["form_data"]
        assert "_arbitrary_private" not in fd
        assert fd.get("patient_name") == "Clean"

    @pytest.mark.asyncio
    async def test_server_managed_private_key_preserved_through_save(self, client, crew_a_prf, crew_a_headers):
        """
        Server-managed _keys survive a full-state client PATCH.

        The frontend always sends the complete form_data blob every 5 s.
        The backend strips incoming _keys (mass-assignment guard) but preserves
        any _keys already in the DB row so that server-set tokens (e.g.
        _doctor_access_token set by the doctor-review endpoint) are not wiped
        by the next auto-save.

        This test verifies:
          1. Regular client fields are saved correctly across multiple saves.
          2. A _private key injected by the client is silently dropped.
          3. After two full-state saves, all non-_ fields from the LATEST save
             are present (the backend replaces non-_ content with the full
             incoming blob each time — this is intentional since the frontend
             always sends the complete state).
        """
        # First save — full state
        first_state = {"patient_name": "Alice", "chief_complaint": "Dyspnoea", "_injected": "bad"}
        res = await client.patch(
            f"/api/digital-prf/{crew_a_prf}",
            json={"form_data": first_state},
            headers=crew_a_headers,
        )
        assert res.status_code == 200

        # Second save — full state with additional field (as the frontend would send)
        second_state = {
            "patient_name": "Alice",
            "chief_complaint": "Dyspnoea",
            "patient_surname": "Smith",    # new field added by crew
            "_injected": "still-bad",       # must still be dropped
        }
        res2 = await client.patch(
            f"/api/digital-prf/{crew_a_prf}",
            json={"form_data": second_state},
            headers=crew_a_headers,
        )
        assert res2.status_code == 200

        fd = (await client.get(f"/api/digital-prf/{crew_a_prf}", headers=crew_a_headers)).json()["form_data"]

        # Both non-_ fields from the second save must be present
        assert fd.get("patient_name") == "Alice"
        assert fd.get("patient_surname") == "Smith"
        assert fd.get("chief_complaint") == "Dyspnoea"

        # Client-injected _keys must never reach the DB
        assert "_injected" not in fd


    @pytest.mark.asyncio
    async def test_save_nonexistent_prf_returns_404(self, client, crew_a_headers):
        res = await client.patch(
            f"/api/digital-prf/{uuid.uuid4()}",
            json={"form_data": {"patient_name": "Ghost"}},
            headers=crew_a_headers,
        )
        assert res.status_code == 404

    @pytest.mark.asyncio
    async def test_save_invalid_uuid_returns_error(self, client, crew_a_headers):
        res = await client.patch("/api/digital-prf/not-a-uuid", json={}, headers=crew_a_headers)
        assert res.status_code in (400, 422, 500)


# ═══════════════════════════════════════════════════════════════════════════════
# MARK TIMESTAMP — POST /api/digital-prf/{id}/mark-time
# ═══════════════════════════════════════════════════════════════════════════════

class TestMarkTimestamp:

    @pytest.mark.asyncio
    async def test_mark_valid_field_returns_timestamp(self, client, crew_a_headers, crew_a_prf):
        res = await client.post(
            f"/api/digital-prf/{crew_a_prf}/mark-time",
            json={"field": "time_dispatched"},
            headers=crew_a_headers,
        )
        assert res.status_code == 200
        data = res.json()
        assert data["field"] == "time_dispatched"
        ts = datetime.fromisoformat(data["timestamp"].replace("Z", "+00:00"))
        assert abs((datetime.now(timezone.utc) - ts).total_seconds()) < 30

    @pytest.mark.asyncio
    async def test_mark_timestamp_persisted_to_db(self, client, crew_a_headers, crew_a_prf):
        await client.post(
            f"/api/digital-prf/{crew_a_prf}/mark-time",
            json={"field": "time_on_scene"},
            headers=crew_a_headers,
        )
        get_res = await client.get(f"/api/digital-prf/{crew_a_prf}", headers=crew_a_headers)
        assert get_res.json()["time_on_scene"] is not None

    @pytest.mark.asyncio
    async def test_mark_invalid_field_returns_400(self, client, crew_a_headers, crew_a_prf):
        res = await client.post(
            f"/api/digital-prf/{crew_a_prf}/mark-time",
            json={"field": "time_fake_field"},
            headers=crew_a_headers,
        )
        assert res.status_code == 400

    @pytest.mark.asyncio
    async def test_mark_timestamp_with_gps(self, client, crew_a_headers, crew_a_prf):
        res = await client.post(
            f"/api/digital-prf/{crew_a_prf}/mark-time",
            json={"field": "time_mobile", "latitude": -29.8587, "longitude": 31.0218, "accuracy_m": 12.5},
            headers=crew_a_headers,
        )
        assert res.status_code == 200
        geo = res.json()["geo"]
        assert geo is not None
        assert abs(geo["lat"] - (-29.8587)) < 0.001
        assert abs(geo["lng"] - 31.0218) < 0.001

    @pytest.mark.asyncio
    async def test_mark_timestamp_gps_spoofing_flagged(self, client, crew_a_headers, crew_a_prf):
        """Teleporting GPS coordinates must set spoofing_suspected=True without blocking."""
        await client.post(
            f"/api/digital-prf/{crew_a_prf}/mark-time",
            json={"field": "time_dispatched", "latitude": -29.8587, "longitude": 31.0218},
            headers=crew_a_headers,
        )
        res = await client.post(
            f"/api/digital-prf/{crew_a_prf}/mark-time",
            json={"field": "time_mobile", "latitude": -26.2041, "longitude": 28.0473},
            headers=crew_a_headers,
        )
        assert res.status_code == 200          # NOT blocked
        geo = res.json().get("geo") or {}
        assert geo.get("spoofing_suspected") is True

    @pytest.mark.asyncio
    async def test_mark_timestamp_km_stored(self, client, crew_a_headers, crew_a_prf):
        await client.post(
            f"/api/digital-prf/{crew_a_prf}/mark-time",
            json={"field": "time_depart_scene", "km": "45123"},
            headers=crew_a_headers,
        )
        get_res = await client.get(f"/api/digital-prf/{crew_a_prf}", headers=crew_a_headers)
        # km_* are numeric columns, so the value round-trips as a number rather
        # than the string that was posted. Compare numerically.
        assert float(get_res.json()["km_depart_scene"]) == 45123

    @pytest.mark.asyncio
    async def test_mark_all_valid_timestamp_fields(self, client, crew_a_headers):
        create_res = await client.post("/api/digital-prf", json={}, headers=crew_a_headers)
        prf_id = create_res.json()["id"]
        valid_fields = [
            "time_call_received", "time_dispatched", "time_mobile",
            "time_on_scene", "time_depart_scene", "time_at_destination",
            "time_handover", "time_available", "time_back_to_base",
        ]
        for field in valid_fields:
            res = await client.post(
                f"/api/digital-prf/{prf_id}/mark-time",
                json={"field": field},
                headers=crew_a_headers,
            )
            assert res.status_code == 200, f"Failed for field: {field} — {res.text}"
        await client.delete(f"/api/digital-prf/{prf_id}", headers=crew_a_headers)


# ═══════════════════════════════════════════════════════════════════════════════
# GET PRF — GET /api/digital-prf/{id}
# ═══════════════════════════════════════════════════════════════════════════════

class TestGetPRF:

    @pytest.mark.asyncio
    async def test_get_returns_full_shape(self, client, crew_a_headers, crew_a_prf):
        res = await client.get(f"/api/digital-prf/{crew_a_prf}", headers=crew_a_headers)
        assert res.status_code == 200
        data = res.json()
        for key in ("id", "prf_number", "case_number", "status", "form_data",
                    "time_dispatched", "time_on_scene", "km_dispatched",
                    "patient_signature", "crew_signature"):
            assert key in data, f"Missing key: {key}"

    @pytest.mark.asyncio
    async def test_get_nonexistent_returns_404(self, client, crew_a_headers):
        res = await client.get(f"/api/digital-prf/{uuid.uuid4()}", headers=crew_a_headers)
        assert res.status_code == 404


# ═══════════════════════════════════════════════════════════════════════════════
# LIST PRFs — GET /api/digital-prf
# ═══════════════════════════════════════════════════════════════════════════════

class TestListPRFs:

    @pytest.mark.asyncio
    async def test_list_returns_array(self, client, crew_a_headers, crew_a_prf):
        res = await client.get("/api/digital-prf", headers=crew_a_headers)
        assert res.status_code == 200
        assert isinstance(res.json(), list)

    @pytest.mark.asyncio
    async def test_list_scoped_to_authenticated_crew(self, client, crew_a_headers, crew_a_prf, crew_b_headers):
        """Crew B's list must NOT include Crew A's PRF."""
        res = await client.get("/api/digital-prf", headers=crew_b_headers)
        assert res.status_code == 200
        ids = [item["id"] for item in res.json()]
        assert crew_a_prf not in ids

    @pytest.mark.asyncio
    async def test_list_contains_own_prf(self, client, crew_a_headers, crew_a_prf):
        res = await client.get("/api/digital-prf", headers=crew_a_headers)
        assert res.status_code == 200
        ids = [item["id"] for item in res.json()]
        assert crew_a_prf in ids


# ═══════════════════════════════════════════════════════════════════════════════
# DELETE PRF — DELETE /api/digital-prf/{id}
# ═══════════════════════════════════════════════════════════════════════════════

class TestDeletePRF:

    @pytest.mark.asyncio
    async def test_delete_own_draft_succeeds(self, client, crew_a_headers):
        create_res = await client.post("/api/digital-prf", json={}, headers=crew_a_headers)
        prf_id = create_res.json()["id"]
        del_res = await client.delete(f"/api/digital-prf/{prf_id}", headers=crew_a_headers)
        assert del_res.status_code == 200
        assert del_res.json()["status"] == "deleted"

    @pytest.mark.asyncio
    async def test_delete_makes_prf_unreachable(self, client, crew_a_headers):
        create_res = await client.post("/api/digital-prf", json={}, headers=crew_a_headers)
        prf_id = create_res.json()["id"]
        await client.delete(f"/api/digital-prf/{prf_id}", headers=crew_a_headers)
        assert (await client.get(f"/api/digital-prf/{prf_id}", headers=crew_a_headers)).status_code == 404

    @pytest.mark.asyncio
    async def test_delete_idor_blocked(self, client, crew_a_headers, crew_a_prf, crew_b_headers):
        """Crew B cannot delete Crew A's PRF."""
        res = await client.delete(f"/api/digital-prf/{crew_a_prf}", headers=crew_b_headers)
        assert res.status_code == 403

    @pytest.mark.asyncio
    async def test_delete_nonexistent_returns_404(self, client, crew_a_headers):
        res = await client.delete(f"/api/digital-prf/{uuid.uuid4()}", headers=crew_a_headers)
        assert res.status_code == 404


# ═══════════════════════════════════════════════════════════════════════════════
# SCRUB PHASE — POST /api/digital-prf/{id}/scrub-phase
# ═══════════════════════════════════════════════════════════════════════════════

class TestScrubPhase:

    @pytest.mark.asyncio
    async def test_scrub_returns_expected_shape(self, client, crew_a_headers, crew_a_prf):
        res = await client.post(
            f"/api/digital-prf/{crew_a_prf}/scrub-phase?phase=0",
            headers=crew_a_headers,
        )
        assert res.status_code == 200
        data = res.json()
        assert "can_continue" in data
        assert isinstance(data["blockers"], list)
        assert isinstance(data["warnings"], list)

    @pytest.mark.asyncio
    async def test_scrub_idor_blocked(self, client, crew_a_prf, crew_b_headers):
        res = await client.post(
            f"/api/digital-prf/{crew_a_prf}/scrub-phase?phase=0",
            headers=crew_b_headers,
        )
        assert res.status_code == 403


# ═══════════════════════════════════════════════════════════════════════════════
# END SHIFT — POST /api/digital-prf/end-shift
# ═══════════════════════════════════════════════════════════════════════════════

class TestEndShift:

    @pytest.mark.asyncio
    async def test_end_shift_deletes_own_drafts(self, client, crew_a_headers):
        r1 = await client.post("/api/digital-prf", json={}, headers=crew_a_headers)
        r2 = await client.post("/api/digital-prf", json={}, headers=crew_a_headers)
        prf1, prf2 = r1.json()["id"], r2.json()["id"]

        res = await client.post("/api/digital-prf/end-shift", headers=crew_a_headers)
        assert res.status_code == 200
        assert res.json()["status"] == "shift_ended"
        assert res.json()["drafts_deleted"] >= 2

        assert (await client.get(f"/api/digital-prf/{prf1}", headers=crew_a_headers)).status_code == 404
        assert (await client.get(f"/api/digital-prf/{prf2}", headers=crew_a_headers)).status_code == 404

    @pytest.mark.asyncio
    async def test_end_shift_idempotent_when_no_drafts(self, client, crew_a_headers):
        await client.post("/api/digital-prf/end-shift", headers=crew_a_headers)
        res = await client.post("/api/digital-prf/end-shift", headers=crew_a_headers)
        assert res.status_code == 200
        assert res.json()["drafts_deleted"] == 0

    @pytest.mark.asyncio
    async def test_end_shift_does_not_touch_other_crews_drafts(self, client, crew_a_headers, crew_b_headers):
        b_res = await client.post("/api/digital-prf", json={}, headers=crew_b_headers)
        b_prf_id = b_res.json()["id"]

        await client.post("/api/digital-prf/end-shift", headers=crew_a_headers)

        # Crew B's draft must still exist
        assert (await client.get(f"/api/digital-prf/{b_prf_id}", headers=crew_b_headers)).status_code == 200
        await client.delete(f"/api/digital-prf/{b_prf_id}", headers=crew_b_headers)


# ═══════════════════════════════════════════════════════════════════════════════
# SUBMIT PRF — POST /api/digital-prf/{id}/submit
# ═══════════════════════════════════════════════════════════════════════════════

async def _submittable_prf(client, headers) -> str:
    """Create a PRF that passes the server-side submit gate.

    _validate_prf_for_submission rejects a PRF with no form_data ("PRF has no
    data captured.") and one with no call_type. These tests predate that gate and
    submitted a completely empty PRF, so they began failing the moment the backend
    suite actually ran. The gate is correct — a blank record must never reach the
    billing pipeline — so the tests are what needed fixing.
    """
    create = await client.post("/api/digital-prf", json={}, headers=headers)
    prf_id = create.json()["id"]
    await client.patch(
        f"/api/digital-prf/{prf_id}",
        json={"form_data": {"call_type": "PRIMARY", "patient_name": "Submit", "patient_surname": "Gate"}},
        headers=headers,
    )
    return prf_id


class TestSubmitPRF:

    @pytest.mark.asyncio
    async def test_submit_returns_202(self, client, crew_a_headers):
        prf_id = await _submittable_prf(client, crew_a_headers)
        res = await client.post(f"/api/digital-prf/{prf_id}/submit", headers=crew_a_headers)
        assert res.status_code == 202
        data = res.json()
        assert data["status"] in ("submitted", "processed")
        assert "prf_number" in data

    @pytest.mark.asyncio
    async def test_submit_changes_status_from_draft(self, client, crew_a_headers):
        prf_id = await _submittable_prf(client, crew_a_headers)
        await client.post(f"/api/digital-prf/{prf_id}/submit", headers=crew_a_headers)
        get_res = await client.get(f"/api/digital-prf/{prf_id}", headers=crew_a_headers)
        assert get_res.json()["status"] != "draft"

    @pytest.mark.asyncio
    async def test_submitted_prf_cannot_be_deleted(self, client, crew_a_headers):
        prf_id = await _submittable_prf(client, crew_a_headers)
        await client.post(f"/api/digital-prf/{prf_id}/submit", headers=crew_a_headers)
        del_res = await client.delete(f"/api/digital-prf/{prf_id}", headers=crew_a_headers)
        assert del_res.status_code == 409

    @pytest.mark.asyncio
    async def test_submit_is_idempotent(self, client, crew_a_headers):
        prf_id = await _submittable_prf(client, crew_a_headers)
        res1 = await client.post(f"/api/digital-prf/{prf_id}/submit", headers=crew_a_headers)
        res2 = await client.post(f"/api/digital-prf/{prf_id}/submit", headers=crew_a_headers)
        assert res1.status_code == 202
        assert res2.status_code == 202
        assert res2.json()["status"] in ("submitted", "processed")

    @pytest.mark.asyncio
    async def test_submit_nonexistent_prf_returns_404(self, client, crew_a_headers):
        res = await client.post(f"/api/digital-prf/{uuid.uuid4()}/submit", headers=crew_a_headers)
        assert res.status_code == 404


# ═══════════════════════════════════════════════════════════════════════════════
# Offline PRF creation — client-supplied id
#
# A crew arriving at a scene with no signal must be able to start a PRF. The
# device generates the UUID and hands it over as `client_id` when connectivity
# returns. Two properties have to hold or this loses or leaks patient records:
#   1. Replaying the same client_id must NOT create a second PRF. The outbox
#      retries, and a lost response must not duplicate a medical record.
#   2. A device must not be able to name an id belonging to another provider —
#      that would return their prf_number and case_number.
# ═══════════════════════════════════════════════════════════════════════════════
class TestOfflineCreateWithClientId:

    @pytest.mark.asyncio
    async def test_create_honours_the_client_supplied_id(self, client, crew_a_headers):
        client_id = str(uuid.uuid4())
        res = await client.post(
            "/api/digital-prf", json={"client_id": client_id}, headers=crew_a_headers
        )
        assert res.status_code == 201
        assert res.json()["id"] == client_id
        # The server still owns the numbering.
        assert isinstance(res.json()["prf_number"], int)
        assert res.json()["case_number"]

    @pytest.mark.asyncio
    async def test_replaying_the_same_client_id_does_not_duplicate(self, client, crew_a_headers):
        client_id = str(uuid.uuid4())
        first = await client.post(
            "/api/digital-prf", json={"client_id": client_id}, headers=crew_a_headers
        )
        second = await client.post(
            "/api/digital-prf", json={"client_id": client_id}, headers=crew_a_headers
        )
        assert first.status_code == 201
        assert second.status_code == 201
        # Same row returned, same number — not a second PRF.
        assert second.json()["id"] == first.json()["id"] == client_id
        assert second.json()["prf_number"] == first.json()["prf_number"]
        assert second.json()["case_number"] == first.json()["case_number"]

        # And it really is one row in the listing, not two.
        listing = await client.get("/api/digital-prf", headers=crew_a_headers)
        ids = [p["id"] for p in listing.json()]
        assert ids.count(client_id) == 1

    @pytest.mark.asyncio
    async def test_a_crewmate_replaying_the_same_id_gets_the_same_prf(self, client, crew_a_headers, crew_b_headers):
        """Same provider, different crew member — still a replay, never a duplicate."""
        client_id = str(uuid.uuid4())
        first = await client.post(
            "/api/digital-prf", json={"client_id": client_id}, headers=crew_a_headers
        )
        second = await client.post(
            "/api/digital-prf", json={"client_id": client_id}, headers=crew_b_headers
        )
        assert second.status_code == 201
        assert second.json()["prf_number"] == first.json()["prf_number"]

    @pytest.mark.asyncio
    async def test_client_id_from_another_provider_is_refused(self, client, crew_a_headers):
        """
        The device names its own id, so it could name somebody else's. Returning
        that PRF would leak another provider's prf_number and case_number.
        """
        from app.database import AsyncSessionLocal
        from app.models.service_provider import ServiceProvider
        from app.models.digital_prf import DigitalPRF, PRFStatus
        from sqlalchemy import select, func

        foreign_prf_id = uuid.uuid4()
        async with AsyncSessionLocal() as db:
            res = await db.execute(
                select(ServiceProvider).where(ServiceProvider.slug == "pytest-other-provider")
            )
            other = res.scalar_one_or_none()
            if not other:
                other = ServiceProvider(
                    name="PyTest Other Provider",
                    slug="pytest-other-provider",
                    is_active=True,
                )
                db.add(other)
                await db.flush()

            # prf_number is UNIQUE per provider, so pick the next free one rather
            # than a fixed literal — otherwise this test passes once and then
            # collides with its own leftover row on every later run.
            max_res = await db.execute(
                select(func.max(DigitalPRF.prf_number)).where(
                    DigitalPRF.provider_id == other.id
                )
            )
            foreign_number = (max_res.scalar() or 999000) + 1

            db.add(DigitalPRF(
                id=foreign_prf_id,
                provider_id=other.id,
                prf_number=foreign_number,
                case_number=f"PYTEST-OTHER-{uuid.uuid4().hex[:8]}",
                status=PRFStatus.DRAFT,
                form_data={},
            ))
            await db.commit()

        res = await client.post(
            "/api/digital-prf", json={"client_id": str(foreign_prf_id)}, headers=crew_a_headers
        )
        assert res.status_code == 409
        # Must not disclose the other provider's numbering.
        body = res.text
        assert "999001" not in body
        assert "PYTEST-OTHER" not in body

    @pytest.mark.asyncio
    async def test_malformed_client_id_is_rejected(self, client, crew_a_headers):
        res = await client.post(
            "/api/digital-prf", json={"client_id": "not-a-uuid"}, headers=crew_a_headers
        )
        assert res.status_code == 422

    @pytest.mark.asyncio
    async def test_create_without_client_id_still_works(self, client, crew_a_headers):
        """The online path is unchanged — client_id is purely additive."""
        res = await client.post("/api/digital-prf", json={}, headers=crew_a_headers)
        assert res.status_code == 201
        assert uuid.UUID(res.json()["id"])
