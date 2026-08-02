"""
Data-subject rights and tenant exit — POPIA s23, s24 and s14.

WHY THIS EXISTS
---------------
Three questions a scheme's officer always asks had no answer in code at all:

  * "A member phones us and asks what you hold on them." POPIA s23 gives a data
    subject the right to know. There was no way to answer except by hand-writing
    a database query, which is not a process and does not scale to a scheme with
    millions of members.
  * "How do we get our data back when this ends, and how do you prove you
    destroyed your copies?" s14(4) requires destruction once retention lapses,
    and a responsible party cannot delegate the proof. The only export in the
    codebase was an OCR spreadsheet.
  * "How long do you keep it?" Backup retention was precise; LIVE record
    retention was undefined and unenforced.

WHAT IS DELIBERATELY NOT HERE: an erase-on-request endpoint.
------------------------------------------------------------
POPIA s24 is a right to CORRECTION, not deletion, and health records carry a
statutory retention that overrides a subject's preference — a paramedic's
clinical record is evidence in a Council inquiry and in litigation, and the
patient cannot consent it away. Offering a delete button here would let a
well-meaning administrator destroy a record the provider is legally required to
keep. Correction goes through the existing amendment flow, which preserves the
original.

EVERY EXPORT IS A DISCLOSURE. Each route logs a TRANSMIT event before returning:
these produce more patient data in one response than any other endpoint, so if
anything in this system is going to be audited, it is this.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.case import Case
from app.models.claim import Claim
from app.models.digital_prf import DigitalPRF
from app.models.document import Document
from app.models.service_provider import ServiceProvider
from app.models.user import User, UserRole
from app.services.phi_audit import record_phi_access, ACTION_TRANSMIT
from app.utils.patient_id import id_hash, normalise_id
from app.utils.security import require_role

# Back-office ADMIN only. These routes assemble more patient data into a single
# response than anything else in the product.
router = APIRouter(
    prefix="/api/data-rights",
    tags=["Data Rights"],
    dependencies=[Depends(require_role(UserRole.ADMIN, UserRole.SUPER_ADMIN))],
)


def _case_payload(c: Case) -> dict:
    return {
        "case_id": str(c.id),
        "patient_name": c.patient_name,
        "patient_id_number": c.patient_id_number,   # decrypted by the column type
        "patient_dob": c.patient_dob.isoformat() if c.patient_dob else None,
        "medical_scheme": c.medical_scheme_name,
        "scheme_member_number": c.scheme_member_number,
        "incident_date": c.incident_date.isoformat() if c.incident_date else None,
        "incident_location": c.incident_location,
        "preauth_number": c.preauth_number,
        "preauth_status": c.preauth_status.value if c.preauth_status else None,
        "captured_at": c.created_at.isoformat() if c.created_at else None,
    }


def _prf_payload(p: DigitalPRF) -> dict:
    return {
        "prf_id": str(p.id),
        "prf_number": p.prf_number,
        "case_number": p.case_number,
        "status": p.status.value if p.status else None,
        "provider_id": str(p.provider_id) if p.provider_id else None,
        "submitted_at": p.submitted_at.isoformat() if p.submitted_at else None,
        "captured_at": p.created_at.isoformat() if p.created_at else None,
        "clinical_record": p.form_data or {},       # ID inside is decrypted too
        "signatures_present": {
            "patient": bool(p.patient_signature),
            "witness": bool(p.witness_signature),
            "handover": bool(p.handover_signature),
            "crew": bool(p.crew_signature),
            "valuables": bool(p.valuables_signature),
        },
    }


@router.get("/subject-access")
async def subject_access_request(
    request: Request,
    id_number: str = Query(..., description="The data subject's SA ID number"),
    db: AsyncSession = Depends(get_db),
    _current: User = Depends(require_role(UserRole.ADMIN, UserRole.SUPER_ADMIN)),
):
    """Everything held about one person — POPIA s23.

    Located by the KEYED HASH of the identifier, never by scanning: the ID is
    encrypted at rest, so an equality search on the hash is both the only way
    that still works and the fast one. Formatting is normalised first, because
    "900101 5800 083" and "9001015800083" are the same person and a lookup that
    missed on a space would tell a member we hold nothing about them.
    """
    digits = normalise_id(id_number)
    if len(digits) < 6:
        raise HTTPException(400, "Provide the full ID number.")

    hashed = id_hash(digits)
    cases = (await db.execute(
        select(Case).where(Case.patient_id_hash == hashed).order_by(Case.created_at.desc())
    )).scalars().all()
    prfs = (await db.execute(
        select(DigitalPRF).where(DigitalPRF.patient_id_hash == hashed)
        .order_by(DigitalPRF.created_at.desc())
    )).scalars().all()

    # Logged BEFORE the payload is returned, and as TRANSMIT rather than READ:
    # this hands over a person's complete history in one response.
    await record_phi_access(
        db, action=ACTION_TRANSMIT, entity_type="subject_access", entity_id=None,
        user=_current, request=request,
        details={"cases": len(cases), "prfs": len(prfs), "subject": hashed[:12]},
    )

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "subject_reference": hashed[:12],   # correlates without restating the ID
        "found": bool(cases or prfs),
        "cases": [_case_payload(c) for c in cases],
        "patient_report_forms": [_prf_payload(p) for p in prfs],
        "note": (
            "This is every record this platform holds for the identifier supplied. "
            "Clinical records are retained under the statutory retention period for "
            "health records and cannot be deleted on request; corrections are made "
            "through the amendment process, which preserves the original entry."
        ),
    }


@router.get("/provider/{provider_id}/export")
async def provider_data_export(
    provider_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    _current: User = Depends(require_role(UserRole.ADMIN, UserRole.SUPER_ADMIN)),
):
    """Return one tenant's data to them — the exit path.

    The EMS provider is the responsible party for the clinical records its crews
    create; this platform only ever held them as an operator. On termination
    those records must go back, in a form the provider can actually use, before
    anything is destroyed. Until now there was no such route, so "how do we get
    our data back?" had no answer.
    """
    try:
        pid = uuid.UUID(provider_id)
    except (ValueError, TypeError):
        raise HTTPException(400, "Invalid provider id")

    provider = (await db.execute(
        select(ServiceProvider).where(ServiceProvider.id == pid)
    )).scalar_one_or_none()
    if not provider:
        raise HTTPException(404, "Provider not found")

    prfs = (await db.execute(
        select(DigitalPRF).where(DigitalPRF.provider_id == pid)
        .order_by(DigitalPRF.prf_number.asc())
    )).scalars().all()

    case_ids = [p.case_id for p in prfs if p.case_id]
    cases = []
    if case_ids:
        cases = (await db.execute(
            select(Case).where(Case.id.in_(case_ids))
        )).scalars().all()

    await record_phi_access(
        db, action=ACTION_TRANSMIT, entity_type="provider_export", entity_id=pid,
        user=_current, request=request,
        details={"provider": provider.name, "prfs": len(prfs), "cases": len(cases)},
    )

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "provider": {"id": str(provider.id), "name": provider.name, "slug": provider.slug},
        "record_counts": {"patient_report_forms": len(prfs), "cases": len(cases)},
        "patient_report_forms": [_prf_payload(p) for p in prfs],
        "cases": [_case_payload(c) for c in cases],
    }


@router.get("/retention")
async def retention_status(
    db: AsyncSession = Depends(get_db),
    _current: User = Depends(require_role(UserRole.ADMIN, UserRole.SUPER_ADMIN)),
):
    """What is held, how long it may be held, and what is now destroyable.

    POPIA s14(4) requires records to be destroyed once the purpose has lapsed
    and no law requires them to be kept. Answering "how long do you keep this?"
    with a number is not enough — the officer wants to see the number ENFORCED.
    This reports against the policy; app/tasks/retention.py acts on it.
    """
    from app.tasks.retention import retention_report

    return await retention_report(db)
