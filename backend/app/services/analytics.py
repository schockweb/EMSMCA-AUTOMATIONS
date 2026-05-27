"""
Analytics Service — Real-time metrics for the claims lifecycle.
Computes DSO, rejection rates, AI confidence, revenue, and pipeline health.
"""
from datetime import datetime, timezone, timedelta
from decimal import Decimal
from sqlalchemy import select, func, case as sql_case, extract
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.claim import Claim, AdjudicationStatus
from app.models.document import Document, OCRStatus
from app.models.era import ERA, PaymentStatus
from app.models.edi_submission import EDISubmission, SubmissionStatus
from app.models.rfi import RFI, RFIStatus
from app.models.case import Case


async def get_dashboard_analytics(db: AsyncSession) -> dict:
    """
    Compute comprehensive analytics for the executive dashboard.
    """
    now = datetime.now(timezone.utc)
    thirty_days_ago = now - timedelta(days=30)
    seven_days_ago = now - timedelta(days=7)

    return {
        "pipeline": await _pipeline_metrics(db),
        "financial": await _financial_metrics(db),
        "ocr_performance": await _ocr_metrics(db),
        "claims": await _claims_metrics(db, thirty_days_ago),
        "submissions": await _submission_metrics(db),
        "rfi": await _rfi_metrics(db),
        "trends": await _weekly_trends(db, seven_days_ago),
        "generated_at": now.isoformat(),
    }


async def _pipeline_metrics(db: AsyncSession) -> dict:
    """Document processing pipeline health."""
    total = (await db.execute(select(func.count(Document.id)))).scalar() or 0
    pending = (await db.execute(
        select(func.count(Document.id)).where(Document.ocr_status == OCRStatus.PENDING)
    )).scalar() or 0
    preprocessing = (await db.execute(
        select(func.count(Document.id)).where(Document.ocr_status == OCRStatus.PREPROCESSING)
    )).scalar() or 0
    extracting = (await db.execute(
        select(func.count(Document.id)).where(Document.ocr_status == OCRStatus.EXTRACTING)
    )).scalar() or 0
    completed = (await db.execute(
        select(func.count(Document.id)).where(Document.ocr_status == OCRStatus.COMPLETED)
    )).scalar() or 0
    failed = (await db.execute(
        select(func.count(Document.id)).where(Document.ocr_status == OCRStatus.FAILED)
    )).scalar() or 0
    needs_review = (await db.execute(
        select(func.count(Document.id)).where(Document.needs_hitl_review == True)
    )).scalar() or 0

    completion_rate = (completed / max(total, 1)) * 100

    return {
        "total_documents": total,
        "pending": pending,
        "preprocessing": preprocessing,
        "extracting": extracting,
        "completed": completed,
        "failed": failed,
        "needs_review": needs_review,
        "completion_rate": round(completion_rate, 1),
        "automation_rate": round(((completed - needs_review) / max(completed, 1)) * 100, 1),
    }


async def _financial_metrics(db: AsyncSession) -> dict:
    """Revenue and payment metrics."""
    # Total claimed
    total_claimed = (await db.execute(
        select(func.coalesce(func.sum(Claim.total_amount), 0))
    )).scalar()

    # Total from ERAs
    total_paid = (await db.execute(
        select(func.coalesce(func.sum(ERA.amount_paid), 0))
    )).scalar()

    total_approved = (await db.execute(
        select(func.coalesce(func.sum(ERA.amount_approved), 0))
    )).scalar()

    patient_liability = (await db.execute(
        select(func.coalesce(func.sum(ERA.patient_liability), 0))
    )).scalar()

    # Revenue leakage = claimed - paid
    revenue_leakage = float(total_claimed) - float(total_paid)

    # Collection rate
    collection_rate = (float(total_paid) / max(float(total_claimed), 1)) * 100

    # DSO (Days Sales Outstanding)
    dso = await _calculate_dso(db)

    return {
        "total_claimed": float(total_claimed),
        "total_approved": float(total_approved),
        "total_paid": float(total_paid),
        "patient_liability": float(patient_liability),
        "revenue_leakage": revenue_leakage,
        "collection_rate": round(collection_rate, 1),
        "dso": dso,
        "currency": "ZAR",
    }


async def _calculate_dso(db: AsyncSession) -> float:
    """
    Calculate Days Sales Outstanding.
    DSO = (Accounts Receivable / Total Revenue) × Number of Days
    """
    # Claims submitted but not yet paid = accounts receivable
    ar_result = await db.execute(
        select(func.coalesce(func.sum(Claim.total_amount), 0)).where(
            Claim.adjudication_status.in_([
                AdjudicationStatus.SUBMITTED,
                AdjudicationStatus.CLEAN,
            ])
        )
    )
    accounts_receivable = float(ar_result.scalar())

    # Total paid in last 30 days
    thirty_days = datetime.now(timezone.utc) - timedelta(days=30)
    revenue_result = await db.execute(
        select(func.coalesce(func.sum(ERA.amount_paid), 0)).where(
            ERA.payment_date >= thirty_days
        )
    )
    monthly_revenue = float(revenue_result.scalar())
    daily_revenue = monthly_revenue / 30

    if daily_revenue <= 0:
        return 0.0

    return round(accounts_receivable / daily_revenue, 1)


