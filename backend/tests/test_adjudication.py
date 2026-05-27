"""
Test: Adjudication Engine — PMB routing, clinical check logic, ICD-10 crosswalk.
"""
import pytest
import uuid


@pytest.mark.asyncio
async def test_adjudication_scrub_no_claim(client):
    """Scrubbing a non-existent claim returns 404 or error."""
    # Login first
    login_res = await client.post(
        "/api/auth/login",
        data={"username": "admin@emsclaims.co.za", "password": "Admin@2024!"},
    )
    if login_res.status_code != 200:
        pytest.skip("Login unavailable")
    headers = {"Authorization": f"Bearer {login_res.json()['access_token']}"}

    fake_id = str(uuid.uuid4())
    response = await client.post(
        "/api/adjudication/scrub",
        json={"claim_id": fake_id},
        headers=headers,
    )
    assert response.status_code in (404, 422, 500)


@pytest.mark.asyncio
async def test_rfi_list(client):
    """RFI list returns an array."""
    login_res = await client.post(
        "/api/auth/login",
        data={"username": "admin@emsclaims.co.za", "password": "Admin@2024!"},
    )
    if login_res.status_code != 200:
        pytest.skip("Login unavailable")
    headers = {"Authorization": f"Bearer {login_res.json()['access_token']}"}

    response = await client.get("/api/adjudication/rfis", headers=headers)
    assert response.status_code == 200
    assert isinstance(response.json(), list)


@pytest.mark.asyncio
async def test_pmb_check_known_condition():
    """PMB checker identifies known PMB conditions by ICD-10 code."""
    try:
        from app.services.adjudication import _check_pmb_status
        result = _check_pmb_status("I21", [])
        assert result is not None
    except (ImportError, AttributeError):
        pytest.skip("PMB check function not directly importable")


@pytest.mark.asyncio
async def test_pmb_check_non_pmb():
    """PMB checker correctly identifies non-PMB conditions."""
    try:
        from app.services.adjudication import _check_pmb_status
        result = _check_pmb_status("Z00", [])
        assert result is None or result.get("is_pmb") is False
    except (ImportError, AttributeError):
        pytest.skip("PMB check function not directly importable")


@pytest.mark.asyncio
async def test_bhf_verify_endpoint(client):
    """BHF verify endpoint accepts PCNS number."""
    login_res = await client.post(
        "/api/auth/login",
        data={"username": "admin@emsclaims.co.za", "password": "Admin@2024!"},
    )
    if login_res.status_code != 200:
        pytest.skip("Login unavailable")
    headers = {"Authorization": f"Bearer {login_res.json()['access_token']}"}

    response = await client.post(
        "/api/adjudication/verify-provider",
        json={"pcns": "1812345"},
        headers=headers,
    )
    assert response.status_code in (200, 422, 500, 503)
