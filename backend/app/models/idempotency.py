"""
Idempotency Model — Tracks API requests to prevent double processing.
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
    
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=default_expires_at
    )
