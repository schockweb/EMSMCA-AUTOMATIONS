"""
Crashes API — CRUD and analytics for the CrashEvent monitoring system.
Admin-only access (except POST /api/crashes for frontend error reporting).
"""
import uuid
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import select, func, delete, case, and_
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.crash_event import CrashEvent, CrashSource, CrashSeverity
from app.models.user import User
from app.api.auth import get_current_user
from app.middleware.logging_config import get_logger

logger = get_logger("crashes_api")

router = APIRouter(prefix="/api/crashes", tags=["Crash Monitoring"])


# ── Pydantic Schemas ──────────────────────────────────────

class FrontendCrashReport(BaseModel):
    """Schema for crashes reported by the React frontend."""
    error_type: str = Field(..., max_length=255)
    message: str = Field(..., max_length=2000)
    stacktrace: Optional[str] = None
    endpoint: Optional[str] = Field(None, max_length=500, description="Current page URL")
    severity: str = Field("error", pattern="^(critical|error|warning)$")
    metadata: Optional[dict] = None


class CrashEventOut(BaseModel):
    id: str
    source: str
    severity: str
    error_type: str
    message: str
    stacktrace: Optional[str] = None
    endpoint: Optional[str] = None
    user_id: Optional[str] = None
    metadata_blob: Optional[dict] = None
    resolved: bool
    resolved_at: Optional[str] = None
    created_at: str

    class Config:
        from_attributes = True


# ── POST /api/crashes — Frontend crash reporter ──────────

