"""
Idempotency Utility — Prevents duplicate processing of financial API requests.
"""
from __future__ import annotations
import hashlib
import json
import logging
from typing import Callable, Awaitable, Any
from fastapi import Request, HTTPException
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from datetime import datetime, timezone

from app.models.idempotency import IdempotencyKey

logger = logging.getLogger("ems.idempotency")

async def process_idempotent_request(
    request: Request,
    db: AsyncSession,
    execute_callback: Callable[[], Awaitable[Any]]
):
    """
    Wraps an async execution block with idempotency locks.
    Extracts key from header OR hashes the request body.
    """
    idempotency_key = request.headers.get("Idempotency-Key")
    
    body_bytes = await request.body()
    
    if not idempotency_key:
        if not body_bytes:
            # Cannot hash an empty body, proceed natively without idempotency protection
            return await execute_callback()
            
        payload_hash = hashlib.sha256(body_bytes).hexdigest()
        # Add path scope
        idempotency_key = f"{request.url.path}:{payload_hash}"
    
    # 1. Check for existing key
    result = await db.execute(select(IdempotencyKey).where(IdempotencyKey.key == idempotency_key))
    existing = result.scalar_one_or_none()
    
    if existing:
        if existing.status == "IN_PROGRESS":
            raise HTTPException(
                status_code=409, 
                detail="Conflict: A request with this payload is currently processing."
            )
        
        # 2. Return Cached Response
        if existing.status == "COMPLETED":
            # Just ensure it hasn't somehow violently expired
            if existing.expires_at > datetime.now(timezone.utc):
                logger.info(f"[Idempotency] Serving cached response for {idempotency_key} - HTTP {existing.response_code}")
                content = existing.response_body
                return JSONResponse(status_code=existing.response_code, content=content)
    
    # 3. Create Lock Record
    lock = IdempotencyKey(key=idempotency_key, status="IN_PROGRESS")
    db.add(lock)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        # Race condition fallback
        raise HTTPException(
            status_code=409, 
            detail="Conflict: A request with this payload is currently processing."
        )
    
    # 4. Execute the Protected Operation
    try:
        response_payload = await execute_callback()
        
        status_code = 200
        content = response_payload
        
        # Unpack FastAPI JSONResponse instances if present
        if hasattr(response_payload, "status_code"):
            status_code = response_payload.status_code
            if hasattr(response_payload, "body"):
                content = json.loads(response_payload.body.decode("utf-8"))
            
        # Complete and cache forever (up to expires_at 24h limit)
        lock.status = "COMPLETED"
        lock.response_code = status_code
        lock.response_body = content
        await db.commit()
        
        return response_payload
        
    except HTTPException as e:
        # Cache 4xx and recognized failure HTTP responses so they don't hammer external servers
        lock.status = "COMPLETED"
        lock.response_code = e.status_code
        if isinstance(e.detail, (dict, list, str)):
            lock.response_body = {"detail": e.detail}
        else:
            lock.response_body = {"detail": str(e.detail)}
        await db.commit()
        raise e
        
    except Exception as e:
        # 500 crashes are deleted so the user CAN retry.
        logger.exception(f"[Idempotency] Execution failed. Removing lock {idempotency_key}")
        await db.delete(lock)
        await db.commit()
        raise e
