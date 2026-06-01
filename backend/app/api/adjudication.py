"""
Adjudication API — Clinical scrubbing endpoints.
"""
from __future__ import annotations
import uuid
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.user import User
from app.models.case import Case
from app.models.document import Document
from app.models.claim import Claim
from app.models.rfi import RFI, RFIStatus
from app.utils.security import get_current_user
from app.services.adjudication_engine import adjudicate_claim
from app.services.bhf_verification import verify_provider_pcns
from app.services.pmb_routing import detect_pmb_from_icd10, detect_pmb_from_narrative
from app.services.icd10_cpt_crosswalk import (
    validate_icd10_code,
    validate_cpt_code,
    validate_nappi_code,
    cross_walk_icd10_cpt,
)

from pydantic import BaseModel
from typing import Optional

router = APIRouter(prefix="/api/adjudication", tags=["Adjudication"])


# ── Schemas ────────────────────────────────────────────

class AdjudicateRequest(BaseModel):
    claim_id: Optional[str] = None
    case_id: Optional[str] = None
    auto_generate_rfis: bool = True


class AdjudicationResponse(BaseModel):
    claim_id: str
    status: str
    is_clean: bool
    is_pmb: bool
    pmb_details: Optional[dict] = None
    total_checks: int
    passed_checks: int
    failed_checks: int
    warning_count: int
    pass_rate: float
    checks: list[dict]
    rfis_generated: list[dict]
    modifiers_applied: list[str]


class BHFVerifyRequest(BaseModel):
    pcns: str


class ICD10ValidateRequest(BaseModel):
    icd10_code: str
    cpt_code: Optional[str] = None


class PMBCheckRequest(BaseModel):
    primary_icd10: str
    secondary_icd10: Optional[str] = None
    clinical_notes: Optional[str] = None


class RFIResponse(BaseModel):
    id: str
    claim_id: str
    document_id: str
    rfi_status: str
    priority: str
    reason_code: str
    reason_description: str
    missing_fields: Optional[dict] = None
    created_at: str

    class Config:
        from_attributes = True


class RFIResolveRequest(BaseModel):
    response_data: dict


# ── Endpoints ──────────────────────────────────────────

@router.post("/scrub", response_model=AdjudicationResponse)
async def scrub_claim(
    body: AdjudicateRequest,
    db: AsyncSession = Depends(get_db),
    _current: User = Depends(get_current_user),
):
    """
    Run the full clinical adjudication matrix on a claim.
    Validates all data, detects PMB conditions, generates RFIs for failures.
    """
    claim_id = body.claim_id
    if not claim_id and body.case_id:
        c_result = await db.execute(select(Claim.id).where(Claim.case_id == uuid.UUID(body.case_id)))
        claim_id_obj = c_result.scalar_one_or_none()
        if not claim_id_obj:
            raise HTTPException(status_code=404, detail="Claim not found for this case")
        claim_id = str(claim_id_obj)
    
    if not claim_id:
        raise HTTPException(status_code=400, detail="Must provide either claim_id or case_id")

    result = await adjudicate_claim(
        claim_id=claim_id,
        db=db,
        auto_generate_rfis=body.auto_generate_rfis,
    )

    return AdjudicationResponse(
        claim_id=result.claim_id,
        status=result.status,
        is_clean=result.is_clean,
        is_pmb=result.is_pmb,
        pmb_details=result.pmb_details,
        total_checks=result.total_checks,
        passed_checks=result.passed_checks,
        failed_checks=result.failed_checks,
        warning_count=result.warning_count,
        pass_rate=result.pass_rate,
        checks=[
            {
                "check_name": c.check_name,
                "passed": c.passed,
                "severity": c.severity,
                "message": c.message,
            }
            for c in result.checks
        ],
        rfis_generated=result.rfis_generated,
        modifiers_applied=result.modifiers_applied,
    )


