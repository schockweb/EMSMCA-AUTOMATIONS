"""
Idempotency for financial API requests — one submission, one outcome.

THREE DEFECTS THIS REPLACES
---------------------------
The original took the `Idempotency-Key` header verbatim as the PRIMARY KEY of a
global table, with no actor, provider or tenant component.

1. CROSS-TENANT RESPONSE REPLAY. Admin A submits with `Idempotency-Key: 1`. The
   medical scheme's response — authorisation number, member details, claim data
   — is cached against the string "1". Any other admin sending the same header
   to the same route is handed A's cached response body, with no ownership check
   whatsoever: the route's role guard passes, and the cache hit short-circuits
   everything after it. The fallback key when no header was sent was
   `f"{path}:{sha256(body)}"` — also global, so two tenants submitting an
   identical payload collided too.

2. PERMANENT DENIAL OF SERVICE. An `IN_PROGRESS` row 409s forever. The exception
   path deletes the lock, but a SIGKILL, an OOM kill or a database disconnect
   between the IN_PROGRESS commit and the completion commit leaves it behind —
   and `expires_at` was only consulted on the COMPLETED branch, so nothing aged
   an IN_PROGRESS row out. That claim could never be submitted again without
   someone running a DELETE by hand.

3. AN UNBOUNDED TABLE OF PATIENT DATA. Nothing anywhere deleted from
   `idempotency_keys`. `expires_at` stopped a row being SERVED, never being
   STORED, so scheme response bodies accumulated forever. That is the
   crash_events shape — which reached 3.68 million rows — except these rows
   contain patient data.

WHAT REPLACES IT
----------------
The stored key is a hash of (actor, path, caller's key). Two tenants using the
same header now occupy different rows and cannot see each other's responses. A
stale IN_PROGRESS lock is reclaimed after a timeout rather than blocking
forever. And `purge_expired_idempotency_keys` runs on the beat schedule.

ONE THING DELIBERATELY NOT DONE: reclaiming a stale lock does NOT mean the
original request failed. The process may have died after the scheme accepted the
submission. The reclaim window is therefore generous, and the event is logged at
WARNING so a possible duplicate can be traced — a shorter window would trade a
rare permanent block for a rare DOUBLE CLAIM to a medical scheme, which is the
worse of the two.
"""
from __future__ import annotations

import hashlib
import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Optional

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.idempotency import IdempotencyKey

logger = logging.getLogger("ems.idempotency")

# How long an IN_PROGRESS lock is honoured before it is treated as abandoned.
#
# Longer than any realistic scheme round-trip (the gateway's own HTTP timeouts
# are tens of seconds) and long enough to cover a worker restart — because the
# cost of reclaiming too EARLY is a duplicate claim to a medical scheme, and the
# cost of reclaiming too late is only a delay.
STALE_LOCK_MINUTES = 30


def _scope(request: Request, actor: Any) -> str:
    """The identity a key belongs to.

    Falls back to the trusted client address when there is no authenticated
    actor. That is weaker, but never worse than the previous behaviour of no
    scope at all — and both current call sites are authenticated.
    """
    for attr in ("id", "email"):
        val = getattr(actor, attr, None)
        if val:
            return f"actor:{val}"
    try:
        from app.utils.client_ip import get_trusted_client_ip
        return f"ip:{get_trusted_client_ip(request)}"
    except Exception:
        return "anon"


def _storage_key(scope: str, path: str, client_key: str) -> str:
    """Hashed: bounds the stored length, and keeps a caller-chosen string out of
    logs and error messages."""
    return hashlib.sha256(f"{scope}|{path}|{client_key}".encode()).hexdigest()


async def process_idempotent_request(
    request: Request,
    db: AsyncSession,
    execute_callback: Callable[[], Awaitable[Any]],
    actor: Optional[Any] = None,
):
    """Run `execute_callback` at most once per (actor, path, key)."""
    client_key = request.headers.get("Idempotency-Key")
    body_bytes = await request.body()

    if not client_key:
        if not body_bytes:
            # Nothing to key on — proceed unprotected, as before.
            return await execute_callback()
        client_key = hashlib.sha256(body_bytes).hexdigest()

    scope = _scope(request, actor)
    key = _storage_key(scope, request.url.path, client_key)
    now = datetime.now(timezone.utc)

    existing = (await db.execute(
        select(IdempotencyKey).where(IdempotencyKey.key == key)
    )).scalar_one_or_none()

    if existing:
        if existing.status == "IN_PROGRESS":
            created = existing.created_at or now
            if created.tzinfo is None:
                created = created.replace(tzinfo=timezone.utc)
            age = now - created
            if age < timedelta(minutes=STALE_LOCK_MINUTES):
                raise HTTPException(
                    status_code=409,
                    detail="A request with this payload is currently processing.",
                )
            # Abandoned by a killed process. Reclaim rather than block forever —
            # but say so loudly: the original attempt may have reached the
            # scheme before it died, so a duplicate is possible from here.
            logger.warning(
                "[Idempotency] Reclaiming a lock abandoned %s ago (scope=%s path=%s). "
                "The original attempt may have completed at the scheme — verify "
                "before treating this as a first submission.",
                age, scope, request.url.path,
            )
            await db.delete(existing)
            await db.commit()
            existing = None

        elif existing.status == "COMPLETED":
            expires = existing.expires_at
            if expires is not None and expires.tzinfo is None:
                expires = expires.replace(tzinfo=timezone.utc)
            if expires and expires > now:
                logger.info("[Idempotency] Serving cached response, HTTP %s",
                            existing.response_code)
                return JSONResponse(status_code=existing.response_code,
                                    content=existing.response_body)
            # Expired: drop it so a fresh attempt can take the key.
            await db.delete(existing)
            await db.commit()
            existing = None

    lock = IdempotencyKey(key=key, status="IN_PROGRESS", scope=scope,
                          path=request.url.path)
    db.add(lock)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        # Another request took the key between our SELECT and our INSERT.
        raise HTTPException(
            status_code=409,
            detail="A request with this payload is currently processing.",
        )

    try:
        response_payload = await execute_callback()

        status_code = 200
        content = response_payload
        if hasattr(response_payload, "status_code"):
            status_code = response_payload.status_code
            if hasattr(response_payload, "body"):
                content = json.loads(response_payload.body.decode("utf-8"))

        lock.status = "COMPLETED"
        lock.response_code = status_code
        lock.response_body = content
        await db.commit()
        return response_payload

    except HTTPException as e:
        # 4xx outcomes are cached so a retry does not hammer the scheme.
        lock.status = "COMPLETED"
        lock.response_code = e.status_code
        lock.response_body = ({"detail": e.detail}
                              if isinstance(e.detail, (dict, list, str))
                              else {"detail": str(e.detail)})
        await db.commit()
        raise

    except Exception:
        # An unexpected failure releases the lock so the caller can retry.
        logger.exception("[Idempotency] Execution failed; releasing the lock")
        await db.delete(lock)
        await db.commit()
        raise
