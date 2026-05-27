"""
Audit Logging Service — writes immutable POPIA-compliant audit records.
"""
import uuid
from datetime import datetime, timezone
from typing import Optional, Dict, Any
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.audit_log import AuditLog


async def log_action(
    db: AsyncSession,
    action: str,
    entity_type: str,
    entity_id: Optional[uuid.UUID] = None,
    user_id: Optional[uuid.UUID] = None,
    details: Optional[Dict[str, Any]] = None,
    ip_address: Optional[str] = None,
):
    """
    Write an immutable audit log entry.
    Actions: CREATE, READ, UPDATE, DELETE, TRANSMIT, LOGIN, UPLOAD, DOWNLOAD
    """
    log = AuditLog(
        user_id=user_id,
        action=action,
        entity_type=entity_type,
        entity_id=entity_id,
        details=details or {},
        ip_address=ip_address,
    )
    db.add(log)
    await db.flush()  # flush but let caller control commit
