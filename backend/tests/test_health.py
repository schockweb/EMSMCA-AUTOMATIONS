"""
Test: Health Check & Core API endpoints.
"""
import pytest


@pytest.mark.asyncio
async def test_root_health(client):
    """Root endpoint returns healthy status."""
    response = await client.get("/")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "healthy"
    assert data["version"] == "1.0.0"


@pytest.mark.asyncio
async def test_deep_health_check(client):
    """Deep health check verifies DB connectivity."""
    response = await client.get("/health")
    assert response.status_code in (200, 503)
    data = response.json()
    assert "database" in data
    assert "uptime_seconds" in data


@pytest.mark.asyncio
async def test_readiness_probe(client):
    """Readiness probe returns ready status."""
    response = await client.get("/health/ready")
    assert response.status_code in (200, 503)
    data = response.json()
    assert "ready" in data


@pytest.mark.asyncio
async def test_dashboard_stats_requires_no_auth(client):
    """Dashboard stats endpoint should be accessible (may return zeros)."""
    response = await client.get("/api/stats")
    assert response.status_code == 200
    data = response.json()
    assert "documents" in data
    assert "claims" in data
    assert "cases" in data
