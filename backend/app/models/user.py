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
    permissions: Mapped[Union[list, None]] = mapped_column(
        JSON, nullable=True, default=lambda: list(ALL_PERMISSIONS),
        comment="List of page-keys the user can access"
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

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    # Relationships
    cases = relationship("Case", back_populates="assigned_provider", lazy="selectin")
    documents = relationship("Document", foreign_keys="[Document.uploaded_by]", back_populates="uploaded_by_user", lazy="selectin")
    audit_logs = relationship("AuditLog", back_populates="user", lazy="selectin")

    def __repr__(self):
        return f"<User {self.email} ({self.role.value})>"