@router.post("", status_code=201)
async def report_frontend_crash(
    report: FrontendCrashReport,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """
    Accept crash reports from the React frontend.
    Works for both authenticated and unauthenticated users.
    """
    # Optional auth — don't block crash reporting if token is missing/expired
    user_id = None
    auth_header = request.headers.get("authorization", "")
    if auth_header.startswith("Bearer "):
        try:
            from jose import jwt as jose_jwt
            from app.config import get_settings
            _settings = get_settings()
            payload = jose_jwt.decode(
                auth_header.split(" ", 1)[1],
                _settings.SECRET_KEY,
                algorithms=[_settings.ALGORITHM],
            )
            uid = payload.get("sub")
            if uid:
                user_id = uuid.UUID(uid)
        except Exception:
            pass  # Token invalid/expired — that's fine, still record the crash

    crash = CrashEvent(
        source=CrashSource.FRONTEND,
        severity=CrashSeverity(report.severity),
        error_type=report.error_type,
        message=report.message[:2000],
        stacktrace=(report.stacktrace or "")[:10000],
        endpoint=report.endpoint,
        user_id=user_id,
        metadata_blob=report.metadata,
    )
    db.add(crash)
    await db.commit()
    await db.refresh(crash)
    logger.warning("Frontend crash reported: %s — %s", report.error_type, report.message[:200])
    return {"crash_id": str(crash.id), "recorded": True}


# ── GET /api/crashes — Paginated crash list ──────────────

@router.get("")
async def list_crashes(
    source: Optional[str] = Query(None, description="Filter by source: backend, celery, frontend"),
    severity: Optional[str] = Query(None, description="Filter by severity: critical, error, warning"),
    resolved: Optional[bool] = Query(None, description="Filter by resolved status"),
    search: Optional[str] = Query(None, description="Search in error_type or message"),
    days: int = Query(7, ge=1, le=365, description="Look back N days"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List crash events with filters, pagination, and search. Admin only."""
    if current_user.role.value != "admin":
        raise HTTPException(403, "Admin access required")

    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    query = select(CrashEvent).where(CrashEvent.created_at >= cutoff)
    count_query = select(func.count(CrashEvent.id)).where(CrashEvent.created_at >= cutoff)

    if source:
        query = query.where(CrashEvent.source == source)
        count_query = count_query.where(CrashEvent.source == source)
    if severity:
        query = query.where(CrashEvent.severity == severity)
        count_query = count_query.where(CrashEvent.severity == severity)
    if resolved is not None:
        query = query.where(CrashEvent.resolved == resolved)
        count_query = count_query.where(CrashEvent.resolved == resolved)
    if search:
        search_filter = CrashEvent.error_type.ilike(f"%{search}%") | CrashEvent.message.ilike(f"%{search}%")
        query = query.where(search_filter)
        count_query = count_query.where(search_filter)

    total = (await db.execute(count_query)).scalar() or 0
    offset = (page - 1) * page_size
    results = await db.execute(
        query.order_by(CrashEvent.created_at.desc()).offset(offset).limit(page_size)
    )
    crashes = results.scalars().all()

    return {
        "total": total,
        "page": page,
        "page_size": page_size,
        "pages": max(1, (total + page_size - 1) // page_size),
        "items": [_serialize(c) for c in crashes],
    }


# ── GET /api/crashes/stats — Aggregated analytics ────────

@router.get("/stats")
async def crash_stats(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Aggregated crash statistics for the System Health dashboard. Admin only."""
    if current_user.role.value != "admin":
        raise HTTPException(403, "Admin access required")

    now = datetime.now(timezone.utc)

    # Overall counts by source + severity
    source_severity = await db.execute(
        select(
            CrashEvent.source,
            CrashEvent.severity,
            func.count(CrashEvent.id),
        )
        .where(CrashEvent.created_at >= now - timedelta(days=30))
        .group_by(CrashEvent.source, CrashEvent.severity)
    )

    by_source: dict = {}
    for source, severity, count in source_severity.all():
        if source not in by_source:
            by_source[source] = {"critical": 0, "error": 0, "warning": 0, "total": 0}
        by_source[source][severity] = count
        by_source[source]["total"] += count

    # Time buckets: last 24h, 7d, 30d
    buckets = {}
    for label, delta in [("24h", timedelta(hours=24)), ("7d", timedelta(days=7)), ("30d", timedelta(days=30))]:
        result = await db.execute(
            select(func.count(CrashEvent.id)).where(CrashEvent.created_at >= now - delta)
        )
        buckets[label] = result.scalar() or 0

    # Unresolved count
    unresolved = await db.execute(
        select(func.count(CrashEvent.id)).where(
            CrashEvent.resolved == False,
            CrashEvent.created_at >= now - timedelta(days=30),
        )
    )

    # Daily trend (last 7 days) — for the bar chart
    daily_trend = []
    for i in range(6, -1, -1):
        day_start = (now - timedelta(days=i)).replace(hour=0, minute=0, second=0, microsecond=0)
        day_end = day_start + timedelta(days=1)

        day_stats = await db.execute(
            select(
                CrashEvent.severity,
                func.count(CrashEvent.id),
            )
            .where(and_(CrashEvent.created_at >= day_start, CrashEvent.created_at < day_end))
            .group_by(CrashEvent.severity)
        )
        day_data = {"date": day_start.strftime("%Y-%m-%d"), "critical": 0, "error": 0, "warning": 0, "total": 0}
        for severity, count in day_stats.all():
            day_data[severity] = count
            day_data["total"] += count
        daily_trend.append(day_data)

    # Top crashing endpoints
    top_endpoints = await db.execute(
        select(CrashEvent.endpoint, func.count(CrashEvent.id).label("count"))
        .where(CrashEvent.created_at >= now - timedelta(days=7))
        .where(CrashEvent.endpoint.isnot(None))
        .group_by(CrashEvent.endpoint)
        .order_by(func.count(CrashEvent.id).desc())
        .limit(5)
    )

    # Health status determination
    total_24h = buckets["24h"]
    if total_24h == 0:
        health_status = "healthy"
    elif total_24h <= 5:
        health_status = "stable"
    elif total_24h <= 20:
        health_status = "degraded"
    else:
        health_status = "critical"

    return {
        "health_status": health_status,
        "by_source": by_source,
        "buckets": buckets,
        "unresolved": unresolved.scalar() or 0,
        "daily_trend": daily_trend,
        "top_endpoints": [{"endpoint": ep, "count": cnt} for ep, cnt in top_endpoints.all()],
    }


# ── PATCH /api/crashes/:id/resolve ───────────────────────

@router.patch("/{crash_id}/resolve")
async def resolve_crash(
    crash_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Mark a crash as resolved. Admin only."""
    if current_user.role.value != "admin":
        raise HTTPException(403, "Admin access required")

    result = await db.execute(select(CrashEvent).where(CrashEvent.id == crash_id))
    crash = result.scalar_one_or_none()
    if not crash:
        raise HTTPException(404, "Crash event not found")

    crash.resolved = True
    crash.resolved_at = datetime.now(timezone.utc)
    crash.resolved_by = current_user.id
    await db.commit()
    return {"resolved": True, "crash_id": crash_id}


# ── DELETE /api/crashes/:id ──────────────────────────────

@router.delete("/{crash_id}")
async def delete_crash(
    crash_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete a crash record. Admin only."""
    if current_user.role.value != "admin":
        raise HTTPException(403, "Admin access required")

    result = await db.execute(select(CrashEvent).where(CrashEvent.id == crash_id))
    crash = result.scalar_one_or_none()
    if not crash:
        raise HTTPException(404, "Crash event not found")

    await db.delete(crash)
    await db.commit()
    return {"deleted": True, "crash_id": crash_id}


# ── POST /api/crashes/purge — Auto-purge old records ─────

@router.post("/purge")
async def purge_old_crashes(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete crash records older than 90 days. Admin only."""
    if current_user.role.value != "admin":
        raise HTTPException(403, "Admin access required")

    cutoff = CrashEvent.purge_cutoff()
    result = await db.execute(
        delete(CrashEvent).where(CrashEvent.created_at < cutoff)
    )
    await db.commit()
    purged = result.rowcount
    logger.info("Purged %d crash events older than %s", purged, cutoff.isoformat())
    return {"purged": purged, "cutoff": cutoff.isoformat()}


# ── Serializer ───────────────────────────────────────────

def _serialize(c: CrashEvent) -> dict:
    return {
        "id": str(c.id),
        "source": c.source if isinstance(c.source, str) else c.source.value if hasattr(c.source, 'value') else str(c.source),
        "severity": c.severity if isinstance(c.severity, str) else c.severity.value if hasattr(c.severity, 'value') else str(c.severity),
        "error_type": c.error_type,
        "message": c.message,
        "stacktrace": c.stacktrace,
        "endpoint": c.endpoint,
        "user_id": str(c.user_id) if c.user_id else None,
        "metadata_blob": c.metadata_blob,
        "resolved": c.resolved,
        "resolved_at": c.resolved_at.isoformat() if c.resolved_at else None,
        "created_at": c.created_at.isoformat() if c.created_at else None,
    }
