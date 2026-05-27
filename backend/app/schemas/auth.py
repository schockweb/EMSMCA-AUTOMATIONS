"""
Pydantic schemas for authentication requests/responses.
"""
from pydantic import BaseModel, EmailStr


class LoginRequest(BaseModel):
    email: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class RefreshRequest(BaseModel):
    refresh_token: str


class UserProfile(BaseModel):
    id: str
    email: str
    full_name: str
    role: str
    bhf_practice_number: str | None = None
    is_active: bool
    permissions: list[str] = []

    class Config:
        from_attributes = True