@router.post("/recalculate")
async def recalculate_tariff(
    body: AdjudicateRequest,
    db: AsyncSession = Depends(get_db),
    _current: User = Depends(get_current_user),
):
    """
    Re-run the tariff engine for a case / claim and replace all claim lines
    with the freshly calculated values.  Then immediately re-adjudicate so
    the Pro-Forma Invoice on screen reflects the correct prices.

    This is what the "Recalculate" button in the Pro-Forma Invoice modal
    should call instead of /scrub.
    """
    import logging
    from sqlalchemy import delete
    from app.models.claim import Claim
    from app.models.claim_line import ClaimLine
    from app.models.document import Document

    log = logging.getLogger("ems.recalculate")

    # ── 1. Resolve claim_id ──────────────────────────────────────────────
    claim_id = body.claim_id
    if not claim_id and body.case_id:
        c_result = await db.execute(
            select(Claim.id).where(Claim.case_id == uuid.UUID(body.case_id))
        )
        claim_id_obj = c_result.scalar_one_or_none()
        if not claim_id_obj:
            raise HTTPException(status_code=404, detail="Claim not found for this case")
        claim_id = str(claim_id_obj)

    if not claim_id:
        raise HTTPException(status_code=400, detail="Must provide either claim_id or case_id")

    # ── 2. Load claim and its case ───────────────────────────────────────
    claim_result = await db.execute(
        select(Claim).where(Claim.id == uuid.UUID(claim_id))
    )
    claim = claim_result.scalar_one_or_none()
    if not claim:
        raise HTTPException(status_code=404, detail=f"Claim {claim_id} not found")

    case_result = await db.execute(
        select(Case).where(Case.id == claim.case_id)
    )
    case = case_result.scalar_one_or_none()
    if not case:
        raise HTTPException(status_code=404, detail="Case not found")

    # ── 3. Load the document's extracted data ────────────────────────────
    doc_result = await db.execute(
        select(Document)
        .where(Document.case_id == case.id)
        .order_by(Document.created_at.desc())
    )
    doc = doc_result.scalars().first()
    if not doc or not doc.extracted_data:
        raise HTTPException(
            status_code=422,
            detail="No extracted document data found — cannot re-run tariff engine"
        )

    extracted = doc.extracted_data
    scheme_name = (
        case.medical_scheme_name
        or extracted.get("medical_scheme")
        or extracted.get("scheme_name")
        or ""
    )

    log.info("[Recalculate] case=%s claim=%s scheme=%s", case.id, claim_id, scheme_name)

    # ── 4. Re-run the tariff engine ──────────────────────────────────────
    from app.services.tariff_engine import generate_tariff_lines

    try:
        tariff_result = await generate_tariff_lines(extracted, scheme_name, db)
    except Exception as e:
        log.exception("[Recalculate] Tariff engine raised an exception")
        raise HTTPException(status_code=500, detail=f"Tariff engine error: {e}")

    new_lines = tariff_result.get("lines", [])
    new_total  = tariff_result.get("total_amount", 0.0)

    log.info("[Recalculate] Tariff engine returned %d lines, total=R%.2f", len(new_lines), new_total)

    if tariff_result.get("error"):
        raise HTTPException(status_code=422, detail=tariff_result["error"])

    # ── 5. Delete old claim lines and write fresh ones ───────────────────
    await db.execute(
        delete(ClaimLine).where(ClaimLine.claim_id == uuid.UUID(claim_id))
    )

    def _f(v, default=0.0):
        try:
            return float(v) if v is not None else default
        except (TypeError, ValueError):
            return default

    def _i(v, default=1):
        try:
            return int(v) if v is not None else default
        except (TypeError, ValueError):
            return default

    for idx, item in enumerate(new_lines, start=1):
        db.add(ClaimLine(
            claim_id=uuid.UUID(claim_id),
            line_number=idx,
            cpt_code=item.get("cpt_code"),
            nappi_code=item.get("nappi_code"),
            icd10_primary=item.get("icd10_primary"),
            icd10_secondary=item.get("icd10_secondary"),
            description=item.get("description"),
            modifier=item.get("modifier"),
            quantity=_i(item.get("quantity"), 1),
            unit_price=_f(item.get("unit_price"), 0.0),
            total_price=_f(item.get("total_price"), 0.0),
        ))

    claim.total_amount = new_total
    await db.commit()

    # ── 6. Re-adjudicate now that lines are correct ──────────────────────
    adj_result = await adjudicate_claim(
        claim_id=claim_id,
        db=db,
        auto_generate_rfis=body.auto_generate_rfis,
    )

    log.info("[Recalculate] Adjudication: %s (%d checks)", adj_result.status, adj_result.total_checks)

    return AdjudicationResponse(
        claim_id=adj_result.claim_id,
        status=adj_result.status,
        is_clean=adj_result.is_clean,
        is_pmb=adj_result.is_pmb,
        pmb_details=adj_result.pmb_details,
        total_checks=adj_result.total_checks,
        passed_checks=adj_result.passed_checks,
        failed_checks=adj_result.failed_checks,
        warning_count=adj_result.warning_count,
        pass_rate=adj_result.pass_rate,
        checks=[
            {
                "check_name": c.check_name,
                "passed": c.passed,
                "severity": c.severity,
                "message": c.message,
            }
            for c in adj_result.checks
        ],
        rfis_generated=adj_result.rfis_generated,
        modifiers_applied=adj_result.modifiers_applied,
    )




