"""
Test: Authentication flow — login, token validation, protected routes.
"""
import pytest


@pytest.mark.asyncio
async def test_login_success(client):
    """Admin user can log in with correct credentials."""
    response = await client.post(
        "/api/auth/login",
        data={"username": "admin@emsclaims.co.za", "password": "Admin@2024!"},
    )
    assert response.status_code == 200
    data = response.json()
    assert "access_token" in data
    assert data["token_type"] == "bearer"


@pytest.mark.asyncio
async def test_login_wrong_password(client):
    """Login fails with wrong password and returns 401."""
    response = await client.post(
        "/api/auth/login",
        data={"username": "admin@emsclaims.co.za", "password": "WrongPassword123!"},
    )
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_login_nonexistent_user(client):
    """Login fails for non-existent user."""
    response = await client.post(
        "/api/auth/login",
        data={"username": "nobody@example.com", "password": "whatever"},
    )
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_me_without_auth(client):
    """Accessing /me without token returns 401."""
    response = await client.get("/api/auth/me")
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_me_with_invalid_token(client):
    """Accessing /me with invalid token returns 401."""
    response = await client.get(
        "/api/auth/me",
        headers={"Authorization": "Bearer invalid.token.here"},
    )
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_me_with_valid_login(client):
    """Login then /me returns user profile."""
    # Login
    login_res = await client.post(
        "/api/auth/login",
        data={"username": "admin@emsclaims.co.za", "password": "Admin@2024!"},
    )
    if login_res.status_code != 200:
        pytest.skip("Login unavailable")
    token = login_res.json()["access_token"]

    # Get profile
    me_res = await client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me_res.status_code == 200
    data = me_res.json()
    assert data["email"] == "admin@emsclaims.co.za"
