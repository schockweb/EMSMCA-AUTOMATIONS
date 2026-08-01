"""
GET /api/providers must not get slower as the business grows.

The handler counted crew, vehicles and PRFs, and looked up an admin email,
INSIDE the loop over providers — each awaited before the next began. Five
sequential round-trips per tenant. At the 105 tenants this platform is sized
for that is 421 round-trips for one page load, and the page degrades in direct
proportion to how many customers there are.

The assertion here is deliberately RELATIVE: the same request is measured with
a small number of providers and again with more, and the query count must not
move. An absolute budget would need editing every time an unrelated query is
added elsewhere in the request, and would eventually be raised rather than
investigated — which is how an N+1 gets reintroduced.
"""
import uuid

import pytest
import pytest_asyncio
from sqlalchemy import event, select

from app.models.crew_member import CrewMember
from app.models.service_provider import ServiceProvider
from app.models.vehicle import Vehicle

pytestmark = pytest.mark.asyncio

_SLUG_PREFIX = "qc-tenant-"


class _QueryCounter:
    """Count SQL statements issued while the block is active."""

    def __init__(self, engine):
        self._sync_engine = engine.sync_engine
        self.count = 0

    def _on_execute(self, conn, cursor, statement, params, context, executemany):  # noqa: ARG002
        self.count += 1

    def __enter__(self):
        event.listen(self._sync_engine, "before_cursor_execute", self._on_execute)
        return self

    def __exit__(self, *exc):
        event.remove(self._sync_engine, "before_cursor_execute", self._on_execute)
        return False


async def _add_tenants(db, n: int, start: int) -> None:
    """A provider with a crew member and a vehicle — enough that every count in
    the handler has something to find for it."""
    for i in range(start, start + n):
        provider = ServiceProvider(
            name=f"QC Tenant {i}",
            slug=f"{_SLUG_PREFIX}{i}",
            pr_number=f"QC-PR-{i}",
            is_active=True,
        )
        db.add(provider)
        await db.flush()
        db.add(CrewMember(
            provider_id=provider.id,
            full_name=f"QC Crew {i}",
            email=f"qc-crew-{i}@emsclaims.test",
            initials="QC",
            qualification="AEA",
            hpcsa_number=f"QCT{i:05d}",
            role="admin",
            hashed_password="x" * 60,
        ))
        db.add(Vehicle(
            provider_id=provider.id,
            callsign=f"QC{i}",
            registration=f"QC{i:04d}GP",
            vehicle_type="Ambulance",
        ))
    await db.flush()


@pytest_asyncio.fixture
async def tenant_cleanup():
    from tests.conftest import _TestSession

    yield

    async with _TestSession() as db:
        providers = (await db.execute(
            select(ServiceProvider).where(ServiceProvider.slug.like(f"{_SLUG_PREFIX}%"))
        )).scalars().all()
        for provider in providers:
            for model in (Vehicle, CrewMember):
                for row in (await db.execute(
                    select(model).where(model.provider_id == provider.id)
                )).scalars().all():
                    await db.delete(row)
            await db.flush()
            await db.delete(provider)
        await db.commit()


async def test_provider_list_query_count_is_flat_in_tenant_count(
    client, auth_headers, tenant_cleanup
):
    from tests.conftest import _TestSession, _test_engine

    async with _TestSession() as db:
        await _add_tenants(db, 2, start=1000)
        await db.commit()

    with _QueryCounter(_test_engine) as small:
        res = await client.get("/api/providers", params={"_qc": "1"}, headers=auth_headers)
    assert res.status_code == 200, res.text
    baseline_providers = len(res.json())

    async with _TestSession() as db:
        await _add_tenants(db, 8, start=2000)
        await db.commit()

    with _QueryCounter(_test_engine) as large:
        res = await client.get("/api/providers", params={"_qc": "2"}, headers=auth_headers)
    assert res.status_code == 200, res.text
    assert len(res.json()) == baseline_providers + 8, "the extra tenants are not in the response"

    assert large.count == small.count, (
        f"query count grew from {small.count} to {large.count} when 8 tenants were "
        f"added — the handler is issuing work per provider. That is "
        f"{(large.count - small.count) / 8:.0f} extra round-trips per tenant, so a "
        f"105-tenant instance pays ~{small.count + 105 * (large.count - small.count) / 8:.0f} "
        f"for one page load."
    )


async def test_provider_list_still_reports_the_right_counts(
    client, auth_headers, tenant_cleanup
):
    """Batching the counts must not change what they say.

    Rewriting per-row lookups as grouped aggregates is exactly the change that
    silently returns 0 for everyone — a dict keyed by the wrong type, a missing
    GROUP BY — and a query-count test alone would happily pass through that.
    """
    from tests.conftest import _TestSession

    async with _TestSession() as db:
        await _add_tenants(db, 1, start=3000)
        await db.commit()

    res = await client.get("/api/providers", params={"_qc": "3"}, headers=auth_headers)
    assert res.status_code == 200, res.text

    row = next(p for p in res.json() if p["slug"] == f"{_SLUG_PREFIX}3000")
    assert row["crew_count"] == 1, row
    assert row["vehicle_count"] == 1, row
    assert row["prf_count"] == 0, row
    assert row["admin_email"] == "qc-crew-3000@emsclaims.test", row
