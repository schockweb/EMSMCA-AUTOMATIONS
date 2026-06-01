"""
EMS Medical Claims Ingestion Portal — Configuration
Loads all environment variables via Pydantic Settings.
"""
from __future__ import annotations
import json
import os
from functools import lru_cache
from typing import Optional

from pydantic import BaseModel
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # ── Environment ──
    APP_ENV: str = "production"  # "development" or "production"

    # ── Database ──
    DATABASE_URL: str = "postgresql+asyncpg://ems_admin:ems_secure_2024@localhost:5432/ems_claims"

    # ── Database Connection Pool ──
    # Tuned for high concurrency (500+ ambulances, 1500 crew members).
    # pool_size × num_workers = persistent connections per backend replica.
    # max_overflow provides burst headroom above pool_size.
    DB_POOL_SIZE: int = 20
    DB_MAX_OVERFLOW: int = 30
    DB_POOL_TIMEOUT: int = 30
    DB_POOL_RECYCLE: int = 1800

    # ── RabbitMQ / Celery ──
    CELERY_BROKER_URL: str = "amqp://ems_rabbit:rabbit_secure_2024@localhost:5672//"

    # ── JWT Auth (SECRET_KEY MUST be set via environment — no default) ──
    SECRET_KEY: str
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60
    REFRESH_TOKEN_EXPIRE_DAYS: int = 7

    # ── Claid.ai ──
    CLAID_API_KEY: str = ""

    # ── Azure AI Document Intelligence ──
    AZURE_DOC_INTEL_ENDPOINT: str = ""
    AZURE_DOC_INTEL_KEY: str = ""

    # ── Azure OpenAI ──
    AZURE_OPENAI_ENDPOINT: str = ""
    AZURE_OPENAI_API_KEY: str = ""
    AZURE_OPENAI_DEPLOYMENT: str = "gpt-4o"
    AZURE_OPENAI_API_VERSION: str = "2024-02-15-preview"

    # ── Azure OpenCV / LlamaParse ──
    LLAMA_CLOUD_API_KEY: str = ""

    # ── File Storage ──
    UPLOAD_DIR: str = "./uploads"
    MAX_UPLOAD_SIZE_MB: int = 50

    # ── Feature flags ──
    # OCR / paper-PRF intake is disabled while we focus on the Digital PRF
    # rollout. The endpoints, models, Celery tasks, and uploads/ directory all
    # remain in place — they just refuse new work when this flag is False.
    # Flip to True (or set OCR_INTAKE_ENABLED=true in .env) to re-enable.
    OCR_INTAKE_ENABLED: bool = False

    # ── CORS ──
    FRONTEND_URL: str = "http://localhost:5173"
    CORS_ORIGINS: str = "http://localhost:5173,http://localhost:3000"

    # ── Public app URL (for outbound email links) ──
    # When the doctor is emailed a /doctor-portal/<token> link they need a
    # publicly-routable URL — not the internal docker hostname. Falls back to
    # FRONTEND_URL when unset.
    PUBLIC_APP_URL: str = ""

    # ── Notifications ──
    INFOBIP_API_KEY: str = ""
    INFOBIP_BASE_URL: str = "https://api.infobip.com"
    TWILIO_ACCOUNT_SID: str = ""
    TWILIO_AUTH_TOKEN: str = ""
    TWILIO_FROM_NUMBER: str = ""

    # ── Outbound email (optional) ──
    # Used to auto-deliver the Digital PRF to a receiving doctor when an
    # email is captured at handover. If SMTP_HOST is empty the endpoint
    # gracefully no-ops and reports `sent: false` so the demo still works
    # without a configured relay.
    SMTP_HOST: str = ""
    SMTP_PORT: int = 587
    SMTP_USERNAME: str = ""
    SMTP_PASSWORD: str = ""
    SMTP_USE_TLS: bool = True
    SMTP_FROM_EMAIL: str = ""
    SMTP_FROM_NAME: str = "EMS Claims Portal"

    # ── Logging ──
    LOG_LEVEL: str = "DEBUG"
    LOG_FORMAT: str = "text"  # "text" or "json"

    # ── POPIA Encryption (MUST be set via environment — no default) ──
    ENCRYPTION_KEY: str

    class Config:
        env_file = ".env"
        case_sensitive = True
        extra = "ignore"


@lru_cache()
def get_settings() -> Settings:
    return Settings()


