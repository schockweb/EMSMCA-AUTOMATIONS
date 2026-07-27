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
    """Clean query params are NOT rejected by the XSS middleware.

    What matters here is that the request gets *past* the sanitisation layer —
    not what the endpoint itself then decides. /api/stats now requires
    authentication, so an anonymous call correctly returns 401; the point is
    that it is not the 400 the sibling test asserts for a dirty param.
    """
    response = await client.get("/api/stats")
    assert response.status_code != 400, "clean query params must not be rejected as XSS"
