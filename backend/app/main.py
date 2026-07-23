"""
EMS Medical Claims Ingestion Portal — FastAPI Application Entry Point
Production-hardened with rate limiting, XSS protection, structured logging.
"""
from __future__ import annotations
import os
import time
from contextlib import asynccontextmanager
from fastapi import FastAPI, Depends, BackgroundTasks, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select, text

from app.config import get_settings
from app.database import create_tables, AsyncSessionLocal, get_db
from app.models.user import User, UserRole
from app.utils.security import hash_password, get_current_user
from app.middleware import RateLimitMiddleware, XSSProtectionMiddleware, CrashHandlerMiddleware, setup_logging, get_logger
from app.core.response_cache import ResponseCacheMiddleware

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
from app.api.tariff_lines import router as tariff_lines_router

settings = get_settings()
logger = get_logger("main")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup/shutdown lifecycle handler."""
    # Initialize structured logging
    setup_logging()
    logger.info("Starting EMS Claims Portal...")

    # Create tables on startup (dev mode — production uses Alembic)
    if settings.APP_ENV == "development":
        await create_tables()
        logger.info("Database tables verified.")

    # PRF numbering is now per-provider (see `_next_prf_number`), so there is
    # no global sequence to seed. Startup no longer touches prf_number_seq —
    # migration f4b9c1d7e2a8 drops it.

    if settings.APP_ENV != "production":
        # Seed admin user if none exists
        await seed_admin_user()
        
        # Seed super admin user
        await seed_super_admin()

    # Auto-purge crash events older than 90 days
    await purge_old_crashes()

    logger.info("EMS Claims Portal ready.")
    yield
    logger.info("EMS Claims Portal shutting down.")


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



# ── Middleware Stack (order matters: last added = first executed) ──

# 1. CORS — environment-aware, controlled via CORS_ORIGINS env var
cors_origins = list({o.strip() for o in settings.CORS_ORIGINS.split(",") if o.strip()})
if settings.FRONTEND_URL and settings.FRONTEND_URL not in cors_origins:
    cors_origins.append(settings.FRONTEND_URL)
if settings.APP_ENV == "development":
    # Dev: allow localhost variants
    cors_origins.extend(["http://localhost:5173", "http://localhost:5174", "http://localhost:3000", "http://localhost:8001"])
    cors_origins = list(set(cors_origins))  # deduplicate

# Guardrail: a wildcard origin combined with credentialed requests is an
# account-takeover-grade misconfig (any site could ride the user's cookies/token).
# If someone sets CORS_ORIGINS="*", drop the wildcard rather than honour it — we
# never want a wide-open, credentialed CORS policy in this app.
if "*" in cors_origins:
    logger.warning(
        "CORS_ORIGINS contained '*'; refusing wildcard because allow_credentials=True. "
        "Set explicit origins (e.g. https://portal.emsmca.co.za) instead."
    )
    cors_origins = [o for o in cors_origins if o != "*"]

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

# 2. Rate Limiting — RE-ENABLED with trustworthy per-client keying.
#    The old limiter keyed buckets on the FIRST X-Forwarded-For entry, which
#    (a) attackers could rotate for a fresh bucket per request, and (b) merged
#    every legitimate user behind one proxy hop into a single shared bucket —
#    the "blocking legitimate login attempts" incident that got it disabled.
#    Buckets now key on get_trusted_client_ip (nginx-set X-Real-IP), so each
#    real client gets its own budget and the header cannot be forged through
#    our proxy. Auth paths: 15/min per client IP. Fails open without Redis.
app.add_middleware(
    RateLimitMiddleware,
    auth_limit=15,
    api_limit=300,
    window=60,
)

# 3. XSS Protection — query param scanning + security headers
app.add_middleware(XSSProtectionMiddleware)

# 4. Global Crash Handler
app.add_middleware(CrashHandlerMiddleware)

# 5. Response Cache — eliminates repeat Supabase round-trips (SA→Ireland)
#    Serves cached GET responses for 20-300s depending on endpoint.
#    Cache key includes auth token so users get isolated entries.
app.add_middleware(ResponseCacheMiddleware)

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
app.include_router(tariff_lines_router)

# ── Static file serving — uploaded logos and assets ──────────
_upload_dir = settings.UPLOAD_DIR or "./uploads"
os.makedirs(_upload_dir, exist_ok=True)


class _HardenedUploads(StaticFiles):
    """StaticFiles that neutralizes stored-XSS in user-uploaded files.

    Logos may legitimately be SVG, and an SVG (or a smuggled .html) served
    inline would otherwise run its own <script> when a victim opens the file
    URL directly. The `sandbox` CSP directive (no `allow-scripts`) makes the
    browser treat the response as sandboxed, so scripts never execute — while
    `<img src="/uploads/...">` embedding from the SPA still renders normally.
    """

    # Worker-spool subdirectories on the shared uploads volume that hold
    # confidential documents (patient PRF PDFs awaiting the email task).
    # They are NOT web assets and must never be served — without this guard
    # anyone holding the PRF UUID could fetch the full patient record
    # unauthenticated at /uploads/prf_email/<uuid>.pdf.
    _PRIVATE_PREFIXES = ("prf_email/", "prf_email\\")

    async def get_response(self, path, scope):
        norm = (path or "").lstrip("/\\")
        if norm.startswith(self._PRIVATE_PREFIXES):
            from starlette.responses import PlainTextResponse
            return PlainTextResponse("Not Found", status_code=404)
        response = await super().get_response(path, scope)
        response.headers["Content-Security-Policy"] = (
            "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox"
        )
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response


app.mount("/uploads", _HardenedUploads(directory=_upload_dir), name="uploads")

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
        logger.error("Database health check failed: %s", str(e))
        checks["database"] = "unhealthy"

    # RabbitMQ
    try:
        from app.tasks.celery_app import celery_app as _celery
        conn = _celery.connection()
        conn.ensure_connection(max_retries=1, timeout=3)
        conn.close()
        checks["rabbitmq"] = "healthy"
    except Exception as e:
        logger.error("RabbitMQ health check failed: %s", str(e))
        checks["rabbitmq"] = "unhealthy"

    # Celery workers
    try:
        from app.tasks.celery_app import celery_app as _celery
        inspector = _celery.control.inspect(timeout=3)
        active = inspector.active()
        wc = len(active) if active else 0
        checks["celery_workers"] = f"healthy ({wc} nodes)" if wc > 0 else "unhealthy: no active workers"
    except Exception as e:
        logger.error("Celery workers health check failed: %s", str(e))
        checks["celery_workers"] = "unhealthy"

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
        logger.error("Queue depth health check failed: %s", str(e))
        checks["queue"] = "unknown"

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
async def get_stats(_user: User = Depends(get_current_user)):
    """Quick statistics for the dashboard — includes pipeline stage counts.

    Auth required: this was the one unauthenticated data endpoint — it leaked
    operational counts (documents, claims, cases, EDI volumes) to anyone who
    could reach the server. The response-cache key includes the Authorization
    header and only 200s are cached, so adding auth cannot serve cached data
    to anonymous callers."""
    from sqlalchemy import func
    from app.models.document import Document, OCRStatus
    from app.models.claim import Claim, AdjudicationStatus
    from app.models.case import Case
    from app.models.edi_submission import EDISubmission, SubmissionStatus

    async with AsyncSessionLocal() as session:
        query = select(
            select(func.count(Document.id)).scalar_subquery().label("docs_total"),
            select(func.count(Document.id)).where(
                Document.ocr_status.in_([OCRStatus.PENDING, OCRStatus.PREPROCESSING, OCRStatus.EXTRACTING])
            ).scalar_subquery().label("docs_pending"),
            select(func.count(Document.id)).where(Document.ocr_status == OCRStatus.COMPLETED).scalar_subquery().label("docs_completed"),
            select(func.count(Document.id)).where(
                Document.needs_hitl_review == True,
                Document.case_id.is_(None),
            ).scalar_subquery().label("docs_review"),
            select(func.count(Claim.id)).scalar_subquery().label("claims_total"),
            select(func.count(Claim.id)).where(Claim.adjudication_status == AdjudicationStatus.CLEAN).scalar_subquery().label("claims_clean"),
            select(func.count(Case.id)).scalar_subquery().label("cases_total"),
            select(func.count(Document.id)).where(
                Document.ocr_status.in_([OCRStatus.PREPROCESSING, OCRStatus.EXTRACTING])
            ).scalar_subquery().label("docs_preprocessing"),
            select(func.count(Claim.id)).where(
                Claim.adjudication_status != AdjudicationStatus.PENDING
            ).scalar_subquery().label("claims_adjudicated"),
            select(func.count(EDISubmission.id)).where(
                EDISubmission.submission_status.in_([
                    SubmissionStatus.SUBMITTED,
                    SubmissionStatus.ACKNOWLEDGED,
                    SubmissionStatus.ACCEPTED,
                    SubmissionStatus.PARTIAL,
                ])
            ).scalar_subquery().label("edi_submitted")
        )

        result = await session.execute(query)
        row = result.fetchone()

        total_val = row.docs_total or 0
        pending_val = row.docs_pending or 0
        completed_val = row.docs_completed or 0
        review_val = row.docs_review or 0
        claims_total_val = row.claims_total or 0
        claims_clean_val = row.claims_clean or 0
        cases_total_val = row.cases_total or 0
        preprocessed_val = row.docs_preprocessing or 0
        adjudicated_val = row.claims_adjudicated or 0
        edi_submitted_val = row.edi_submitted or 0

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


