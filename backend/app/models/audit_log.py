"""
AuditLog model — Immutable, append-only POPIA compliance ledger.
"""
from typing import Union
import uuid
from datetime import datetime, timezone
from sqlalchemy import String, Text, ForeignKey, DateTime
from sqlalchemy.dialects.postgresql import UUID, JSONB, INET
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.database import Base


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[Union[uuid.UUID, None]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True, index=True
    )
    # Crew members are NOT users — they live in their own table with their own
    # token type. Almost every read of a patient record is by a crew member, so
    # without this column the audit trail could not name the actor for the
    # majority of accesses, which is exactly what POPIA s22 scoping needs.
    crew_member_id: Mapped[Union[uuid.UUID, None]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("crew_members.id"), nullable=True, index=True
    )
    action: Mapped[str] = mapped_column(
        String(50), nullable=False,
        comment="CREATE, READ, UPDATE, DELETE, TRANSMIT"
    )
    entity_type: Mapped[str] = mapped_column(
        String(50), nullable=False,
        comment="claim, document, case, user, etc."
    )
    entity_id: Mapped[Union[uuid.UUID, None]] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )
    details: Mapped[Union[dict, None]] = mapped_column(
        JSONB, nullable=True, comment="Contextual metadata"
    )
    before_state: Mapped[Union[dict, None]] = mapped_column(
        JSONB, nullable=True,
        comment="Snapshot of relevant fields before change. NULL for creation events."
    )
    after_state: Mapped[Union[dict, None]] = mapped_column(
        JSONB, nullable=True,
        comment="Snapshot of relevant fields after change."
    )
    notes: Mapped[Union[str, None]] = mapped_column(
        Text, nullable=True,
        comment="Free-text context. Mandatory for VOIDED and CORRECTED events."
    )
    ip_address: Mapped[Union[str, None]] = mapped_column(
        String(50), nullable=True, comment="Client IP address"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

    # Relationships
    user = relationship("User", back_populates="audit_logs")

    def __repr__(self):
        return f"<AuditLog {self.action} {self.entity_type}/{self.entity_id}>"


# ── Append-only enforcement on the create_all path ─────────────────────────
#
# Migration c2f9a48d61be installs a trigger that refuses UPDATE and DELETE on
# this table, because the model calls it an immutable POPIA ledger and nothing
# enforced any part of that.
#
# The migration only ever runs against a database that already exists. A FRESH
# INSTALL does not use it: bootstrap_schema.py builds the schema from these
# models with create_all and then stamps Alembic at head — so a brand-new client
# instance got `audit_logs` with no trigger at all, and its record of who opened
# which patient's file was freely deletable by anyone holding the application's
# own database credentials. Discovered 2026-08-03 while checking that the
# search_text trigger did not have the same hole; it did, and so did this.
#
# Declared in both places, like the scale indexes and search_text. The migration
# upgrades existing databases; this covers databases being created.
# test_audit_log_integrity.py asserts the two definitions have not drifted.
from sqlalchemy import DDL as _DDL, event as _event  # noqa: E402

AUDIT_APPEND_ONLY_FN = """
CREATE OR REPLACE FUNCTION ems_audit_logs_append_only()
RETURNS TRIGGER AS $$
BEGIN
    IF coalesce(current_setting('ems.audit_maintenance', true), '') = 'on' THEN
        RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
    END IF;
    RAISE EXCEPTION
        'audit_logs is append-only: % is not permitted. This table is the '
        'record of who accessed which patient file. If this really is '
        'authorised maintenance, the session must opt in explicitly with '
        'SET LOCAL ems.audit_maintenance = ''on'' in the same transaction.',
        TG_OP
        USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
"""

AUDIT_APPEND_ONLY_TRIGGER = """
CREATE TRIGGER trg_audit_logs_append_only
BEFORE UPDATE OR DELETE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION ems_audit_logs_append_only();
"""

for _ddl in (AUDIT_APPEND_ONLY_FN,
             "DROP TRIGGER IF EXISTS trg_audit_logs_append_only ON audit_logs",
             AUDIT_APPEND_ONLY_TRIGGER):
    # `%` is DOUBLED for the DDL construct only. SQLAlchemy runs
    # `statement % context` to substitute %(table)s and friends, so the literal
    # per-cent in the RAISE EXCEPTION message above ("...: % is not permitted")
    # is read as a format spec and create_all() dies with
    # "TypeError: %i format: a real number is required, not dict" — not on the
    # audit table alone, but on the WHOLE metadata, so a brand-new database
    # could not be built at all: CI's fresh postgres and bootstrap_schema.py
    # both raise before a single table is created. Existing databases never see
    # it, because after_create does not fire for a table that is already there,
    # which is why it survived the commit that added the trigger.
    #
    # The escaping is applied here rather than in the constants because those
    # are executed as raw SQL by migration d5b7e91a3c62 and compared verbatim by
    # test_audit_log_integrity.py — doubling them at the source would break both.
    _event.listen(AuditLog.__table__, "after_create",
                  _DDL(_ddl.replace("%", "%%")).execute_if(dialect="postgresql"))
