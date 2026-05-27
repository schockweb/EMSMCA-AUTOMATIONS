"""
EMS Medical Claims Ingestion Portal — FastAPI Application Entry Point
Production-hardened with rate limiting, XSS protection, structured logging.
"""
import os
import time
from contextlib import asynccontextmanager
from fastapi import FastAPI, Depends, BackgroundTasks, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from sqlalchemy import select, text

from app.config import get_settings
from app.database import create_tables, AsyncSessionLocal, get_db
from app.models.user import User, UserRole
from app.utils.security import hash_password
from app.middleware import RateLimitMiddleware, XSSProtectionMiddleware, CrashHandlerMiddleware, setup_logging, get_logger

# Import routers
from app.api.auth import router as auth_router
from app.api.users import router as users_router
from app.api.cases import router as cases_router
from app.api.claims import router as claims_router
from app.api.documents import router as documents_router
from app.api.adjudication import router as adjudication_router
from app.api.edi import router as edi_router
from app.api.analytics import router as analytics_router
from app.api.authorization import router as authorization_router
from app.api.mock_scheme import router as mock_scheme_router
from app.api.gateway import router as gateway_router
from app.api.crashes import router as crashes_router
from app.api.member_lookup import router as member_lookup_router
from app.api.geocode import router as geocode_router
from app.api.crew_auth import router as crew_auth_router
from app.api.providers import router as providers_router
from app.api.digital_prf import router as digital_prf_router
from app.api.rate_schemas import router as rate_schemas_router
from app.api.failed_prfs import router as failed_prfs_router
from app.api.metrics import router as metrics_router