@router.post("/verify-provider")
async def verify_provider(
    body: BHFVerifyRequest,
    _current: User = Depends(get_current_user),
):
    """Verify a provider's BHF PCNS number."""
    result = await verify_provider_pcns(body.pcns)
    return {
        "pcns": result.provider_pcns,
        "is_valid": result.is_valid,
        "provider_name": result.provider_name,
        "practice_status": result.practice_status,
        "discipline": result.discipline,
        "checks_passed": result.checks_passed,
        "checks_failed": result.checks_failed,
        "error": result.error,
    }

_AI_ICD10_CACHE = {}

@router.post("/validate-codes")
async def validate_codes(
    body: ICD10ValidateRequest,
    _current: User = Depends(get_current_user),
):
    icd_result = validate_icd10_code(body.icd10_code)
    
    if icd_result.get("description") == "Unlisted ICD-10 code":
        if body.icd10_code in _AI_ICD10_CACHE:
            icd_result.update(_AI_ICD10_CACHE[body.icd10_code])
        else:
            try:
                from openai import AsyncAzureOpenAI
                from app.config import get_settings
                import json
                
                settings = get_settings()
                
                if settings.AZURE_OPENAI_ENDPOINT:
                    llm_client = AsyncAzureOpenAI(
                        api_key=settings.AZURE_OPENAI_API_KEY,
                        api_version="2024-02-15-preview",
                        azure_endpoint=settings.AZURE_OPENAI_ENDPOINT,
                    )
                    
                    resp = await llm_client.chat.completions.create(
                        model=settings.AZURE_OPENAI_DEPLOYMENT,
                        messages=[
                            {"role": "system", "content": "You are a medical coding dictionary. Return ONLY a pure JSON object mapping the provided ICD-10 code to its official short description and overall bodily category. e.g. {\"description\": \"Weakness\", \"category\": \"Symptoms and signs\"}"},
                            {"role": "user", "content": f"What is the ICD-10 description for code: {body.icd10_code}?"}
                        ],
                        temperature=0.1
                    )
                    raw = resp.choices[0].message.content.strip()
                    if raw.startswith("```"):
                        raw = raw.split("\n", 1)[-1]
                        if raw.endswith("```"):
                            raw = raw[:-3]
                        raw = raw.strip()
                    
                    ai_data = json.loads(raw)
                    if ai_data.get("description"):
                        icd_result["description"] = ai_data["description"]
                        icd_result["category"] = ai_data.get("category", "unknown")
                        
                        # Save to memory cache so we never pay for this specific code again
                        _AI_ICD10_CACHE[body.icd10_code] = {
                            "description": ai_data["description"],
                            "category": ai_data.get("category", "unknown")
                        }
            except Exception as __e:
                import traceback
                traceback.print_exc()
                try:
                    print('FALLBACK ERROR:', repr(__e))
                except:
                    pass

    response = {"icd10": icd_result}

    if body.cpt_code:
        cpt_result = validate_cpt_code(body.cpt_code)
        xwalk = cross_walk_icd10_cpt(body.icd10_code, body.cpt_code)
        response["cpt"] = cpt_result
        response["cross_walk"] = {
            "is_valid": xwalk.is_valid,
            "is_pmb": xwalk.is_pmb,
            "pmb_category": xwalk.pmb_category,
            "warnings": xwalk.warnings,
            "errors": xwalk.errors,
            "suggested_codes": xwalk.suggested_codes,
        }

    return response


