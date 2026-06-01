"""
TokenBlacklist model — Revoked JWT tokens.
When a user logs out or a refresh token is rotated, the old token's
JTI (JWT ID) is stored here so it cannot be reused.
"""
from typing import Union
import uuid
from datetime import datetime, timezone
from sqlalchemy import String, DateTime
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column
from app.database import Base


class TokenBlacklist(Base):
    __tablename__ = "token_blacklist"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    jti: Mapped[str] = mapped_column(
        String(64), unique=True, nullable=False, index=True,
        comment="JWT ID claim — unique per token"
    )
    user_id: Mapped[Union[uuid.UUID, None]] = mapped_column(
        UUID(as_uuid=True), nullable=True, index=True,
        comment="User who owned the revoked token"
    )
    token_type: Mapped[str] = mapped_column(
        String(10), nullable=False, default="access",
        comment="'access' or 'refresh'"
    )
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False,
        comment="Original token expiry — entries can be purged after this time"
    )
    revoked_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

    def __repr__(self):
        return f"<TokenBlacklist jti={self.jti[:8]}... type={self.token_type}>"
