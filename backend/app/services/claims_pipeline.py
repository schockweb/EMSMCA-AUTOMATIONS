"""
Claims Pipeline Service — Converts reviewed PRF documents into Case → Claim → ClaimLines.
This is the bridge between the OCR/HITL review stage and the adjudication engine.
"""
import uuid
from datetime import date, datetime, timezone
from typing import Optional
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.case import Case
from app.models.claim import Claim, AdjudicationStatus
from app.models.claim_line import ClaimLine
from app.models.document import Document
from app.models.enums import normalise_call_type
from sqlalchemy import select, delete


async def create_claim_from_document(
    doc: Document,
    db: AsyncSession,
) -> dict:
    """
    Takes a reviewed Document with extracted_data and creates:
    1. A Case (patient demographics + scheme info)
    2. A Claim (financial wrapper)
    3. ClaimLine entries — generated via the Tariff Engine using scheme guidelines
    4. Links the Document to the Case

    Returns a summary dict with the created IDs.
    """
    data = doc.extracted_data or {}

    # ── Normalise call type once — used by both Case and Tariff Engine ──
    canonical_call_type = normalise_call_type(
        data.get("incident_type") or data.get("dispatch_type") or ""
    )
    # Write back so every downstream service (tariff engine, adjudication) sees
    # the canonical value without needing to normalise again.
    if canonical_call_type:
        data["incident_type"] = canonical_call_type

    # ── 1. Create Case from extracted patient data ──
    case = Case(
        patient_name=_extract_patient_name(data),
        patient_id_number=data.get("patient_id_number") or data.get("id_number"),
        patient_dob=_parse_date(data.get("patient_dob") or data.get("date_of_birth")),
        medical_scheme_name=data.get("medical_scheme") or data.get("scheme_name"),
        scheme_member_number=data.get("member_number") or data.get("scheme_number"),
        incident_date=_parse_date(data.get("incident_date")),
        incident_location=data.get("incident_location"),
        preauth_number=data.get("preauth_number") or data.get("authorization_number"),
        dispatch_type=canonical_call_type or None,  # ← synced from PRF JSON
    )
    db.add(case)
    await db.flush()  # Get case.id without committing

    # ── 2. Link document to case ──
    doc.case_id = case.id

    # ── 3. Create Claim ──
    scheme_name = data.get("medical_scheme") or data.get("scheme_name") or ""
    claim = Claim(
        case_id=case.id,
        total_amount=0,
        target_scheme=scheme_name,
        adjudication_status=AdjudicationStatus.PENDING,
    )
    db.add(claim)
    await db.flush()  # Get claim.id

    # ── 4. Generate ClaimLines via Tariff Engine ──
    claim_lines_created = []
    tariff_result = None

    try:
        from app.services.tariff_engine import generate_tariff_lines
        tariff_result = await generate_tariff_lines(data, scheme_name, db)
        ai_lines = tariff_result.get("lines", [])

        for idx, item in enumerate(ai_lines, start=1):
            line = ClaimLine(
                claim_id=claim.id,
                line_number=idx,
                cpt_code=item.get("cpt_code"),
                nappi_code=item.get("nappi_code"),
                icd10_primary=item.get("icd10_primary"),
                icd10_secondary=item.get("icd10_secondary"),
                description=item.get("description"),
                modifier=item.get("modifier"),
                quantity=_parse_int(item.get("quantity"), 1),
                unit_price=_parse_float(item.get("unit_price"), 0.0),
                total_price=_parse_float(item.get("total_price"), 0.0),
            )
            db.add(line)
            claim_lines_created.append({
                "line_number": idx,
                "cpt_code": line.cpt_code,
                "icd10": line.icd10_primary,
                "description": line.description,
                "amount": float(line.total_price),
            })

        # Update claim total from generated lines
        claim.total_amount = tariff_result.get("total_amount", 0.0)

    except Exception as te:
        import logging
        logging.getLogger("ems.claims_pipeline").error("Tariff engine failed: %s", te)
        # Fallback to legacy extraction if tariff engine fails
        claim_lines_created, total = _legacy_extract_lines(data, claim.id, db)
        claim.total_amount = total

    # ── 5. Also try legacy line_items from OCR (if tariff engine produced nothing) ──
    if not claim_lines_created:
        claim_lines_created, total = _legacy_extract_lines(data, claim.id, db)
        if total > 0:
            claim.total_amount = total

    await db.commit()

    result = {
        "case_id": str(case.id),
        "claim_id": str(claim.id),
        "patient_name": case.patient_name,
        "scheme": case.medical_scheme_name,
        "total_amount": float(claim.total_amount),
        "claim_lines": claim_lines_created,
    }
    if tariff_result:
        result["tariff_engine"] = {
            "scheme_matched": tariff_result.get("scheme_matched"),
            "rules_used": tariff_result.get("rules_used", 0),
            "ai_powered": tariff_result.get("ai_powered", False),
        }
        if tariff_result.get("error"):
            result["tariff_engine"]["warning"] = tariff_result["error"]
    return result


