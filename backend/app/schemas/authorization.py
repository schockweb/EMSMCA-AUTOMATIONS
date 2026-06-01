"""
Pydantic schemas for Scheme Authorization API.
"""
from __future__ import annotations
from datetime import datetime
from pydantic import BaseModel
from typing import Optional


class AuthRequestResponse(BaseModel):
    id: str
    case_id: str
    claim_id: Optional[str] = None
    scheme_name: Optional[str] = None
    status: str
    auth_number: Optional[str] = None
    approved_amount: Optional[float] = None
    decline_reason: Optional[str] = None
    requested_at: datetime
    responded_at: Optional[datetime] = None
    request_payload: Optional[dict] = None
    response_payload: Optional[dict] = None

    class Config:
        from_attributes = True


class AuthHistoryResponse(BaseModel):
    case_id: str
    patient_name: Optional[str] = None
    scheme_name: Optional[str] = None
    preauth_number: Optional[str] = None
    preauth_status: str
    requests: list[AuthRequestResponse]


class AuthRequestCreate(BaseModel):
    """Optional overrides when manually triggering an auth request."""
    dispatch_type: Optional[str] = None
    referring_doctor_pr: Optional[str] = None
    dependant_code: Optional[str] = None
    # §08 structured snapshot — member identification + clinical summary
    member_data: Optional[dict] = None    # scheme, plan, membership #, IDs
    clinical_data: Optional[dict] = None  # incident, ICD-10, procedures, motivation
