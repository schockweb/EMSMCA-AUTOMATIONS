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


# Substring match, lowercase, deliberately broad. A crash report is diagnostic
# data — over-redacting costs an engineer a little context, under-redacting puts
# a patient's identity in a 90-day table nobody thinks of as clinical.
_SENSITIVE_SUBSTRINGS = (
    "id_number", "idnumber", "passport", "password", "secret", "token",
    "authorization", "api_key", "apikey", "member_number", "membership",
    "patient_name", "surname", "first_name", "full_name", "dob",
    "date_of_birth", "signature", "email", "phone", "cell", "address",
    "account_number", "medical_aid", "scheme_member",
)

_REDACTED = "<redacted>"


def _is_sensitive(key: str) -> bool:
    k = str(key).lower()
    return any(s in k for s in _SENSITIVE_SUBSTRINGS)


def _redact(obj, depth: int = 0):
    """Recursively blank the values of sensitive-looking keys.

    Keys are kept and values dropped on purpose: knowing that
    `patient_id_number` was present and non-empty is the diagnostic signal;
    the digits themselves never are.
    """
    if depth > 6:
        return "<truncated>"
    if isinstance(obj, dict):
        return {
            k: (_REDACTED if _is_sensitive(k) else _redact(v, depth + 1))
            for k, v in obj.items()
        }
    if isinstance(obj, (list, tuple)):
        return [_redact(v, depth + 1) for v in obj[:50]]
    if isinstance(obj, str) and len(obj) > 500:
        return obj[:500] + "…<truncated>"
    return obj


def _redact_body(body: bytes) -> str:
    """Redact a JSON body field-wise; refuse to store one we cannot parse.

    A body we cannot parse is a body we cannot redact, and a PRF autosave that
    fails to decode is exactly the case most likely to contain patient data. So
    the fallback records the size and content type, not the bytes.
    """
    import json

    try:
        parsed = json.loads(body.decode("utf-8"))
    except Exception:
        return f"<unparsed body, {len(body)} bytes — not stored>"
    if not isinstance(parsed, (dict, list)):
        return f"<non-object body, {len(body)} bytes — not stored>"
    try:
        return json.dumps(_redact(parsed), default=str)[:2000]
    except Exception:
        return f"<unserialisable body, {len(body)} bytes — not stored>"


async def record_crash_event(request: Request, exc: Exception) -> uuid.UUID:
    """Persist a crash event to the database from either middleware or a FastAPI exception handler."""
    crash_id = uuid.uuid4()

    # Extract user_id from JWT state if available
    user_id = None
    if hasattr(request.state, "user_id"):
        user_id = request.state.user_id

    # Build metadata
    #
    # REDACTED, because this table was the largest unmanaged copy of PHI in the
    # product. The crew app posts the entire PRF form blob every five seconds on
    # autosave, and POST /api/cases carries patient_id_number — so any unhandled
    # 500 on those routes wrote a patient's plaintext SA ID and name into
    # crash_events, a JSONB column with no encryption, readable by any admin via
    # /api/crashes and retained for 90 days. Query strings were worse:
    # /api/data-rights/subject-access took the ID number as a URL parameter, so
    # a 500 there stored the complete identifier verbatim.
    #
    # Diagnostic value is preserved — an engineer needs the SHAPE of the failing
    # request (which fields were present, how big it was), not the patient's
    # identity.
    meta = {
        "method": request.method,
        "query_params": _redact(dict(request.query_params)),
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
            meta["request_body_preview"] = _redact_body(body)
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