# ═══════════════════════════════════════════════════════════════════════════
# Scheme credentials — per-scheme B2B API config, read from environment
# ═══════════════════════════════════════════════════════════════════════════
# Replaces the old `scheme_configs` DB table. Each scheme's credentials are
# loaded on demand from env vars prefixed SCHEME_<NAME>_<FIELD>.
#
# Example .env entries for GEMS:
#   SCHEME_GEMS_BASE_URL=https://api.gems.gov.za/b2b/v1
#   SCHEME_GEMS_CLIENT_ID=my-client-id
#   SCHEME_GEMS_CLIENT_SECRET=my-secret
#   SCHEME_GEMS_ENVIRONMENT=sandbox
#   SCHEME_GEMS_INTEGRATION_TYPE=generic
#   SCHEME_GEMS_OAUTH_TOKEN_URL=https://api.gems.gov.za/oauth/token
#   SCHEME_GEMS_PROVIDER_PRACTICE=009003074661
#   SCHEME_GEMS_PAYER_TYPE=SCHEME
#   SCHEME_GEMS_CONTACT_EMAIL=auth@gems.gov.za
#   SCHEME_GEMS_MATCH_KEYWORDS=gems,government employees
#   SCHEME_GEMS_EXTRA_HEADERS_JSON={"X-Practice-Type": "EMS"}


class SchemeCredentials(BaseModel):
    """Per-scheme B2B API configuration. Pydantic model — no ORM backing."""
    scheme_id: str
    base_url: str
    client_id: Optional[str] = None
    client_secret: Optional[str] = None
    api_key: Optional[str] = None
    environment: str = "sandbox"
    integration_type: str = "generic"
    oauth_token_url: Optional[str] = None
    provider_practice_number: Optional[str] = None
    payer_type: str = "SCHEME"          # "SCHEME" | "AGGREGATOR"
    contact_email: Optional[str] = None
    phone_number: Optional[str] = None
    extra_headers: dict = {}
    match_keywords: list[str] = []


def _env_key(scheme_id: str, field: str) -> str:
    return f"SCHEME_{scheme_id.upper()}_{field.upper()}"


def _env(scheme_id: str, field: str, default: Optional[str] = None) -> Optional[str]:
    return os.environ.get(_env_key(scheme_id, field), default)


def get_scheme_credentials(scheme_id: str) -> Optional[SchemeCredentials]:
    """Build a SchemeCredentials object from environment variables.

    Returns None if the minimum-required fields (BASE_URL) are absent — this
    lets callers detect 'scheme not configured' without try/except plumbing.
    """
    if not scheme_id:
        return None

    base_url = _env(scheme_id, "BASE_URL")
    if not base_url:
        return None

    headers_raw = _env(scheme_id, "EXTRA_HEADERS_JSON", "")
    try:
        extra_headers = json.loads(headers_raw) if headers_raw else {}
    except (ValueError, TypeError):
        extra_headers = {}

    keywords_raw = _env(scheme_id, "MATCH_KEYWORDS", "")
    match_keywords = [k.strip() for k in keywords_raw.split(",") if k.strip()]

    return SchemeCredentials(
        scheme_id=scheme_id.lower(),
        base_url=base_url,
        client_id=_env(scheme_id, "CLIENT_ID"),
        client_secret=_env(scheme_id, "CLIENT_SECRET"),
        api_key=_env(scheme_id, "API_KEY"),
        environment=_env(scheme_id, "ENVIRONMENT", "sandbox") or "sandbox",
        integration_type=_env(scheme_id, "INTEGRATION_TYPE", "generic") or "generic",
        oauth_token_url=_env(scheme_id, "OAUTH_TOKEN_URL"),
        provider_practice_number=_env(scheme_id, "PROVIDER_PRACTICE"),
        payer_type=_env(scheme_id, "PAYER_TYPE", "SCHEME") or "SCHEME",
        contact_email=_env(scheme_id, "CONTACT_EMAIL"),
        phone_number=_env(scheme_id, "PHONE_NUMBER"),
        extra_headers=extra_headers,
        match_keywords=match_keywords,
    )


def get_scheme_credentials_by_name(scheme_name: str) -> Optional[SchemeCredentials]:
    """Resolve credentials by free-text scheme name via the rules registry.

    Falls through to get_scheme_credentials() using the matched SCHEME_ID so
    the same fuzzy-match logic that resolves pricing also resolves creds.
    """
    # Lazy import — avoids circular dep with app.rules, which can pull config.
    from app.rules import get_rules_for_scheme
    module = get_rules_for_scheme(scheme_name)
    if module is None:
        return None
    return get_scheme_credentials(module.SCHEME_ID)
