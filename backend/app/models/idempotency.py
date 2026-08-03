"""
Idempotency Model — Tracks API requests to prevent double processing.

`key` is a SHA-256 of (actor scope, path, caller-supplied key). It used to be
the caller's header verbatim, which made it a global namespace: two tenants
sending the same header collided, and the second was served the first's cached
scheme response. See app/utils/idempotency.py.
"""
from typing import Union
from datetime import datetime, timezone, timedelta
from sqlalchemy import String, DateTime, JSON, Integer
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


def default_expires_at():
    return datetime.now(timezone.utc) + timedelta(hours=24)


class IdempotencyKey(Base):
    __tablename__ = "idempotency_keys"

    key: Mapped[str] = mapped_column(String(255), primary_key=True)
    status: Mapped[str] = mapped_column(String(50), nullable=False)  # "IN_PROGRESS" or "COMPLETED"
    
    response_code: Mapped[Union[int, None]] = mapped_column(Integer, nullable=True)
    response_body: Mapped[Union[dict, list, None]] = mapped_column(JSON, nullable=True)
    
    # Who the key belongs to. The key column is a hash that already includes
    # this, so these two are for the audit trail and for the purge — they make a
    # row explicable without reversing a hash.
    scope: Mapped[Union[str, None]] = mapped_column(String(255), nullable=True)
    path: Mapped[Union[str, None]] = mapped_column(String(255), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc),
        index=True,
    )
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=default_expires_at
    )
