"""
ERA Parsing & Auto-Reconciliation Service
Parses Electronic Remittance Advices from schemes and auto-reconciles against claims.
"""
from __future__ import annotations
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from dataclasses import dataclass, field
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.claim import Claim, AdjudicationStatus
from app.models.era import ERA, ERAStatus, PaymentStatus
from app.models.edi_submission import EDISubmission


@dataclass
class ReconciliationResult:
    """Result of ERA reconciliation against a claim."""
    era_id: str = ""
    claim_id: str = ""
    is_reconciled: bool = False
    variance: float = 0.0
    pay_rate: float = 0.0
    discrepancies: list[str] = field(default_factory=list)
    notes: str = ""


async def parse_era_response(
    claim_id: str,
    era_data: dict,
    db: AsyncSession,
) -> ERA:
    """
    Parse an incoming ERA response and create a record.
    
    Expected era_data format:
    {
        "scheme_name": "Discovery Health",
        "scheme_reference": "DISC-2024-123456",
        "payment_reference": "PAY-789",
        "payment_date": "2024-03-15",
        "amount_claimed": 5500.00,
        "amount_approved": 5200.00,
        "amount_paid": 5200.00,
        "patient_liability": 300.00,
        "line_details": [
            {"line": 1, "approved": 3000.00, "paid": 3000.00, "reason": null},
            {"line": 2, "approved": 2200.00, "paid": 2200.00, "reason": null},
        ],
        "rejection_codes": [],
        "adjustment_reasons": []
    }
    """
    # Find the claim
    claim_result = await db.execute(
        select(Claim).where(Claim.id == uuid.UUID(claim_id))
    )
    claim = claim_result.scalar_one_or_none()
    if not claim:
        raise ValueError(f"Claim {claim_id} not found")

    # Find associated EDI submission
    edi_result = await db.execute(
        select(EDISubmission)
        .where(EDISubmission.claim_id == claim.id)
        .order_by(EDISubmission.created_at.desc())
    )
    edi_sub = edi_result.scalar_one_or_none()

    # Parse payment date
    payment_date = None
    if era_data.get("payment_date"):
        try:
            payment_date = datetime.fromisoformat(era_data["payment_date"]).replace(tzinfo=timezone.utc)
        except (ValueError, TypeError):
            payment_date = datetime.now(timezone.utc)

    # Determine payment status
    amount_claimed = Decimal(str(era_data.get("amount_claimed", 0)))
    amount_paid = Decimal(str(era_data.get("amount_paid", 0)))

    if amount_paid <= 0:
        payment_status = PaymentStatus.REJECTED
    elif amount_paid >= amount_claimed:
        payment_status = PaymentStatus.PAID_FULL
    else:
        payment_status = PaymentStatus.PAID_PARTIAL

    # Create ERA record
    era = ERA(
        claim_id=claim.id,
        edi_submission_id=edi_sub.id if edi_sub else None,
        era_status=ERAStatus.PARSED,
        payment_status=payment_status,
        amount_claimed=amount_claimed,
        amount_approved=Decimal(str(era_data.get("amount_approved", 0))),
        amount_paid=amount_paid,
        patient_liability=Decimal(str(era_data.get("patient_liability", 0))),
        discount_amount=Decimal(str(era_data.get("discount_amount", 0))),
        scheme_name=era_data.get("scheme_name"),
        scheme_reference=era_data.get("scheme_reference"),
        payment_reference=era_data.get("payment_reference"),
        payment_date=payment_date,
        line_details=era_data.get("line_details"),
        rejection_codes=era_data.get("rejection_codes"),
        adjustment_reasons=era_data.get("adjustment_reasons"),
        raw_era_data=era_data,
    )
    db.add(era)
    await db.commit()
    await db.refresh(era)
    return era


async def auto_reconcile(
    era_id: str,
    db: AsyncSession,
    tolerance_pct: float = 2.0,
) -> ReconciliationResult:
    """
    Auto-reconcile an ERA against its parent claim.
    
    Rules:
    - FULL match: paid >= claimed → auto-reconcile
    - Within tolerance: variance ≤ tolerance_pct% → auto-reconcile with note
    - Discrepancy: variance > tolerance → flag for manual review
    """
    result = ReconciliationResult(era_id=era_id)

    era_result = await db.execute(select(ERA).where(ERA.id == uuid.UUID(era_id)))
    era = era_result.scalar_one_or_none()
    if not era:
        result.discrepancies.append("ERA record not found")
        return result

    result.claim_id = str(era.claim_id)
    result.variance = float(era.variance)
    result.pay_rate = era.pay_rate

    claim_result = await db.execute(select(Claim).where(Claim.id == era.claim_id))
    claim = claim_result.scalar_one_or_none()

    # ── Reconciliation Logic ──
    variance_pct = abs(result.variance) / max(float(era.amount_claimed), 1) * 100

    if era.payment_status == PaymentStatus.PAID_FULL:
        # Full payment — auto-reconcile
        era.era_status = ERAStatus.RECONCILED
        era.auto_reconciled = True
        era.reconciliation_notes = f"Full payment received. R{era.amount_paid:.2f} / R{era.amount_claimed:.2f}"
        result.is_reconciled = True
        result.notes = "Full payment — auto-reconciled"

        if claim:
            claim.adjudication_status = AdjudicationStatus.PAID

    elif era.payment_status == PaymentStatus.PAID_PARTIAL and variance_pct <= tolerance_pct:
        # Within tolerance — auto-reconcile with note
        era.era_status = ERAStatus.RECONCILED
        era.auto_reconciled = True
        era.reconciliation_notes = (
            f"Partial payment within {tolerance_pct}% tolerance. "
            f"Variance: R{abs(result.variance):.2f} ({variance_pct:.1f}%)"
        )
        result.is_reconciled = True
        result.notes = f"Within tolerance ({variance_pct:.1f}%) — auto-reconciled"

        if claim:
            claim.adjudication_status = AdjudicationStatus.PAID

    elif era.payment_status == PaymentStatus.REJECTED:
        # Full rejection
        era.era_status = ERAStatus.DISCREPANCY
        era.reconciliation_notes = "Claim rejected by scheme"
        result.discrepancies.append("Payment rejected by scheme")
        result.notes = "Rejected — requires manual intervention"

        # Check rejection codes
        if era.rejection_codes:
            for code in era.rejection_codes:
                result.discrepancies.append(f"Rejection: {code}")

    else:
        # Variance exceeds tolerance — flag
        era.era_status = ERAStatus.DISCREPANCY
        era.reconciliation_notes = (
            f"Variance exceeds {tolerance_pct}% tolerance. "
            f"Claimed: R{era.amount_claimed:.2f}, "
            f"Paid: R{era.amount_paid:.2f}, "
            f"Variance: R{abs(result.variance):.2f} ({variance_pct:.1f}%)"
        )
        result.discrepancies.append(
            f"Payment variance: R{abs(result.variance):.2f} ({variance_pct:.1f}%)"
        )
        result.notes = f"Variance {variance_pct:.1f}% — manual review required"

        # Check line-level discrepancies
        if era.line_details:
            for line in era.line_details:
                if line.get("reason"):
                    result.discrepancies.append(
                        f"Line {line.get('line', '?')}: {line['reason']}"
                    )

    await db.commit()
    return result