async def _ocr_metrics(db: AsyncSession) -> dict:
    """AI/OCR performance metrics."""
    avg_confidence = (await db.execute(
        select(func.avg(Document.ocr_confidence_avg)).where(
            Document.ocr_confidence_avg.isnot(None)
        )
    )).scalar()

    high_conf = (await db.execute(
        select(func.count(Document.id)).where(Document.ocr_confidence_avg >= 0.85)
    )).scalar() or 0

    med_conf = (await db.execute(
        select(func.count(Document.id)).where(
            Document.ocr_confidence_avg >= 0.70,
            Document.ocr_confidence_avg < 0.85,
        )
    )).scalar() or 0

    low_conf = (await db.execute(
        select(func.count(Document.id)).where(
            Document.ocr_confidence_avg < 0.70,
            Document.ocr_confidence_avg.isnot(None),
        )
    )).scalar() or 0

    total_with_conf = high_conf + med_conf + low_conf

    return {
        "avg_confidence": round(float(avg_confidence or 0) * 100, 1),
        "high_confidence_count": high_conf,
        "medium_confidence_count": med_conf,
        "low_confidence_count": low_conf,
        "high_confidence_pct": round((high_conf / max(total_with_conf, 1)) * 100, 1),
        "touchless_rate": round((high_conf / max(total_with_conf, 1)) * 100, 1),
    }


async def _claims_metrics(db: AsyncSession, since: datetime) -> dict:
    """Claims processing metrics."""
    total = (await db.execute(select(func.count(Claim.id)))).scalar() or 0
    clean = (await db.execute(
        select(func.count(Claim.id)).where(Claim.adjudication_status == AdjudicationStatus.CLEAN)
    )).scalar() or 0
    rfi = (await db.execute(
        select(func.count(Claim.id)).where(Claim.adjudication_status == AdjudicationStatus.RFI)
    )).scalar() or 0
    submitted = (await db.execute(
        select(func.count(Claim.id)).where(Claim.adjudication_status == AdjudicationStatus.SUBMITTED)
    )).scalar() or 0
    paid = (await db.execute(
        select(func.count(Claim.id)).where(Claim.adjudication_status == AdjudicationStatus.PAID)
    )).scalar() or 0
    rejected = (await db.execute(
        select(func.count(Claim.id)).where(Claim.adjudication_status == AdjudicationStatus.REJECTED)
    )).scalar() or 0

    clean_rate = (clean / max(total, 1)) * 100
    rejection_rate = (rejected / max(total, 1)) * 100
    first_pass_rate = ((clean + paid + submitted) / max(total, 1)) * 100

    return {
        "total": total,
        "clean": clean,
        "rfi": rfi,
        "submitted": submitted,
        "paid": paid,
        "rejected": rejected,
        "clean_rate": round(clean_rate, 1),
        "rejection_rate": round(rejection_rate, 1),
        "first_pass_rate": round(first_pass_rate, 1),
    }


async def _submission_metrics(db: AsyncSession) -> dict:
    """EDI submission metrics."""
    total = (await db.execute(select(func.count(EDISubmission.id)))).scalar() or 0
    submitted = (await db.execute(
        select(func.count(EDISubmission.id)).where(
            EDISubmission.submission_status == SubmissionStatus.SUBMITTED)
    )).scalar() or 0
    accepted = (await db.execute(
        select(func.count(EDISubmission.id)).where(
            EDISubmission.submission_status == SubmissionStatus.ACCEPTED)
    )).scalar() or 0
    rejected = (await db.execute(
        select(func.count(EDISubmission.id)).where(
            EDISubmission.submission_status == SubmissionStatus.REJECTED)
    )).scalar() or 0

    return {
        "total": total,
        "submitted": submitted,
        "accepted": accepted,
        "rejected": rejected,
        "acceptance_rate": round((accepted / max(total, 1)) * 100, 1),
    }


async def _rfi_metrics(db: AsyncSession) -> dict:
    """RFI queue metrics."""
    total = (await db.execute(select(func.count(RFI.id)))).scalar() or 0
    open_count = (await db.execute(
        select(func.count(RFI.id)).where(RFI.rfi_status == RFIStatus.OPEN)
    )).scalar() or 0
    resolved = (await db.execute(
        select(func.count(RFI.id)).where(RFI.rfi_status == RFIStatus.RESOLVED)
    )).scalar() or 0

    return {
        "total": total,
        "open": open_count,
        "resolved": resolved,
        "resolution_rate": round((resolved / max(total, 1)) * 100, 1),
    }


async def _weekly_trends(db: AsyncSession, since: datetime) -> dict:
    """7-day trend data for charts."""
    # Documents per day
    doc_trend = []
    claim_trend = []

    for i in range(7):
        day_start = since + timedelta(days=i)
        day_end = day_start + timedelta(days=1)

        doc_count = (await db.execute(
            select(func.count(Document.id)).where(
                Document.created_at >= day_start,
                Document.created_at < day_end,
            )
        )).scalar() or 0

        claim_count = (await db.execute(
            select(func.count(Claim.id)).where(
                Claim.created_at >= day_start,
                Claim.created_at < day_end,
            )
        )).scalar() or 0

        doc_trend.append({"date": day_start.strftime("%Y-%m-%d"), "count": doc_count})
        claim_trend.append({"date": day_start.strftime("%Y-%m-%d"), "count": claim_count})

    return {
        "documents_per_day": doc_trend,
        "claims_per_day": claim_trend,
    }
