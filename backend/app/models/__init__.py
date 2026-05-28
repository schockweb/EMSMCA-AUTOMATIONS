"""
Models package — imports all ORM models so Alembic and Base.metadata can discover them.
"""
from app.models.user import User, UserRole
from app.models.case import Case, PreAuthStatus
from app.models.claim import Claim, AdjudicationStatus
from app.models.claim_line import ClaimLine
from app.models.document import Document, OCRStatus
from app.models.audit_log import AuditLog
from app.models.rfi import RFI, RFIStatus, RFIPriority
from app.models.edi_submission import EDISubmission, EDIFormat, SubmissionStatus
from app.models.era import ERA, ERAStatus, PaymentStatus
from app.models.system_settings import SystemSettings
from app.models.auth_request import SchemeAuthRequest, AuthRequestStatus
from app.models.api_audit_log import APIAuditLog
from app.models.crash_event import CrashEvent, CrashSource, CrashSeverity
from app.models.token_blacklist import TokenBlacklist
from app.models.idempotency import IdempotencyKey
from app.models.service_provider import ServiceProvider
from app.models.vehicle import Vehicle
from app.models.crew_member import CrewMember
from app.models.digital_prf import DigitalPRF, PRFStatus
from app.models.rate_schema import RateSchema
from app.models.scheme_tariff_line import SchemeTariffLine

__all__ = [
    "User", "UserRole",
    "Case", "PreAuthStatus",
    "Claim", "AdjudicationStatus",
    "ClaimLine",
    "Document", "OCRStatus",
    "AuditLog",
    "RFI", "RFIStatus", "RFIPriority",
    "EDISubmission", "EDIFormat", "SubmissionStatus",
    "ERA", "ERAStatus", "PaymentStatus",
    "SystemSettings",
    "SchemeAuthRequest", "AuthRequestStatus",
    "APIAuditLog",
    "CrashEvent", "CrashSource", "CrashSeverity",
    "TokenBlacklist",
    "IdempotencyKey",
    "ServiceProvider",
    "Vehicle",
    "CrewMember",
    "DigitalPRF", "PRFStatus",
    "RateSchema",
    "SchemeTariffLine",
]
