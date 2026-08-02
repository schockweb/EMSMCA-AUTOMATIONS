"""
EMS Medical Claims Ingestion Portal — Configuration
Loads all environment variables via Pydantic Settings.
"""
from __future__ import annotations
import json
import os
from functools import lru_cache
from typing import Optional

from pydantic import BaseModel, model_validator
from pydantic_settings import BaseSettings

# Values that mean "the deployer never set this". Compared upper-cased.
_PLACEHOLDER_SECRETS = {
    "CHANGE_ME",
    "CHANGEME",
    "CHANGE_ME_IN_PRODUCTION",
    "CHANGE-ME",
    "YOUR_SECRET_KEY_HERE",
    "SECRET",
    "SECRET_KEY",
    "ENCRYPTION_KEY",
    "TEST",
    "TESTING",
    "DEV",
    "DEVELOPMENT",
    "PLACEHOLDER",
    "XXX",
    "TODO",
}


class Settings(BaseSettings):
    # ── Environment ──
    APP_ENV: str = "production"  # "development" or "production"

    # ── Database ──
    DATABASE_URL: str = "postgresql+asyncpg://ems_admin:ems_secure_2024@localhost:5432/ems_claims"

    # ── Database SSL ──
    # Set to 'require' in production (Azure PostgreSQL enforces SSL).
    # Leave empty for local dev (plain Docker Postgres needs no SSL).
    DB_SSL_MODE: str = ""

    # ── Record retention (POPIA s14) ──
    # How long a live clinical record is kept, measured from its capture date.
    # A setting rather than a constant so a provider whose regulator or insurer
    # requires longer can raise it without a code change. It must NEVER be
    # lowered without a documented instruction from the responsible party:
    # destroying a health record early is as much a breach as over-retention.
    RETENTION_YEARS: float = 7.0
    # Destruction is irreversible, so it is OPT-IN. See app/tasks/retention.py
    # for why a task that silently begins deleting patient records years after
    # it was written is a worse outcome than tracking the obligation by hand.
    RETENTION_ENFORCE: bool = False

    # ── Database Connection Pool ──
    # Tuned for high concurrency (500+ ambulances, 1500 crew members).
    # pool_size × num_workers = persistent connections per backend replica.
    # max_overflow provides burst headroom above pool_size.
    DB_POOL_SIZE: int = 20
    DB_MAX_OVERFLOW: int = 30
    DB_POOL_TIMEOUT: int = 30
    DB_POOL_RECYCLE: int = 120  # Keeps connections alive through Azure's 4-minute NAT timeout

    # ── RabbitMQ / Celery ──
    CELERY_BROKER_URL: str = "amqp://ems_rabbit:rabbit_secure_2024@localhost:5672//"

    # ── Redis Cache ──
    # Used for caching PRF detail responses, crew rosters, and provider configs.
    # Set to empty string to disable caching (falls back to direct DB reads).
    REDIS_URL: str = "redis://redis:6379/0"
    CACHE_TTL_PRF_DRAFT_SECONDS:      int = 60    # 1 min   — draft PRFs change often
    CACHE_TTL_PRF_SUBMITTED_SECONDS:  int = 3600  # 1 hour  — submitted PRFs rarely change
    CACHE_TTL_PROVIDER_SECONDS:       int = 3600  # 1 hour  — provider config is stable
    CACHE_TTL_CREW_SECONDS:           int = 300   # 5 min   — crew rosters change per shift

    # ── Mistral AI ──
    MISTRAL_API_KEY: str = ""

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

    # Tariff / billing-code engine is disabled while it is still being built.
    # The billing codes are not finalised and must NOT influence any data yet,
    # so generate_tariff_lines() returns an empty, unpriced result on every path
    # (Digital-PRF task, OCR pipeline, adjudication + claims endpoints). PRFs
    # still process into a viewable Case/Claim — just with no lines and total 0.
    # Flip to True (or set TARIFF_ENGINE_ENABLED=true in .env) to resume billing.
    TARIFF_ENGINE_ENABLED: bool = False

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
    # INFO, not DEBUG. This is the default a FRESH instance boots with, and
    # production does not set LOG_LEVEL at all — so the old default meant every
    # deployment ran at DEBUG. Nothing in the app logs patient data today (SQL
    # echo is False, and a 24h scan of production logs found no ID numbers,
    # patient names, tokens or passwords), but these logs are kept for SEVEN
    # YEARS by logrotate, so a single future debug statement would leave PHI in
    # a long-lived file. Defaulting to INFO makes that fail safe instead.
    # Developers opt into DEBUG explicitly via .env.
    LOG_LEVEL: str = "INFO"
    LOG_FORMAT: str = "text"  # "text" or "json"

    # ── POPIA Encryption (MUST be set via environment — no default) ──
    ENCRYPTION_KEY: str

    class Config:
        env_file = ".env"
        case_sensitive = True
        extra = "ignore"

    @model_validator(mode="after")
    def _reject_placeholder_secrets(self) -> "Settings":
        """Refuse to boot a production instance on a shipped placeholder secret.

        SECRET_KEY and ENCRYPTION_KEY have no defaults, which reads as safe — but
        `.env.example` ships both as the literal `CHANGE_ME`, and a deployer who
        copies the example and fills in the database URL gets a fully working
        instance. Nothing complained, because:

          * SECRET_KEY is only ever handed to jose, which signs happily with any
            string. Every access token, refresh token and portal-grant on that
            box is then forgeable by anyone who has read our public example file
            — including a token claiming SUPER_ADMIN.
          * ENCRYPTION_KEY is only ever handed to app.utils.crypto, which
            deliberately DERIVES a valid Fernet key from any non-Fernet string so
            an odd prod key can't brick the app. That resilience means a
            placeholder key encrypts and decrypts perfectly — with a key anyone
            can reproduce in one line.

        This is precisely the failure mode of handing the system to a client to
        install on their own VM, so it fails at startup instead of silently.
        Non-production environments only get a warning, so dev and CI still boot.
        """
        problems: list[str] = []
        for name in ("SECRET_KEY", "ENCRYPTION_KEY"):
            raw = (getattr(self, name, "") or "").strip()
            if not raw:
                problems.append(f"{name} is empty")
            elif raw.upper() in _PLACEHOLDER_SECRETS:
                problems.append(f"{name} is still the placeholder value '{raw}'")
            elif len(raw) < 32:
                problems.append(
                    f"{name} is only {len(raw)} characters — use at least 32 "
                    f"(generate with: python -c \"import secrets; print(secrets.token_urlsafe(48))\")"
                )

        if not problems:
            return self

        detail = "; ".join(problems)
        if self.APP_ENV == "production":
            raise ValueError(
                f"Refusing to start in production with insecure secrets: {detail}. "
                f"Set real values in .env before deploying."
            )

        import warnings
        warnings.warn(
            f"INSECURE SECRETS (tolerated because APP_ENV={self.APP_ENV}): {detail}",
            stacklevel=2,
        )
        return self

    @model_validator(mode="after")
    def _require_database_tls_in_production(self) -> "Settings":
        """Refuse to boot a production instance that talks to the database in
        the clear.

        Every patient name, SA ID number and clinical note in this system
        crosses this connection. DB_SSL_MODE defaults to "" so local Docker
        Postgres (which serves no certificate) works out of the box — and that
        default is silent, so a client installing on their own VM gets an
        instance that looks completely normal while shipping PHI unencrypted
        across their network.

        This is the same failure mode as the placeholder secrets above, and gets
        the same treatment: fatal in production, a warning everywhere else.

        Either mechanism satisfies it — DB_SSL_MODE=require, or an ssl/sslmode
        parameter already in DATABASE_URL, which is how this deployment does it.
        """
        url = (self.DATABASE_URL or "").lower()
        tls = (
            self.DB_SSL_MODE.strip().lower() in {"require", "verify-ca", "verify-full"}
            or "ssl=require" in url or "sslmode=require" in url
            or "ssl=true" in url or "sslmode=verify" in url
        )
        if tls:
            return self

        # A loopback database cannot be intercepted on the wire; demanding TLS
        # there would only push people to disable the check entirely.
        local = any(h in url for h in ("@localhost", "@127.0.0.1", "@postgres", "@db:", "@ems_postgres"))

        if self.APP_ENV == "production" and not local:
            raise ValueError(
                "Refusing to start in production without TLS to the database. "
                "Patient identifiers and clinical notes would cross the network "
                "in plaintext. Set DB_SSL_MODE=require, or add ssl=require to "
                "DATABASE_URL."
            )

        import warnings
        warnings.warn(
            f"Database connection is NOT encrypted (APP_ENV={self.APP_ENV}). "
            f"Acceptable for local development only.",
            stacklevel=2,
        )
        return self


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
