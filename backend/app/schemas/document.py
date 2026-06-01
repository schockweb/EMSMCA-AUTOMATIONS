"""
Pydantic schemas for Documents.
"""
from __future__ import annotations
from datetime import datetime
from pydantic import BaseModel
from typing import Optional, Dict, Any


class DocumentResponse(BaseModel):
    id: str
    case_id: Optional[str] = None
    original_filename: str
    document_type: str
    ocr_status: str
    ocr_confidence_avg: Optional[float] = None
    ocr_field_scores: Optional[Dict[str, Any]] = None
    extracted_data: Optional[Dict[str, Any]] = None
    needs_hitl_review: bool
    created_at: datetime

    class Config:
        from_attributes = True


class DocumentListResponse(BaseModel):
    documents: list[DocumentResponse]
    total: int
    page: int
    page_size: int
