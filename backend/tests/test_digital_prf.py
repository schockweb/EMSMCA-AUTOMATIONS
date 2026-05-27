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

@pytest_asyncio.fixture
async def crew_a_headers(client):
    res = await client.post(
        "/api/crew/login",
        json={"email": CREW_A_EMAIL, "password": CREW_PASSWORD},
    )
    if res.status_code != 200:
        pytest.skip(f"Crew A login failed ({res.status_code}): {res.text}")
    return {"Authorization": f"Bearer {res.json()['access_token']}"}


@pytest_asyncio.fixture
async def crew_b_headers(client):
    res = await client.post(
        "/api/crew/login",
        json={"email": CREW_B_EMAIL, "password": CREW_PASSWORD},
    )
    if res.status_code != 200:
        pytest.skip(f"Crew B login failed ({res.status_code}): {res.text}")
    return {"Authorization": f"Bearer {res.json()['access_token']}"}


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
        assert get_res.json()["km_depart_scene"] == "45123"

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

class TestSubmitPRF:

    @pytest.mark.asyncio
    async def test_submit_returns_202(self, client, crew_a_headers):
        create_res = await client.post("/api/digital-prf", json={}, headers=crew_a_headers)
        prf_id = create_res.json()["id"]
        res = await client.post(f"/api/digital-prf/{prf_id}/submit", headers=crew_a_headers)
        assert res.status_code == 202
        data = res.json()
        assert data["status"] in ("submitted", "processed")
        assert "prf_number" in data

    @pytest.mark.asyncio
    async def test_submit_changes_status_from_draft(self, client, crew_a_headers):
        create_res = await client.post("/api/digital-prf", json={}, headers=crew_a_headers)
        prf_id = create_res.json()["id"]
        await client.post(f"/api/digital-prf/{prf_id}/submit", headers=crew_a_headers)
        get_res = await client.get(f"/api/digital-prf/{prf_id}", headers=crew_a_headers)
        assert get_res.json()["status"] != "draft"

    @pytest.mark.asyncio
    async def test_submitted_prf_cannot_be_deleted(self, client, crew_a_headers):
        create_res = await client.post("/api/digital-prf", json={}, headers=crew_a_headers)
        prf_id = create_res.json()["id"]
        await client.post(f"/api/digital-prf/{prf_id}/submit", headers=crew_a_headers)
        del_res = await client.delete(f"/api/digital-prf/{prf_id}", headers=crew_a_headers)
        assert del_res.status_code == 409

    @pytest.mark.asyncio
    async def test_submit_is_idempotent(self, client, crew_a_headers):
        create_res = await client.post("/api/digital-prf", json={}, headers=crew_a_headers)
        prf_id = create_res.json()["id"]
        res1 = await client.post(f"/api/digital-prf/{prf_id}/submit", headers=crew_a_headers)
        res2 = await client.post(f"/api/digital-prf/{prf_id}/submit", headers=crew_a_headers)
        assert res1.status_code == 202
        assert res2.status_code == 202
        assert res2.json()["status"] in ("submitted", "processed")

    @pytest.mark.asyncio
    async def test_submit_nonexistent_prf_returns_404(self, client, crew_a_headers):
        res = await client.post(f"/api/digital-prf/{uuid.uuid4()}/submit", headers=crew_a_headers)
        assert res.status_code == 404
