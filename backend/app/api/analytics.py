"""
Analytics & Payout API — Dashboard metrics, ERA management, and notifications.
"""
import uuid
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel
from typing import Optional

from app.database import get_db
from app.models.user import User
from app.models.era import ERA
from app.utils.security import get_current_user
from app.services.analytics import get_dashboard_analytics
from app.services.era_reconciliation import parse_era_response, auto_reconcile
from app.services.notifications import send_notification

router = APIRouter(prefix="/api", tags=["Analytics & Payout"])


# ── Schemas ────────────────────────────────────────

class ERAIngestRequest(BaseModel):
    claim_id: str
    era_data: dict


class ReconcileRequest(BaseModel):
    era_id: str
    tolerance_pct: float = 2.0


class NotificationRequest(BaseModel):
    to: str
    template_key: str
    channel: str = "sms"
    template_vars: dict = {}


# ═══════════════════════════════════════════════════════════
# ANALYTICS
# ═══════════════════════════════════════════════════════════

@router.get("/analytics/dashboard")
async def get_analytics(
    db: AsyncSession = Depends(get_db),
    _current: User = Depends(get_current_user),
):
    """
    Get comprehensive dashboard analytics.
    Returns pipeline health, financial metrics, OCR performance,
    claims status, submission rates, RFI queue, and 7-day trends.
    """
    return await get_dashboard_analytics(db)


# ═══════════════════════════════════════════════════════════
# ERA / PAYOUT TRACKING
# ═══════════════════════════════════════════════════════════

@router.post("/era/ingest")
async def ingest_era(
    body: ERAIngestRequest,
    db: AsyncSession = Depends(get_db),
    _current: User = Depends(get_current_user),
):
    """
    Ingest an Electronic Remittance Advice from a scheme.
    Parses payment details and creates an ERA record.
    """
    try:
        era = await parse_era_response(body.claim_id, body.era_data, db)
        return {
            "success": True,
            "era_id": str(era.id),
            "payment_status": era.payment_status.value,
            "amount_claimed": float(era.amount_claimed),
            "amount_paid": float(era.amount_paid),
            "variance": float(era.variance),
            "pay_rate": era.pay_rate,
        }
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/era/reconcile")
async def reconcile_era(
    body: ReconcileRequest,
    db: AsyncSession = Depends(get_db),
    _current: User = Depends(get_current_user),
):
    """
    Auto-reconcile an ERA against its claim.
    Uses configurable tolerance percentage for partial payment matching.
    """
    result = await auto_reconcile(body.era_id, db, body.tolerance_pct)
    return {
        "era_id": result.era_id,
        "claim_id": result.claim_id,
        "is_reconciled": result.is_reconciled,
        "variance": result.variance,
        "pay_rate": result.pay_rate,
        "discrepancies": result.discrepancies,
        "notes": result.notes,
    }


@router.get("/era/list")
async def list_eras(
    claim_id: Optional[str] = None,
    payment_status: Optional[str] = None,
    page: int = 1,
    page_size: int = 20,
    db: AsyncSession = Depends(get_db),
    _current: User = Depends(get_current_user),
):
    """List ERA records with optional filters."""
    from sqlalchemy import func
    from app.models.era import PaymentStatus as PS

    query = select(ERA).order_by(ERA.created_at.desc())

    if claim_id:
        query = query.where(ERA.claim_id == uuid.UUID(claim_id))
    if payment_status:
        query = query.where(ERA.payment_status == PS(payment_status))

    # Count
    count_q = select(func.count(ERA.id))
    if claim_id:
        count_q = count_q.where(ERA.claim_id == uuid.UUID(claim_id))
    total = (await db.execute(count_q)).scalar() or 0

    # Paginate
    query = query.offset((page - 1) * page_size).limit(page_size)
    result = await db.execute(query)
    eras = result.scalars().all()

    return {
        "total": total,
        "page": page,
        "eras": [
            {
                "id": str(e.id),
                "claim_id": str(e.claim_id),
                "era_status": e.era_status.value,
                "payment_status": e.payment_status.value,
                "amount_claimed": float(e.amount_claimed),
                "amount_approved": float(e.amount_approved),
                "amount_paid": float(e.amount_paid),
                "variance": float(e.variance),
                "pay_rate": e.pay_rate,
                "scheme_name": e.scheme_name,
                "payment_date": e.payment_date.isoformat() if e.payment_date else None,
                "auto_reconciled": e.auto_reconciled,
                "created_at": e.created_at.isoformat(),
            }
            for e in eras
        ],
    }


# ═══════════════════════════════════════════════════════════
# NOTIFICATIONS
# ═══════════════════════════════════════════════════════════

@router.post("/notifications/send")
async def send_notif(
    body: NotificationRequest,
    _current: User = Depends(get_current_user),
):
    """Send a notification via SMS or WhatsApp."""
    result = await send_notification(
        to=body.to,
        template_key=body.template_key,
        channel=body.channel,
        **body.template_vars,
    )
    return {
        "success": result.success,
        "channel": result.channel,
        "provider": result.provider,
        "recipient": result.recipient,
        "message_id": result.message_id,
        "error": result.error,
    }
