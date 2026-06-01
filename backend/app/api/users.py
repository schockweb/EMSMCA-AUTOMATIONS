"""
Users API — CRUD operations for user management (admin only).
"""
from __future__ import annotations
import uuid
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.user import User, UserRole, ALL_PERMISSIONS
from app.schemas.user import UserCreate, UserUpdate, UserResponse
from app.utils.security import get_current_user, require_role, hash_password, validate_password_complexity

router = APIRouter(prefix="/api/users", tags=["Users"])


def _user_response(u: User) -> UserResponse:
    """Helper to build a consistent UserResponse."""
    return UserResponse(
        id=str(u.id),
        email=u.email,
        full_name=u.full_name,
        role=u.role.value,
        bhf_practice_number=u.bhf_practice_number,
        is_active=u.is_active,
        permissions=u.permissions or list(ALL_PERMISSIONS),
        created_at=u.created_at,
    )


@router.get("/permissions-list")
async def get_all_permissions(
    _admin: User = Depends(require_role(UserRole.ADMIN)),
):
    """Return the master list of all available permission keys."""
    return {
        "permissions": [
            {"key": "dashboard",           "label": "Dashboard"},
            {"key": "upload",              "label": "Upload PRF"},
            {"key": "admin_queue",         "label": "Admin Queue"},
            {"key": "document_review",     "label": "Document Review"},
            {"key": "adjudication",        "label": "Adjudication"},
            {"key": "edi_submit",          "label": "EDI Submissions"},
            {"key": "era_tracking",        "label": "ERA Tracking"},
            {"key": "analytics",           "label": "Analytics"},
            {"key": "payouts",             "label": "Payouts"},
            {"key": "ai_training",         "label": "AI Training"},
            {"key": "cases",               "label": "Case Management"},
            {"key": "employee_management", "label": "Employee Management"},
        ]
    }


@router.post("/", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
async def create_user(
    body: UserCreate,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_role(UserRole.ADMIN)),
):
    """Create a new user (admin only)."""
    existing = await db.execute(select(User).where(User.email == body.email))
    if existing.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Email already registered",
        )

    # Enforce password complexity
    try:
        validate_password_complexity(body.password)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )

    user = User(
        email=body.email,
        hashed_password=hash_password(body.password),
        full_name=body.full_name,
        role=UserRole(body.role),
        bhf_practice_number=body.bhf_practice_number,
        permissions=body.permissions or list(ALL_PERMISSIONS),
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return _user_response(user)


@router.get("/", response_model=list[UserResponse])
async def list_users(
    skip: int = 0,
    limit: int = 50,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_role(UserRole.ADMIN)),
):
    """List all users (admin only)."""
    result = await db.execute(
        select(User).order_by(User.created_at.desc()).offset(skip).limit(limit)
    )
    return [_user_response(u) for u in result.scalars().all()]


@router.get("/{user_id}", response_model=UserResponse)
async def get_user(
    user_id: str,
    db: AsyncSession = Depends(get_db),
    _current: User = Depends(get_current_user),
):
    """Get a specific user by ID."""
    result = await db.execute(select(User).where(User.id == uuid.UUID(user_id)))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return _user_response(user)


@router.patch("/{user_id}", response_model=UserResponse)
async def update_user(
    user_id: str,
    body: UserUpdate,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_role(UserRole.ADMIN)),
):
    """Update a user (admin only) — supports role, permissions, password reset."""
    result = await db.execute(select(User).where(User.id == uuid.UUID(user_id)))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    if body.full_name is not None:
        user.full_name = body.full_name
    if body.role is not None:
        user.role = UserRole(body.role)
    if body.bhf_practice_number is not None:
        user.bhf_practice_number = body.bhf_practice_number
    if body.is_active is not None:
        user.is_active = body.is_active
    if body.permissions is not None:
        user.permissions = body.permissions
    if body.password is not None and body.password.strip():
        # Enforce password complexity on password changes too
        try:
            validate_password_complexity(body.password)
        except ValueError as e:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=str(e),
            )
        user.hashed_password = hash_password(body.password)

    await db.commit()
    await db.refresh(user)
    return _user_response(user)


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_user(
    user_id: str,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_role(UserRole.ADMIN)),
):
    """Deactivate a user (admin only). Does not hard-delete for audit trail."""
    result = await db.execute(select(User).where(User.id == uuid.UUID(user_id)))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    user.is_active = False
    await db.commit()
