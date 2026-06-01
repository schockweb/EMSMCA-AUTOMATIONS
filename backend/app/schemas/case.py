"""
Pydantic schemas for Cases (Pre-authorizations).
"""
from __future__ import annotations
from datetime import datetime, date
from pydantic import BaseModel
from typing import Optional


class CaseCreate(BaseModel):
    patient_name: str
    patient_id_number: Optional[str] = None
    patient_dob: Optional[date] = None
    medical_scheme_name: Optional[str] = None
    scheme_member_number: Optional[str] = None
    incident_date: Optional[date] = None
    incident_location: Optional[str] = None
    preauth_number: Optional[str] = None
    dependant_code: Optional[str] = None
    dispatch_type: Optional[str] = None
    referring_doctor_pr: Optional[str] = None


class CaseUpdate(BaseModel):
    patient_name: Optional[str] = None
    patient_id_number: Optional[str] = None
    medical_scheme_name: Optional[str] = None
    scheme_member_number: Optional[str] = None
    preauth_number: Optional[str] = None
    preauth_status: Optional[str] = None
    dependant_code: Optional[str] = None
    dispatch_type: Optional[str] = None
    referring_doctor_pr: Optional[str] = None


class CaseResponse(BaseModel):
    id: str
    document_id: Optional[str] = None
    file_name: Optional[str] = None
    original_filename: Optional[str] = None
    extracted_data: Optional[dict] = None
    patient_name: str
    patient_id_number: Optional[str] = None
    patient_dob: Optional[date] = None
    medical_scheme_name: Optional[str] = None
    scheme_member_number: Optional[str] = None
    incident_date: Optional[date] = None
    incident_location: Optional[str] = None
    preauth_number: Optional[str] = None
    preauth_status: str
    dependant_code: Optional[str] = None
    dispatch_type: Optional[str] = None
    referring_doctor_pr: Optional[str] = None
    auth_flag: bool = False
    auth_flag_reason: Optional[str] = None
    claim_id: Optional[str] = None
    adjudication_status: Optional[str] = None
    created_at: datetime

    class Config:
        from_attributes = True

