"""
/api/metrics had no test at all, and returned 500 on every scrape.

The failed-PRF gauge compared against the literal 'failed'. SQLAlchemy's SAEnum
persists Python enum NAMES, so the Postgres type prf_status carries
DRAFT/SUBMITTED/PROCESSED/FAILED/CORRECTED, while PRFStatus.FAILED.value is the
lowercase "failed". Postgres answered InvalidTextRepresentationError, the
exception escaped, and ems_failed_prfs_total was never once recorded — for as
long as the endpoint has existed.

Nothing noticed because the endpoint is scraped by Prometheus rather than looked
at by a person, and a scrape failure is a silent gap in a graph.
"""
import pytest

from app.models.digital_prf import PRFStatus


@pytest.mark.asyncio
async def test_metrics_endpoint_returns_200(client):
    """The regression itself: this returned 500 on every request."""
    resp = await client.get("/api/metrics")
    assert resp.status_code == 200, (
        f"/api/metrics returned {resp.status_code}; body: {resp.text[:300]}"
    )


@pytest.mark.asyncio
async def test_metrics_reports_the_failed_prf_gauge(client):
    """A 200 alone is not enough — the gauge that was broken must be present."""
    resp = await client.get("/api/metrics")
    assert resp.status_code == 200
    body = resp.text
    assert "ems_failed_prfs_total" in body, "the failed-PRF gauge is missing"

    line = next(
        l for l in body.splitlines()
        if l.startswith("ems_failed_prfs_total ")
    )
    value = line.split()[1]
    assert value.isdigit(), f"gauge is not a number: {line!r}"


@pytest.mark.asyncio
async def test_metrics_is_valid_prometheus_exposition(client):
    resp = await client.get("/api/metrics")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/plain")
    for line in resp.text.splitlines():
        if line and not line.startswith("#"):
            assert len(line.split()) >= 2, f"malformed sample: {line!r}"


def test_postgres_enum_stores_names_not_values():
    """Pin the assumption the fix rests on.

    If SAEnum is ever switched to persist values, the fix must change with it —
    and this test says so instead of the endpoint silently 500ing again.
    """
    assert PRFStatus.FAILED.name == "FAILED"
    assert PRFStatus.FAILED.value == "failed"
    assert PRFStatus.FAILED.name != PRFStatus.FAILED.value, (
        "name and value now match, so this class of bug is no longer possible — "
        "but check the raw SQL in app/api/metrics.py before deleting this test"
    )
