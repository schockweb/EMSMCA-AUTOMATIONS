"""
Mock Scheme API — simulates a South African medical scheme's B2B authorization server.
Used for testing when no real scheme credentials are available.
"""
from __future__ import annotations
import uuid
import asyncio
import random
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

router = APIRouter(prefix="/api/mock-scheme", tags=["Mock Scheme API"])


@router.post("/oauth/token")
async def mock_oauth_token(request: Request):
    """
    Simulates OAuth2 client_credentials grant.
    Always returns a valid token for testing.
    """
    return JSONResponse(
        content={
            "access_token": f"mock_token_{uuid.uuid4().hex[:16]}",
            "token_type": "Bearer",
            "expires_in": 3600,
        },
        status_code=200,
    )


@router.post("/authorizations/ems/request")
async def mock_authorization_request(request: Request):
    """
    Simulates a medical scheme's authorization decision engine.

    Rules:
    - Returns 422 if required fields are missing
    - Auto-declines IHT without referring doctor PR
    - Auto-approves valid requests with a generated auth number
    - Simulates realistic 0.5-1.5s response time
    """
    try:
        payload = await request.json()
    except Exception:
        return JSONResponse(
            content={"error": "Invalid JSON payload"},
            status_code=400,
        )

    # Simulate processing time
    await asyncio.sleep(random.uniform(0.5, 1.5))

    # ── Validate payload structure ──
    beneficiary = payload.get("beneficiary", {})
    clinical = payload.get("clinical_details", {})
    provider = payload.get("provider", {})

    missing_fields = []
    if not beneficiary.get("medical_aid_number"):
        missing_fields.append("beneficiary.medical_aid_number")
    if not clinical.get("primary_icd10"):
        missing_fields.append("clinical_details.primary_icd10")
    if not provider.get("practice_number") or provider["practice_number"] == "N/A":
        missing_fields.append("provider.practice_number")

    if missing_fields:
        return JSONResponse(
            content={
                "error": "VALIDATION_FAILED",
                "decline_reason": f"Missing required fields: {', '.join(missing_fields)}",
                "missing_fields": missing_fields,
            },
            status_code=422,
        )

    # ── IHT check ──
    request_type = (clinical.get("request_type") or "").upper()
    referring_doc = clinical.get("referring_doctor_pr_number", "")
    if request_type == "IHT" and (not referring_doc or referring_doc == "N/A"):
        return JSONResponse(
            content={
                "error": "IHT_MISSING_REFERRAL",
                "decline_reason": (
                    "Inter-Hospital Transfer (IHT) authorization requires a valid "
                    "referring doctor PR number. Please provide the treating physician's "
                    "HPCSA practice number."
                ),
            },
            status_code=422,
        )

    # ── Simulate approval ──
    auth_number = f"AUTH-{random.randint(100000, 999999)}"
    icd10 = clinical.get("primary_icd10", "")

    # Financial limit based on level of care
    tariff = clinical.get("requested_level_of_care", "")
    financial_limits = {
        "0011": 3500.00,   # BLS
        "0012": 5500.00,   # ILS
        "377": 8500.00,    # ALS
        "378": 12000.00,   # ALS + doctor
    }
    limit = financial_limits.get(tariff, 6000.00)

    return JSONResponse(
        content={
            "authorization_number": auth_number,
            "status": "APPROVED",
            "financial_limit": limit,
            "valid_from": "2026-03-30T00:00:00Z",
            "valid_until": "2026-04-30T23:59:59Z",
            "beneficiary_verified": True,
            "scheme_plan": "Comprehensive Plus",
            "message": f"Authorization approved for ICD-10 {icd10}. "
                       f"Valid for 30 days. Financial limit: R{limit:,.2f}",
        },
        status_code=201,
    )
