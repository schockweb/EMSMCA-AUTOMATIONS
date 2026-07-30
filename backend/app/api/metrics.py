"""
Prometheus Metrics Endpoint — lightweight, no external dependencies.
Exposes PRF status counts, failed PRF gauge, and database pool statistics
in Prometheus exposition format.
"""
from __future__ import annotations
import asyncio

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.responses import PlainTextResponse

from app.database import get_db, engine

router = APIRouter(tags=["Monitoring"])


def _active_worker_count() -> int:
    """Blocking Celery inspect. Called via run_in_executor — see the call site."""
    from app.tasks.celery_app import celery_app as _celery
    inspector = _celery.control.inspect(timeout=3)
    active = inspector.active()
    return len(active) if active else 0


@router.get("/api/metrics")
async def prometheus_metrics(db: AsyncSession = Depends(get_db)):
    """Prometheus-compatible metrics scrape endpoint.

    Deliberately unauthenticated so a scraper needs no credential — but it
    reports PRF volumes and failure counts (ems_prf_total, ems_failed_prfs_total)
    which /api/stats was explicitly closed to anonymous callers. It is therefore
    DENIED AT THE EDGE in nginx, so it is reachable only from inside the Docker
    network where Prometheus runs. If you ever need to scrape it from outside,
    add auth here first — do not simply open the nginx location.
    """
    lines = []

    # ── PRF totals by status ──────────────────────────────
    lines.append("# HELP ems_prf_total Total PRFs by status")
    lines.append("# TYPE ems_prf_total gauge")
    result = await db.execute(
        text("SELECT status::text, COUNT(*) FROM digital_prfs GROUP BY status")
    )
    for status, count in result:
        lines.append(f'ems_prf_total{{status="{status}"}} {count}')

    # ── Failed PRFs gauge ─────────────────────────────────
    lines.append("# HELP ems_failed_prfs_total Current failed PRFs")
    lines.append("# TYPE ems_failed_prfs_total gauge")
    result = await db.execute(
        text("SELECT COUNT(*) FROM digital_prfs WHERE status = 'failed'")
    )
    lines.append(f"ems_failed_prfs_total {result.scalar() or 0}")

    # ── Database connection pool ──────────────────────────
    lines.append("# HELP ems_db_pool_size Database connection pool size")
    lines.append("# TYPE ems_db_pool_size gauge")
    pool = engine.pool
    lines.append(f"ems_db_pool_size {pool.size()}")
    lines.append(f"ems_db_pool_checkedout {pool.checkedout()}")

    # ── Queue depth & consumers (Item 9) ──────────────────
    try:
        import httpx
        import re
        from app.config import get_settings
        _settings = get_settings()
        match = re.search(r"amqp://([^:]+):([^@]+)@([^:]+):(\d+)", _settings.CELERY_BROKER_URL)
        if match:
            rmq_user, rmq_pass, rmq_host, _ = match.groups()
            mgmt_url = f"http://{rmq_host}:15672/api/queues/%2F/ems_default"
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.get(mgmt_url, auth=(rmq_user, rmq_pass))
                if resp.status_code == 200:
                    q_data = resp.json()
                    lines.append('# HELP ems_queue_depth Messages waiting in the task queue')
                    lines.append('# TYPE ems_queue_depth gauge')
                    lines.append(f'ems_queue_depth{{queue="ems_default"}} {q_data.get("messages", 0)}')

                    lines.append('# HELP ems_queue_consumers Active consumers on the task queue')
                    lines.append('# TYPE ems_queue_consumers gauge')
                    lines.append(f'ems_queue_consumers{{queue="ems_default"}} {q_data.get("consumers", 0)}')
    except Exception:
        pass  # Don't fail the entire metrics endpoint

    # ── Active Celery workers ─────────────────────────────
    # control.inspect().active() is a synchronous kombu broadcast that waits up
    # to `timeout` seconds. Called directly inside `async def` it parks the
    # uvicorn event loop for that whole period — stalling every other request in
    # flight, not just this scrape. Run it in a worker thread instead.
    try:
        loop = asyncio.get_running_loop()
        worker_count = await loop.run_in_executor(None, _active_worker_count)
        lines.append("# HELP ems_celery_active_workers Number of active Celery worker nodes")
        lines.append("# TYPE ems_celery_active_workers gauge")
        lines.append(f"ems_celery_active_workers {worker_count}")
    except Exception:
        pass

    return PlainTextResponse(
        "\n".join(lines) + "\n",
        media_type="text/plain; version=0.0.4",
    )