@router.get("/search-codes")
async def search_codes(
    q: str,
    _current: User = Depends(get_current_user),
):
    """Search for ICD-10 codes by text or code prefix."""
    from app.services.icd10_cpt_crosswalk import ICD10_REGISTRY
    
    query = q.lower().strip()
    results = []
    
    for code, info in ICD10_REGISTRY.items():
        if query in code.lower() or query in info["desc"].lower():
            results.append({
                "code": code,
                "description": info["desc"],
                "category": info["category"],
                "is_pmb": info["pmb"]
            })
            
    # Sort so exact matches or starting matches are first
    results.sort(key=lambda x: (
        not x["code"].lower().startswith(query),
        not x["description"].lower().startswith(query)
    ))
    
    return {"results": results[:15]}


class SuggestICD10Request(BaseModel):
    clinical_notes: str
    mechanism_of_injury: Optional[str] = None
    chief_complaint: Optional[str] = None
    working_diagnosis: Optional[str] = None


@router.post("/suggest-icd10")
async def suggest_icd10_from_notes(
    body: SuggestICD10Request,
    _current: User = Depends(get_current_user),
):
    """
    Use Azure OpenAI to analyze clinical notes and suggest appropriate ICD-10 codes.
    Returns up to 5 suggested codes with descriptions and confidence levels.
    """
    import json
    import logging
    from app.config import get_settings

    logger = logging.getLogger("ems.icd10_suggest")
    settings = get_settings()

    if not settings.AZURE_OPENAI_ENDPOINT or not settings.AZURE_OPENAI_API_KEY:
        raise HTTPException(status_code=503, detail="Azure OpenAI not configured")

    clinical_context = body.clinical_notes or ""
    if body.mechanism_of_injury:
        clinical_context += f"\nMechanism of Injury: {body.mechanism_of_injury}"
    if body.chief_complaint:
        clinical_context += f"\nChief Complaint: {body.chief_complaint}"
    if body.working_diagnosis:
        clinical_context += f"\nWorking Diagnosis: {body.working_diagnosis}"

    if len(clinical_context.strip()) < 5:
        raise HTTPException(status_code=422, detail="Clinical notes too short to analyze")

    system_prompt = """You are a South African EMS clinical coding specialist.
Given clinical notes from a Patient Report Form (PRF), identify the most appropriate ICD-10 diagnosis codes.

RULES:
- Return between 1 and 5 codes, ranked by clinical relevance.
- Use standard ICD-10 codes (e.g. I21.0, S06.0, J45, T14).
- For each code provide: code, description, and confidence (high/medium/low).
- Focus on the PRIMARY diagnosis first, then secondary/contributing conditions.
- For trauma cases, include both the injury code AND the external cause code if identifiable.
- Prefer specific sub-codes (e.g. I21.0) over generic parent codes (e.g. I21) when the notes support specificity.

Return ONLY a valid JSON array, no markdown, no explanation:
[{"code": "I21.0", "description": "Acute transmural MI of anterior wall", "confidence": "high"}]"""

    try:
        from openai import AsyncAzureOpenAI

        client = AsyncAzureOpenAI(
            api_key=settings.AZURE_OPENAI_API_KEY,
            api_version="2024-02-15-preview",
            azure_endpoint=settings.AZURE_OPENAI_ENDPOINT,
        )

        response = await client.chat.completions.create(
            model=settings.AZURE_OPENAI_DEPLOYMENT,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": f"Clinical Notes:\n{clinical_context}"},
            ],
            temperature=0.1,
            max_tokens=600,
        )

        raw = response.choices[0].message.content.strip()
        # Strip markdown fences if present
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1] if "\n" in raw else raw[3:]
            if raw.endswith("```"):
                raw = raw[:-3]
            raw = raw.strip()

        suggestions = json.loads(raw)

        # Cross-reference with our local registry to enrich with PMB status
        from app.services.icd10_cpt_crosswalk import ICD10_REGISTRY
        for s in suggestions:
            code = s.get("code", "").strip().upper()
            s["is_pmb"] = False
            s["category"] = "unknown"
            for reg_code, reg_info in ICD10_REGISTRY.items():
                reg_clean = reg_code.replace(".", "")
                code_clean = code.replace(".", "")
                if code_clean == reg_clean or code_clean.startswith(reg_clean):
                    s["is_pmb"] = reg_info["pmb"]
                    s["category"] = reg_info["category"]
                    break

        return {"suggestions": suggestions}

    except json.JSONDecodeError:
        logger.warning(f"[ICD10 Suggest] Failed to parse AI response: {raw[:200]}")
        raise HTTPException(status_code=500, detail="AI returned invalid format")
    except Exception as e:
        logger.exception("[ICD10 Suggest] AI call failed")
        raise HTTPException(status_code=500, detail=f"AI suggestion failed: {str(e)}")



