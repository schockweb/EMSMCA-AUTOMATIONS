"""
Global Crash Handler — catches unhandled exceptions across all FastAPI routes,
persists them to the crash_events table, and returns a clean 500 with reference ID.
"""
from __future__ import annotations
import traceback
import uuid
from datetime import datetime, timezone

from fastapi import Request, Response
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from typing import Callable, Awaitable
RequestResponseCall = Callable[[Request], Awaitable[Response]]
from sqlalchemy import select

from app.database import AsyncSessionLocal
from app.models.crash_event import CrashEvent, CrashSource, CrashSeverity
from app.middleware.logging_config import get_logger

logger = get_logger("crash_handler")


class CrashHandlerMiddleware(BaseHTTPMiddleware):
    """
    Middleware that wraps every request in a try/except.
    Unhandled exceptions are logged to the crash_events table
    and a structured 500 response is returned.
    """

    async def dispatch(self, request: Request, call_next: RequestResponseCall):
        try:
            response = await call_next(request)
            return response
        except Exception as exc:
            crash_id = await record_crash_event(request, exc)
            logger.error(
                "Unhandled exception in middleware on %s %s — crash_id=%s: %s",
                request.method, request.url.path, crash_id, str(exc),
                exc_info=True,
            )
            return JSONResponse(
                status_code=500,
                content={
                    "detail": "An internal error occurred. Our team has been notified.",
                    "crash_id": str(crash_id),
                },
            )


async def record_crash_event(request: Request, exc: Exception) -> uuid.UUID:
    """Persist a crash event to the database from either middleware or a FastAPI exception handler."""
    crash_id = uuid.uuid4()

    # Extract user_id from JWT state if available
    user_id = None
    if hasattr(request.state, "user_id"):
        user_id = request.state.user_id

    # Build metadata
    meta = {
        "method": request.method,
        "query_params": dict(request.query_params),
        "client_host": request.client.host if request.client else None,
        "headers": {
            "user-agent": request.headers.get("user-agent"),
            "content-type": request.headers.get("content-type"),
        },
    }

    # Try to read request body for context (limited to 10KB)
    try:
        body = await request.body()
        if body and len(body) <= 10240:
            meta["request_body_preview"] = body.decode("utf-8", errors="replace")[:2000]
    except Exception:
        pass

    # Determine severity based on exception type
    severity = CrashSeverity.ERROR
    critical_types = {"SystemExit", "KeyboardInterrupt", "MemoryError", "DatabaseError", "OperationalError"}
    if type(exc).__name__ in critical_types:
        severity = CrashSeverity.CRITICAL

    tb = traceback.format_exception(type(exc), exc, exc.__traceback__)

    try:
        async with AsyncSessionLocal() as db:
            crash = CrashEvent(
                id=crash_id,
                source=CrashSource.BACKEND,
                severity=severity,
                error_type=type(exc).__name__,
                message=str(exc)[:2000],
                stacktrace="".join(tb)[:10000],
                endpoint=f"{request.method} {request.url.path}",
                user_id=user_id,
                metadata_blob=meta,
            )
            db.add(crash)
            await db.commit()
    except Exception as db_err:
        # If we can't even write the crash, log it and don't crash the crash handler
        logger.critical(
            "FAILED to persist crash event: %s | Original error: %s",
            str(db_err), str(exc),
        )

    return crash_id