def _legacy_extract_lines(data: dict, claim_id, db) -> tuple[list, float]:
    """Legacy: extract line items from OCR-structured data (fallback)."""
    line_items = data.get("line_items", [])
    icd10_codes = data.get("icd10_codes", [])
    primary_icd10 = icd10_codes[0] if icd10_codes else None
    secondary_icd10 = icd10_codes[1] if len(icd10_codes) > 1 else None
    total_amount = _extract_total_amount(data)

    claim_lines_created = []

    if line_items and isinstance(line_items, list):
        for idx, item in enumerate(line_items, start=1):
            if not isinstance(item, dict):
                continue
            line = ClaimLine(
                claim_id=claim_id,
                line_number=idx,
                cpt_code=item.get("tariff_code") or item.get("cpt_code"),
                nappi_code=item.get("nappi_code"),
                icd10_primary=item.get("icd10_code") or primary_icd10,
                icd10_secondary=secondary_icd10,
                description=item.get("description"),
                quantity=_parse_int(item.get("quantity"), 1),
                unit_price=_parse_float(item.get("unit_price") or item.get("amount"), 0.0),
                total_price=_parse_float(item.get("total_price") or item.get("amount"), 0.0),
            )
            db.add(line)
            claim_lines_created.append({
                "line_number": idx,
                "cpt_code": line.cpt_code,
                "icd10": line.icd10_primary,
                "amount": float(line.total_price),
            })
    elif primary_icd10:
        line = ClaimLine(
            claim_id=claim_id,
            line_number=1,
            icd10_primary=primary_icd10,
            icd10_secondary=secondary_icd10,
            description="EMS Transport — extracted from PRF",
            quantity=1,
            unit_price=float(total_amount),
            total_price=float(total_amount),
        )
        db.add(line)
        claim_lines_created.append({
            "line_number": 1,
            "icd10": primary_icd10,
            "amount": float(total_amount),
        })

    return claim_lines_created, total_amount


