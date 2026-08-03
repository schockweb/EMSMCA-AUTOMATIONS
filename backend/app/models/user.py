"""
User / Provider model — RBAC profiles, BHF practice details.
"""
from typing import Union
import uuid
from datetime import datetime, timezone
from sqlalchemy import String, Boolean, Integer, Enum as SAEnum, DateTime, JSON
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.database import Base
import enum

# All available permission keys — each maps to a frontend page/section
ALL_PERMISSIONS = [
    "dashboard",
    "upload",
    "admin_queue",
    "document_review",
    "adjudication",
    "edi_submit",
    "era_tracking",
    "analytics",
    "payouts",
    "ai_training",
    "cases",
    "employee_management",
    "settings",
    "rule_builder",
    "providers",
    "employees",
    "failed_forms",
    "system_health",
    "tariff_billing",
]


class UserRole(str, enum.Enum):
    SUPER_ADMIN = "super_admin"
    ADMIN = "admin"
    DISPATCHER = "dispatcher"
    PARAMEDIC = "paramedic"
    BILLING_CLERK = "billing_clerk"


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    email: Mapped[str] = mapped_column(
        String(255), unique=True, nullable=False, index=True
    )
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)
    full_name: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[UserRole] = mapped_column(
        SAEnum(UserRole, name="user_role"), nullable=False, default=UserRole.PARAMEDIC
    )
    bhf_practice_number: Mapped[Union[str, None]] = mapped_column(String(20), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    # NOT NULL, and defaulting to NOTHING rather than everything.
    #
    # A nullable column gave permission checks a third state to interpret, and
    # `has_permission` interpreted it as "grant everything" — so any row created
    # by a script or a fixture held every permission regardless of role. There
    # is no "not configured" any more; see migration a4d81c6b2f75.
    #
    # The Python-side default is an empty list for the same reason as the server
    # default: app/api/users.py always sets permissions explicitly, so this only
    # fires for something that bypassed it, and no-access is the safe answer for
    # an account nobody configured.
    permissions: Mapped[list] = mapped_column(
        JSON, nullable=False, default=list, server_default="[]",
        comment="List of page-keys the user can access. Empty = no access."
    )

    # ── Account Lockout ──
    failed_login_attempts: Mapped[int] = mapped_column(
        Integer, default=0, server_default="0",
        comment="Consecutive failed login attempts"
    )
    locked_until: Mapped[Union[datetime, None]] = mapped_column(
        DateTime(timezone=True), nullable=True,
        comment="Account locked until this timestamp (NULL = not locked)"
    )

    # ── Password Tracking ──
    password_changed_at: Mapped[Union[datetime, None]] = mapped_column(
        DateTime(timezone=True), nullable=True,
        comment="Last password change timestamp"
    )

    # ── Bulk session revocation ──
    # Every token issued to this account BEFORE this instant is invalid. The
    # JTI blacklist can only revoke a token someone has presented, which is
    # useless against a token that was copied — see token_is_revoked_by_family.
    tokens_revoked_at: Mapped[Union[datetime, None]] = mapped_column(
        DateTime(timezone=True), nullable=True,
        comment="Invalidate all tokens issued before this time (NULL = none revoked)"
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    # Relationships
    #
    # lazy="raise", NOT "selectin".
    #
    # These three were eager-loaded, and `get_current_user` does a bare
    # `select(User)` — so EVERY authenticated request emitted four statements
    # (users, then cases, documents and audit_logs) and materialised every row
    # the account had ever touched, only to discard it. 114 `Depends()` call
    # sites resolve to that dependency or to get_admin_or_crew_admin, which does
    # the same. The cost grows with the account's history rather than staying
    # constant: roughly 625ms per request at 1M rows and 3.1s at 5M.
    #
    # Nothing in the application reads user.cases / user.documents /
    # user.audit_logs — verified by grep across app/ — so eager loading bought
    # nothing at all.
    #
    # "raise" rather than "select" on purpose: if a future code path does touch
    # one of these, it fails loudly in tests instead of silently reintroducing
    # an N+1 on the hottest path in the system. Any legitimate future use should
    # add an explicit selectinload() at that query.
    cases = relationship("Case", back_populates="assigned_provider", lazy="raise")
    documents = relationship("Document", foreign_keys="[Document.uploaded_by]", back_populates="uploaded_by_user", lazy="raise")
    audit_logs = relationship("AuditLog", back_populates="user", lazy="raise")

    def __repr__(self):
        return f"<User {self.email} ({self.role.value})>"
