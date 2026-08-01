"""
The 7-day trend chart must cost two queries, not fourteen — and must bucket
rows into exactly the same windows it always did.

`_weekly_trends` ran a document count and a claim count inside a
`for i in range(7)` loop, each awaited before the next began: fourteen
sequential round-trips against a managed database for one chart, holding the
connection for the whole sequence.

The windows are the subtle part. `since` is "now minus seven days", so a bucket
runs from that TIME OF DAY to the same time the next day — they are not
calendar days. Rewriting this with `date_trunc('day', …)` would shift every
boundary and quietly move counts between days, which no query-count test would
notice. Hence the boundary cases below.
"""
import uuid
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from sqlalchemy import event, select, text

from app.models.case import Case
from app.models.document import Document

pytestmark = pytest.mark.asyncio

_MARKER = "ZZTREND"


class _QueryCounter:
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


@pytest_asyncio.fixture
async def trend_docs():
    """Documents placed at deliberately awkward offsets from `since`."""
    from tests.conftest import _TestSession

    since = datetime.now(timezone.utc) - timedelta(days=7)
    case_id = None

    # offset from `since` → expected day bucket
    placements = [
        (timedelta(seconds=1), 0),                       # just inside day 0
        (timedelta(hours=23, minutes=59), 0),            # last minute of day 0
        (timedelta(days=1), 1),                          # exactly on the day-1 edge
        (timedelta(days=1, hours=5), 1),
        (timedelta(days=3, hours=12), 3),
        (timedelta(days=6, hours=23), 6),                # last bucket
    ]

    async with _TestSession() as db:
        case = Case(patient_name=f"{_MARKER} carrier", medical_scheme_name="PyTest")
        db.add(case)
        await db.flush()
        case_id = case.id

        for i, (offset, _bucket) in enumerate(placements):
            db.add(Document(
                case_id=case_id,
                original_filename=f"{_MARKER}-{i}.pdf",
                storage_uri=f"test://{_MARKER}/{uuid.uuid4()}",
                document_type="Digital PRF",
                created_at=since + offset,
            ))
        await db.commit()

    yield since, placements

    async with _TestSession() as db:
        await db.execute(
            text("delete from documents where original_filename like :m"),
            {"m": f"{_MARKER}%"},
        )
        await db.execute(text("delete from cases where id = :cid"), {"cid": case_id})
        await db.commit()


async def test_trends_cost_two_queries_not_fourteen(trend_docs):
    from tests.conftest import _TestSession, _test_engine
    from app.services.analytics import _weekly_trends

    since, _ = trend_docs

    async with _TestSession() as db:
        with _QueryCounter(_test_engine) as counter:
            await _weekly_trends(db, since)

    assert counter.count == 2, (
        f"_weekly_trends issued {counter.count} queries; expected one per series. "
        f"A count per day is 14 sequential round-trips for a single chart."
    )


async def test_rows_land_in_the_same_day_buckets_as_before(trend_docs):
    """The boundary behaviour, pinned.

    Day windows are offset by the time of day, not aligned to midnight. An
    implementation that truncated to calendar days would put several of these
    rows one bucket out.
    """
    from tests.conftest import _TestSession
    from app.services.analytics import _weekly_trends

    since, placements = trend_docs

    async with _TestSession() as db:
        result = await _weekly_trends(db, since)

    series = result["documents_per_day"]
    assert len(series) == 7, series

    expected = {i: 0 for i in range(7)}
    for _offset, bucket in placements:
        expected[bucket] += 1

    for i in range(7):
        label = (since + timedelta(days=i)).strftime("%Y-%m-%d")
        assert series[i]["date"] == label, (
            f"day {i} labelled {series[i]['date']!r}, expected {label!r}"
        )
        # Other tests share this database, so assert our rows are AT LEAST
        # present in the right bucket rather than demanding an exact total.
        assert series[i]["count"] >= expected[i], (
            f"day {i} counted {series[i]['count']}, expected at least "
            f"{expected[i]} from this test's documents — a row landed in the "
            f"wrong window"
        )

    assert sum(s["count"] for s in series) >= len(placements), (
        "documents inside the 7-day window went missing entirely"
    )