settings = get_settings()
logger = get_logger("main")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup/shutdown lifecycle handler."""
    # Initialize structured logging
    setup_logging()
    logger.info("Starting EMS Claims Portal...")

    # Create tables on startup (dev mode — production uses Alembic)
    await create_tables()
    logger.info("Database tables verified.")

    # Initialise the PRF number sequence — sync with existing data so the
    # sequence starts from MAX(prf_number)+1, preventing collisions.
    await _init_prf_sequence()

    # Seed admin user if none exists
    await seed_admin_user()

    # Seed super admin user
    await seed_super_admin()

    # Auto-purge crash events older than 90 days
    await purge_old_crashes()

    logger.info("EMS Claims Portal ready.")
    yield
    logger.info("EMS Claims Portal shutting down.")


async def _init_prf_sequence():
    """Initialise the PostgreSQL sequence for PRF numbers.

    On first run, creates the sequence. On subsequent runs, ensures it starts
    from MAX(prf_number)+1 so there are no collisions with existing PRFs.
    """
    from app.models.digital_prf import DigitalPRF
    from sqlalchemy import func

    async with AsyncSessionLocal() as db:
        # Create the sequence if it doesn't exist
        await db.execute(text(
            "CREATE SEQUENCE IF NOT EXISTS prf_number_seq "
            "START WITH 1 INCREMENT BY 1 NO CYCLE"
        ))

        # Sync with existing data
        result = await db.execute(select(func.max(DigitalPRF.prf_number)))
        max_prf = result.scalar() or 0
        if max_prf > 0:
            await db.execute(text(
                f"ALTER SEQUENCE prf_number_seq RESTART WITH {max_prf + 1}"
            ))
            logger.info("PRF number sequence synced — next PRF will be #%d", max_prf + 1)
        else:
            logger.info("PRF number sequence initialised at #1")
        await db.commit()


async def seed_admin_user():
    """Create a default admin user if the users table is empty."""
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(User).limit(1))
        if result.scalar_one_or_none() is None:
            admin = User(
                email="admin@emsclaims.co.za",
                hashed_password=hash_password("Admin@2024!"),
                full_name="System Administrator",
                role=UserRole.ADMIN,
                bhf_practice_number="0000000",
            )
            db.add(admin)
            await db.commit()
            logger.info("Seeded default admin user: admin@emsclaims.co.za")


async def seed_super_admin():
    """Ensure the default admin has super_admin role and rule_builder access."""
    async with AsyncSessionLocal() as db:
        # Check if the admin user exists
        admin_result = await db.execute(select(User).where(User.email == "admin@emsclaims.co.za"))
        admin = admin_result.scalar_one_or_none()
        if admin:
            needs_commit = False
            if admin.role != UserRole.SUPER_ADMIN:
                admin.role = UserRole.SUPER_ADMIN
                needs_commit = True
            
            # Ensure rule_builder permission is present
            current_perms = list(admin.permissions or [])
            if "rule_builder" not in current_perms:
                current_perms.append("rule_builder")
                admin.permissions = current_perms
                needs_commit = True
            
            if needs_commit:
                await db.commit()
                logger.info("Verified super_admin role and rule_builder access for admin@emsclaims.co.za.")


async def purge_old_crashes():
    """Auto-purge crash events older than 90 days on startup."""
    from sqlalchemy import delete as sa_delete
    from app.models.crash_event import CrashEvent

    async with AsyncSessionLocal() as db:
        cutoff = CrashEvent.purge_cutoff()
        result = await db.execute(
            sa_delete(CrashEvent).where(CrashEvent.created_at < cutoff)
        )
        await db.commit()
        if result.rowcount > 0:
            logger.info("Auto-purged %d crash events older than 90 days.", result.rowcount)


# ── Create FastAPI App ────────────────────────────────────

app = FastAPI(
    title="EMS Medical Claims Ingestion Portal",
    description=(
        "Next-generation API-first platform for automated EMS medical claims "
        "processing — ingestion, AI extraction, clinical adjudication, and EDI submission."
    ),
    version="1.0.0",
    lifespan=lifespan,
    docs_url="/docs" if settings.APP_ENV == "development" else None,
    redoc_url="/redoc" if settings.APP_ENV == "development" else None,
)

from starlette.middleware.base import BaseHTTPMiddleware
import traceback

class ErrorLoggingMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        try:
            return await call_next(request)
        except Exception as e:
            with open('global_errors.txt', 'a') as f:
                f.write('==========================\t\n')
                f.write(str(request.url) + '\n')
                traceback.print_exc(file=f)
            raise
app.add_middleware(ErrorLoggingMiddleware)

# ── Middleware Stack (order matters: last added = first executed) ──

# 1. CORS — environment-aware, controlled via CORS_ORIGINS env var
cors_origins = list({o.strip() for o in settings.CORS_ORIGINS.split(",") if o.strip()})
if settings.FRONTEND_URL and settings.FRONTEND_URL not in cors_origins:
    cors_origins.append(settings.FRONTEND_URL)
if settings.APP_ENV == "development":
    # Dev: allow localhost variants
    cors_origins.extend(["http://localhost:5173", "http://localhost:5174", "http://localhost:3000", "http://localhost:8001"])
    cors_origins = list(set(cors_origins))  # deduplicate

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Request-ID"],
    expose_headers=["X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset"],
)

# 1b. Response compression — critical for mobile networks (60-80% size reduction)
from fastapi.middleware.gzip import GZipMiddleware
app.add_middleware(GZipMiddleware, minimum_size=1000)

# 2. Rate Limiting — per-IP sliding window
app.add_middleware(
    RateLimitMiddleware,
    auth_limit=10,     # 10 login attempts per minute per IP
    api_limit=300,     # 300 API calls per minute per IP
    window=60,
)

# 3. XSS Protection — query param scanning + security headers
app.add_middleware(XSSProtectionMiddleware)

# 4. Global Crash Handler — catches exceptions outside the router (e.g. middleware)
app.add_middleware(CrashHandlerMiddleware)

# 5. Global Exception Handler — catches unhandled exceptions inside FastAPI routes
from fastapi import Request
from fastapi.responses import JSONResponse
from app.middleware.crash_handler import record_crash_event

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    crash_id = await record_crash_event(request, exc)
    logger.error(
        "Unhandled route exception on %s %s — crash_id=%s: %s",
        request.method, request.url.path, crash_id, str(exc),
        exc_info=True,
    )
    return JSONResponse(
        status_code=500,
        content={
            "detail": "An internal error occurred. Our team has been notified.",
            "crash_id": str(crash_id),
        },
    )


# ── Register Routers ─────────────────────────────────────

app.include_router(auth_router)
app.include_router(users_router)
app.include_router(cases_router)
app.include_router(claims_router)
app.include_router(documents_router)
app.include_router(adjudication_router)
app.include_router(edi_router)
app.include_router(analytics_router)
app.include_router(authorization_router)
app.include_router(mock_scheme_router)
app.include_router(gateway_router)
app.include_router(crashes_router)
app.include_router(member_lookup_router)
app.include_router(geocode_router, prefix="/api/geocode", tags=["Geocoding"])
app.include_router(crew_auth_router)
app.include_router(providers_router)
app.include_router(digital_prf_router)
app.include_router(rate_schemas_router)
app.include_router(failed_prfs_router)
app.include_router(metrics_router)


# ═══════════════════════════════════════════════════════════
# HEALTH CHECK ENDPOINTS — for container orchestration
# ═══════════════════════════════════════════════════════════

@app.get("/", tags=["Health"])
async def root():
    """Basic health check."""
    return {
        "status": "healthy",
        "service": "EMS Claims Ingestion Portal",
        "version": "1.0.0",
    }


@app.get("/health", tags=["Health"])
async def health_check():
    """
    Deep health check — verifies database, RabbitMQ, Celery, and queue depth.
    Used by Docker HEALTHCHECK and load balancers.
    """
    checks = {
        "api": "healthy",
        "database": "unknown",
        "rabbitmq": "unknown",
        "celery_workers": "unknown",
        "queue": "unknown",
        "uptime_seconds": int(time.time() - _start_time),
    }

    # Check database
    try:
        async with AsyncSessionLocal() as db:
            await db.execute(text("SELECT 1"))
            checks["database"] = "healthy"
    except Exception as e:
        checks["database"] = f"unhealthy: {str(e)[:100]}"

    # RabbitMQ
    try:
        from app.tasks.celery_app import celery_app as _celery
        conn = _celery.connection()
        conn.ensure_connection(max_retries=1, timeout=3)
        conn.close()
        checks["rabbitmq"] = "healthy"
    except Exception as e:
        checks["rabbitmq"] = f"unhealthy: {str(e)[:100]}"

    # Celery workers
    try:
        from app.tasks.celery_app import celery_app as _celery
        inspector = _celery.control.inspect(timeout=3)
        active = inspector.active()
        wc = len(active) if active else 0
        checks["celery_workers"] = f"healthy ({wc} nodes)" if wc > 0 else "unhealthy: no active workers"
    except Exception as e:
        checks["celery_workers"] = f"unhealthy: {str(e)[:100]}"

    # Queue depth (Item 9) — query RabbitMQ management API
    try:
        import httpx
        from app.config import get_settings
        _settings = get_settings()
        # Parse credentials from CELERY_BROKER_URL (amqp://user:pass@host:port//)
        broker_url = _settings.CELERY_BROKER_URL
        # Extract host from broker URL for management API
        import re
        match = re.search(r"amqp://([^:]+):([^@]+)@([^:]+):(\d+)", broker_url)
        if match:
            rmq_user, rmq_pass, rmq_host, _ = match.groups()
            mgmt_url = f"http://{rmq_host}:15672/api/queues/%2F/ems_default"
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.get(mgmt_url, auth=(rmq_user, rmq_pass))
                if resp.status_code == 200:
                    q_data = resp.json()
                    depth = q_data.get("messages", 0)
                    consumers = q_data.get("consumers", 0)

                    if depth > 200:
                        q_status = "unhealthy"
                    elif depth > 100:
                        q_status = "degraded"
                    else:
                        q_status = "healthy"

                    checks["queue"] = {
                        "status": q_status,
                        "depth": depth,
                        "consumers": consumers,
                    }
                else:
                    checks["queue"] = f"unknown (HTTP {resp.status_code})"
        else:
            checks["queue"] = "unknown (could not parse broker URL)"
    except Exception as e:
        checks["queue"] = f"unknown: {str(e)[:100]}"

    # Determine overall status
    unhealthy = False
    for k, v in checks.items():
        if k in ("api", "uptime_seconds"):
            continue
        if isinstance(v, str) and v.startswith("unhealthy"):
            unhealthy = True
        elif isinstance(v, dict) and v.get("status") == "unhealthy":
            unhealthy = True

    if unhealthy:
        checks["api"] = "degraded"

    status_code = 200 if not unhealthy else 503
    from starlette.responses import JSONResponse
    return JSONResponse(content=checks, status_code=status_code)


@app.get("/health/ready", tags=["Health"])
async def readiness_check():
    """
    Readiness probe — indicates if the service can accept traffic.
    Used by Kubernetes readinessProbe.
    """
    try:
        async with AsyncSessionLocal() as db:
            result = await db.execute(select(User).limit(1))
            has_users = result.scalar_one_or_none() is not None
        return {"ready": True, "seeded": has_users}
    except Exception:
        from starlette.responses import JSONResponse
        return JSONResponse(content={"ready": False}, status_code=503)


_start_time = time.time()


# ── Dashboard Stats ──────────────────────────────────────

@app.get("/api/stats", tags=["Dashboard"])
async def get_stats():
    """Quick statistics for the dashboard — includes pipeline stage counts."""
    from sqlalchemy import func
    from app.models.document import Document, OCRStatus
    from app.models.claim import Claim, AdjudicationStatus
    from app.models.case import Case
    from app.models.edi_submission import EDISubmission, SubmissionStatus

    async with AsyncSessionLocal() as session:
        docs_total = await session.execute(select(func.count(Document.id)))
        docs_pending = await session.execute(
            select(func.count(Document.id)).where(
                Document.ocr_status.in_([OCRStatus.PENDING, OCRStatus.PREPROCESSING, OCRStatus.EXTRACTING])
            )
        )
        docs_completed = await session.execute(
            select(func.count(Document.id)).where(Document.ocr_status == OCRStatus.COMPLETED)
        )
        # Must match the AdminQueue's default filter (exclude_accepted=true) so
        # the banner count only shows documents the reviewer can actually open
        # from /verify. Documents already linked to a Case are hidden there, so
        # counting them here produces a phantom "1 document" banner with an
        # empty queue on click.
        docs_review = await session.execute(
            select(func.count(Document.id)).where(
                Document.needs_hitl_review == True,
                Document.case_id.is_(None),
            )
        )
        claims_total = await session.execute(select(func.count(Claim.id)))
        claims_clean = await session.execute(
            select(func.count(Claim.id)).where(Claim.adjudication_status == AdjudicationStatus.CLEAN)
        )
        cases_total = await session.execute(select(func.count(Case.id)))

        # ── Pipeline stage counts (cumulative throughput) ──
        # Preprocessing = docs currently being processed (active queue only)
        docs_preprocessing = await session.execute(
            select(func.count(Document.id)).where(
                Document.ocr_status.in_([OCRStatus.PREPROCESSING, OCRStatus.EXTRACTING])
            )
        )

        # Adjudication = all claims that have been adjudicated (any status except pending)
        claims_adjudicated = await session.execute(
            select(func.count(Claim.id)).where(
                Claim.adjudication_status != AdjudicationStatus.PENDING
            )
        )

        # EDI submitted = all EDI submissions that have been submitted or beyond
        edi_submitted = await session.execute(
            select(func.count(EDISubmission.id)).where(
                EDISubmission.submission_status.in_([
                    SubmissionStatus.SUBMITTED,
                    SubmissionStatus.ACKNOWLEDGED,
                    SubmissionStatus.ACCEPTED,
                    SubmissionStatus.PARTIAL,
                ])
            )
        )

        # Extract scalars into variables (can only call .scalar() once per result)
        total_val = docs_total.scalar() or 0
        pending_val = docs_pending.scalar() or 0
        completed_val = docs_completed.scalar() or 0
        review_val = docs_review.scalar() or 0
        claims_total_val = claims_total.scalar() or 0
        claims_clean_val = claims_clean.scalar() or 0
        cases_total_val = cases_total.scalar() or 0
        preprocessed_val = docs_preprocessing.scalar() or 0
        adjudicated_val = claims_adjudicated.scalar() or 0
        edi_submitted_val = edi_submitted.scalar() or 0

        return {
            "documents": {
                "total": total_val,
                "pending": pending_val,
                "completed": completed_val,
                "needs_review": review_val,
            },
            "claims": {
                "total": claims_total_val,
                "clean": claims_clean_val,
            },
            "cases": {
                "total": cases_total_val,
            },
            "pipeline": {
                "ingested": total_val,
                "preprocessed": preprocessed_val,
                "ocr_completed": completed_val,
                "adjudicated": adjudicated_val,
                "edi_submitted": edi_submitted_val,
            },
        }


# ═══════════════════════════════════════════════════════════
# INVOICE SUBMISSION — Payer-type-aware async routing
# ═══════════════════════════════════════════════════════════

from fastapi import BackgroundTasks, Depends as FastAPIDepends
from app.database import get_db
from sqlalchemy.ext.asyncio import AsyncSession


async def _execute_invoice_routing(
    claim_id: str,
    payer_type: str,
    invoice_data: dict,
) -> None:
    """
    Background task: routes the invoice through the correct strategy.
    Runs asynchronously after the HTTP response has been sent.
    """
    import uuid as _uuid
    from datetime import datetime as _dt, timezone as _tz
    from app.services.submission_strategies import route_invoice
    from app.models.claim import Claim, AdjudicationStatus

    result = await route_invoice(invoice_data, payer_type)

    if result.success:
        logger.info(
            "Invoice routing completed for claim %s via %s — ref: %s",
            claim_id, result.strategy_name, result.reference,
        )
        # Persist the reference back to the claim
        async with AsyncSessionLocal() as db:
            claim_result = await db.execute(
                select(Claim).where(Claim.id == _uuid.UUID(claim_id))
            )
            claim = claim_result.scalar_one_or_none()
            if claim:
                claim.adjudication_status = AdjudicationStatus.SUBMITTED
                claim.submitted_at = _dt.now(_tz.utc)
                if payer_type == "AGGREGATOR" and result.reference:
                    claim.dispatch_reference_number = result.reference
                await db.commit()
                logger.info("Claim %s status updated to SUBMITTED.", claim_id)
    else:
        logger.error(
            "Invoice routing FAILED for claim %s: %s",
            claim_id, result.error,
        )


@app.post("/api/invoices/{invoice_id}/submit", tags=["Invoices"], status_code=202)
async def submit_invoice(
    invoice_id: str,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    """
    Submit an approved invoice for payer routing.

    Determines the payer type (SCHEME or AGGREGATOR) and dispatches
    the invoice to the correct submission strategy as a background task.
    Returns 202 Accepted immediately.
    """
    import uuid as _uuid
    from app.models.claim import Claim
    from app.models.case import Case
    from app.rules import get_rules_for_scheme

    # 1. Load the claim
    claim_result = await db.execute(
        select(Claim).where(Claim.id == _uuid.UUID(invoice_id))
    )
    claim = claim_result.scalar_one_or_none()
    if not claim:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Invoice (claim) not found.")

    # 2. Load the parent case
    case_result = await db.execute(
        select(Case).where(Case.id == claim.case_id)
    )
    case = case_result.scalar_one_or_none()
    if not case:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Associated case not found.")

    # 3. Resolve payer type from the scheme's hardcoded rule module.
    # This is the second guard against submitting a claim for a scheme with no
    # pricing module — the first guard runs at invoice generation time.
    payer_type = "SCHEME"
    payer_name = case.medical_scheme_name or "Unknown"

    if case.medical_scheme_name:
        rules_module = get_rules_for_scheme(case.medical_scheme_name)
        if rules_module is None:
            from fastapi import HTTPException
            raise HTTPException(
                status_code=422,
                detail=(
                    f"No pricing module configured for scheme "
                    f"'{case.medical_scheme_name}'. Contact engineering to add "
                    f"a module under backend/app/rules/."
                ),
            )
        payer_type = getattr(rules_module, "PAYER_TYPE", "SCHEME")
        payer_name = case.medical_scheme_name

    # 4. Build invoice payload
    invoice_data: dict = {
        "claim_id": str(claim.id),
        "case_id": str(case.id),
        "payer_name": payer_name,
        "payer_type": payer_type,
        "total_amount": float(claim.total_amount or 0),
        "target_scheme": claim.target_scheme,
        "dispatch_reference_number": claim.dispatch_reference_number or "",
        "patient_name": case.patient_name,
        "medical_scheme_name": case.medical_scheme_name or "",
        "scheme_member_number": case.scheme_member_number or "",
        "preauth_number": case.preauth_number or "",
    }

    # 5. Dispatch to background
    background_tasks.add_task(
        _execute_invoice_routing,
        claim_id=str(claim.id),
        payer_type=payer_type,
        invoice_data=invoice_data,
    )

    logger.info(
        "Invoice %s queued for %s routing (payer: %s).",
        invoice_id, payer_type, payer_name,
    )

    return {
        "status": "accepted",
        "message": f"Invoice queued for {payer_type} routing.",
        "invoice_id": str(claim.id),
        "payer_type": payer_type,
        "payer_name": payer_name,
    }