@router.post("/check-pmb")
async def check_pmb(
    body: PMBCheckRequest,
    _current: User = Depends(get_current_user),
):
    """Check if a condition qualifies for PMB coverage."""
    icd_result = detect_pmb_from_icd10(body.primary_icd10, body.secondary_icd10)

    narrative_result = None
    if body.clinical_notes:
        narrative_result = detect_pmb_from_narrative(body.clinical_notes)

    return {
        "icd10_check": {
            "is_pmb": icd_result.is_pmb,
            "pmb_type": icd_result.pmb_type,
            "condition": icd_result.pmb_condition,
            "modifier": icd_result.modifier_to_append,
            "legal_mandate": icd_result.legal_mandate,
            "routing_notes": icd_result.routing_notes,
        },
        "narrative_check": {
            "is_pmb": narrative_result.is_pmb if narrative_result else False,
            "condition": narrative_result.pmb_condition if narrative_result else None,
            "routing_notes": narrative_result.routing_notes if narrative_result else [],
        } if body.clinical_notes else None,
    }


# ── RFI Management ────────────────────────────────────

@router.get("/rfis", response_model=list[RFIResponse])
async def list_rfis(
    claim_id: Optional[str] = None,
    status_filter: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    _current: User = Depends(get_current_user),
):
    """List all RFIs, optionally filtered by claim or status."""
    query = (
        select(RFI, Document.id)
        .join(Claim, RFI.claim_id == Claim.id)
        .join(Case, Claim.case_id == Case.id)
        .outerjoin(Document, Case.id == Document.case_id)
        .order_by(RFI.created_at.desc())
    )

    if claim_id:
        query = query.where(RFI.claim_id == uuid.UUID(claim_id))
    if status_filter:
        query = query.where(RFI.rfi_status == RFIStatus(status_filter))

    result = await db.execute(query)
    rows = result.all()

    return [
        RFIResponse(
            id=str(r.id),
            claim_id=str(r.claim_id),
            document_id=str(doc_id),
            rfi_status=r.rfi_status.value,
            priority=r.priority.value,
            reason_code=r.reason_code,
            reason_description=r.reason_description,
            missing_fields=r.missing_fields,
            created_at=r.created_at.isoformat(),
        )
        for r, doc_id in rows
    ]


@router.post("/rfis/{rfi_id}/resolve")
async def resolve_rfi(
    rfi_id: str,
    body: RFIResolveRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Resolve an RFI by providing the missing data, then re-adjudicate the claim."""
    result = await db.execute(select(RFI).where(RFI.id == uuid.UUID(rfi_id)))
    rfi = result.scalar_one_or_none()
    if not rfi:
        raise HTTPException(status_code=404, detail="RFI not found")

    from datetime import datetime, timezone
    rfi.rfi_status = RFIStatus.RESOLVED
    rfi.response_data = body.response_data
    rfi.resolved_by = current_user.id
    rfi.resolved_at = datetime.now(timezone.utc)
    
    # Supply missing data into the system before re-adjudicating
    from app.models.case import Case
    if rfi.reason_code == "MISSING_PREAUTH" and body.response_data and "preauth_number" in body.response_data:
        auth_num = body.response_data.get("preauth_number", "").strip()
        if auth_num:
            case_result = await db.execute(select(Case).where(Case.claim_id == rfi.claim_id))
            case = case_result.scalar_one_or_none()
            if case:
                case.preauth_number = auth_num

    await db.commit()

    # Re-adjudicate the claim
    adj_result = await adjudicate_claim(
        claim_id=str(rfi.claim_id),
        db=db,
        auto_generate_rfis=True,
    )

    return {
        "rfi_resolved": True,
        "rfi_id": str(rfi.id),
        "re_adjudication": {
            "status": adj_result.status,
            "is_clean": adj_result.is_clean,
            "passed_checks": adj_result.passed_checks,
            "failed_checks": adj_result.failed_checks,
        },
    }
