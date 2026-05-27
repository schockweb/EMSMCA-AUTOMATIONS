"""
Pydantic schemas for User CRUD.
"""
from datetime import datetime
from pydantic import BaseModel
from typing import Optional


class UserCreate(BaseModel):
    email: str
    password: str
    full_name: str
    role: str = "paramedic"
    bhf_practice_number: Optional[str] = None
    permissions: Optional[list[str]] = None


class UserUpdate(BaseModel):
    full_name: Optional[str] = None
    role: Optional[str] = None
    bhf_practice_number: Optional[str] = None
    is_active: Optional[bool] = None
    permissions: Optional[list[str]] = None
    password: Optional[str] = None


class UserResponse(BaseModel):
    id: str
    email: str
    full_name: str
    role: str
    bhf_practice_number: Optional[str] = None
    is_active: bool
    permissions: list[str] = []
    created_at: datetime

    class Config:
        from_attributes = True
