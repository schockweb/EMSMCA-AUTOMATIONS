"""
Test: Rate Limiting & Security Middleware.
"""
import pytest


@pytest.mark.asyncio
async def test_xss_in_query_params(client):
    """XSS payload in query params is rejected."""
    response = await client.get("/api/stats?search=<script>alert(1)</script>")
    assert response.status_code == 400
    assert "unsafe" in response.json()["detail"].lower()


@pytest.mark.asyncio
async def test_xss_javascript_protocol(client):
    """Javascript: protocol in query params is rejected."""
    response = await client.get("/api/stats?url=javascript:alert(1)")
    assert response.status_code == 400


@pytest.mark.asyncio
async def test_xss_event_handler(client):
    """Event handler injection in query params is rejected."""
    response = await client.get('/api/stats?val=x" onerror="alert(1)')
    assert response.status_code == 400


@pytest.mark.asyncio
async def test_clean_query_params_allowed(client):
    """Normal query params pass through."""
    response = await client.get("/api/stats")
    assert response.status_code == 200
    data = response.json()
    assert "documents" in data
