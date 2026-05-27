"""
Pydantic schemas for Claims and Claim Lines.
"""
from datetime import datetime
from pydantic import BaseModel
from typing import Optional, List


class ClaimLineCreate(BaseModel):
    line_number: int = 1
    cpt_code: Optional[str] = None
    nappi_code: Optional[str] = None
    icd10_primary: Optional[str] = None
    icd10_secondary: Optional[str] = None
    description: Optional[str] = None
    quantity: int = 1
    unit_price: float = 0
    total_price: float = 0
    modifier: Optional[str] = None


class ClaimLineResponse(BaseModel):
    id: str
    line_number: int
    cpt_code: Optional[str] = None
    nappi_code: Optional[str] = None
    icd10_primary: Optional[str] = None
    icd10_secondary: Optional[str] = None
    description: Optional[str] = None
    quantity: int
    unit_price: float
    total_price: float
    modifier: Optional[str] = None

    class Config:
        from_attributes = True


class ClaimCreate(BaseModel):
    case_id: str
    target_scheme: Optional[str] = None
    dispatch_reference_number: Optional[str] = None
    lines: List[ClaimLineCreate] = []


class ClaimUpdate(BaseModel):
    target_scheme: Optional[str] = None
    adjudication_status: Optional[str] = None
    dispatch_reference_number: Optional[str] = None


class LineUpdate(BaseModel):
    id: str
    quantity: int
    total_price: float

class ClaimLinesUpdateBulk(BaseModel):
    lines: List[LineUpdate]
    # Optional — when the payer is an aggregator (ER24, Netcare 911), the
    # dispatch reference number is stored on the claim and sent with the same
    # save call so the frontend doesn't have to issue two round-trips.
    dispatch_reference_number: Optional[str] = None


class ClaimResponse(BaseModel):
    id: str
    case_id: str
    total_amount: float
    target_scheme: Optional[str] = None
    dispatch_reference_number: Optional[str] = None
    adjudication_status: str
    submitted_at: Optional[datetime] = None
    created_at: datetime
    claim_lines: List[ClaimLineResponse] = []

    class Config:
        from_attributes = True
