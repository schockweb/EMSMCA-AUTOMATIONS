from __future__ import annotations
from pydantic import BaseModel
from typing import Optional, Any

class DocumentReviewRequest(BaseModel):
    extracted_data: dict[str, Any]
    clear_review_flag: bool = True