async def update_claim_from_document(
    doc: Document,
    db: AsyncSession,
) -> dict:
    """Updates an existing Case and Claim from modified document data, syncing lines."""
    data = doc.extracted_data or {}
    
    # 1. Update Case
    case_result = await db.execute(select(Case).where(Case.id == doc.case_id))
    case = case_result.scalar_one_or_none()
    if not case:
        raise ValueError(f"Linked case {doc.case_id} not found.")

    case.patient_name = _extract_patient_name(data)
    case.patient_id_number = data.get("patient_id_number") or data.get("id_number")
    case.patient_dob = _parse_date(data.get("patient_dob") or data.get("date_of_birth"))
    case.medical_scheme_name = data.get("medical_scheme") or data.get("scheme_name")
    case.scheme_member_number = data.get("member_number") or data.get("scheme_number")
    case.incident_date = _parse_date(data.get("incident_date"))
    case.incident_location = data.get("incident_location")
    case.preauth_number = data.get("preauth_number") or data.get("authorization_number")

    # 2. Update Claim
    claim_result = await db.execute(select(Claim).where(Claim.case_id == case.id).limit(1))
    claim = claim_result.scalar_one_or_none()
    if not claim:
        raise ValueError(f"Linked claim not found for case {case.id}.")

    scheme_name = data.get("medical_scheme") or data.get("scheme_name") or ""
    claim.target_scheme = scheme_name
    claim.adjudication_status = AdjudicationStatus.PENDING

    # 3. Wipe old claim lines
    await db.execute(delete(ClaimLine).where(ClaimLine.claim_id == claim.id))
    
    # 4. Wipe old RFIs (since we are fully re-verifying and re-adjudicating)
    from app.models.rfi import RFI
    await db.execute(delete(RFI).where(RFI.claim_id == claim.id))

    await db.flush()

    # 5. Re-generate ClaimLines via Tariff Engine
    claim_lines_created = []
    tariff_result = None

    try:
        from app.services.tariff_engine import generate_tariff_lines
        tariff_result = await generate_tariff_lines(data, scheme_name, db)
        ai_lines = tariff_result.get("lines", [])

        for idx, item in enumerate(ai_lines, start=1):
            line = ClaimLine(
                claim_id=claim.id,
                line_number=idx,
                cpt_code=item.get("cpt_code"),
                nappi_code=item.get("nappi_code"),
                icd10_primary=item.get("icd10_primary"),
                icd10_secondary=item.get("icd10_secondary"),
                description=item.get("description"),
                modifier=item.get("modifier"),
                quantity=_parse_int(item.get("quantity"), 1),
                unit_price=_parse_float(item.get("unit_price"), 0.0),
                total_price=_parse_float(item.get("total_price"), 0.0),
            )
            db.add(line)
            claim_lines_created.append({"line_number": idx})

        claim.total_amount = tariff_result.get("total_amount", 0.0)

    except Exception as te:
        import logging
        logging.getLogger("ems.claims_pipeline").error("Tariff engine failed on update: %s", te)
        claim_lines_created, total = _legacy_extract_lines(data, claim.id, db)
        claim.total_amount = total

    # Fallback
    if not claim_lines_created:
        claim_lines_created, total = _legacy_extract_lines(data, claim.id, db)
        if total > 0:
            claim.total_amount = total

    await db.commit()

    return {
        "case_id": str(case.id),
        "claim_id": str(claim.id),
        "patient_name": case.patient_name,
        "scheme": case.medical_scheme_name,
        "total_amount": float(claim.total_amount),
        "claim_lines": claim_lines_created,
    }


# ── Helper functions ──────────────────────────────────────

def _extract_patient_name(data: dict) -> str:
    """Extract patient name from various possible field names."""
    for key in ("patient_name", "name", "full_name", "patient_full_name"):
        if data.get(key):
            return str(data[key])
    return "Unknown Patient"


def _extract_total_amount(data: dict) -> float:
    """Extract total amount from various possible field names."""
    for key in ("total_amount", "total", "amount", "claim_amount"):
        val = data.get(key)
        if val is not None:
            try:
                return float(val)
            except (ValueError, TypeError):
                continue

    # Try summing line items
    line_items = data.get("line_items", [])
    if isinstance(line_items, list):
        total = 0.0
        for item in line_items:
            if isinstance(item, dict):
                amt = item.get("amount") or item.get("total_price") or item.get("unit_price", 0)
                try:
                    total += float(amt)
                except (ValueError, TypeError):
                    pass
        if total > 0:
            return total

    return 0.0


def _parse_date(value) -> Optional[date]:
    """Parse a date string into a date object, tolerating multiple formats."""
    if not value:
        return None
    if isinstance(value, date):
        return value

    # Try common formats
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y", "%Y/%m/%d", "%d %B %Y", "%d %b %Y"):
        try:
            return datetime.strptime(str(value), fmt).date()
        except ValueError:
            continue
    return None

def _parse_int(value, default=1) -> int:
    try:
        if value is None or str(value).strip() == "":
            return default
        return int(float(value))
    except (ValueError, TypeError):
        return default

def _parse_float(value, default=0.0) -> float:
    try:
        if value is None or str(value).strip() == "":
            return default
        # Strip common currency symbols mapping if necessary, or just standard cast
        clean = str(value).replace("R", "").replace("ZAR", "").replace(",", "").strip()
        return float(clean)
    except (ValueError, TypeError):
        return default

