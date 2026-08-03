"""
Users API — CRUD operations for user management (admin only).
"""
from __future__ import annotations
import uuid
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.audit_log import AuditLog
from app.models.user import User, UserRole, ALL_PERMISSIONS
from app.schemas.user import UserCreate, UserUpdate, UserResponse
from app.utils.client_ip import get_trusted_client_ip
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
        # Reported verbatim. The column is NOT NULL (migration a4d81c6b2f75),
        # so there is no "not configured" state left to interpret — an empty
        # list means no access and the screen where access is managed must show
        # exactly that. Substituting ALL_PERMISSIONS for a falsy value is how
        # this screen used to tell an administrator that a locked-down account
        # held everything.
        permissions=list(u.permissions or []),
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
        # `or` would treat an explicitly EMPTY list as "not supplied" and hand
        # the new account every permission — the same falsy-empty-list bug that
        # was fixed in has_permission and on /api/auth/me. Creating a
        # deliberately restricted user must not silently create a superuser.
        permissions=(list(ALL_PERMISSIONS) if body.permissions is None
                     else body.permissions),
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
    _admin: User = Depends(require_role(UserRole.ADMIN)),
):
    """Get a specific user by ID.

    Was `get_current_user` — authentication only. Any account, including one
    created with a single page permission, could read every other account's
    email, role, active flag and full permission list: a target list for
    deciding which administrator to go after.
    """
    result = await db.execute(select(User).where(User.id == uuid.UUID(user_id)))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return _user_response(user)


@router.patch("/{user_id}", response_model=UserResponse)
async def update_user(
    user_id: str,
    body: UserUpdate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_role(UserRole.ADMIN)),
):
    """Update a user (admin only) — supports role, permissions, password reset.

    THE HOLE THIS CLOSES
    --------------------
    This route was reachable by ADMIN — the role a SUPER_ADMIN hands to client
    office staff — and wrote `user.role = UserRole(body.role)` with no
    restriction on the value, no check on the target, and no audit record. So
    any ADMIN could `PATCH /api/users/{their own id} {"role": "super_admin"}`
    and become SUPER_ADMIN, which short-circuits every guard in the system
    (require_role and has_permission both return True for it unconditionally).
    From there `DELETE /api/cases/all` erases every case, claim and document on
    the instance, across all tenants.

    The same route also reset ANY user's password with no current-password
    check, so an ADMIN could instead simply take the real SUPER_ADMIN's account,
    or set `is_active: false` and lock them out. None of it was audited.

    Three rules now:
      * Only a SUPER_ADMIN may grant or revoke SUPER_ADMIN.
      * Nobody may change their OWN role, permissions or active flag — that is
        self-escalation regardless of who they are, and privilege changes should
        come from someone else.
      * A non-SUPER_ADMIN may not modify a SUPER_ADMIN account at all.
    And every change is written to the audit log with a before/after.
    """
    result = await db.execute(select(User).where(User.id == uuid.UUID(user_id)))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    caller_is_super = _admin.role == UserRole.SUPER_ADMIN
    editing_self = user.id == _admin.id

    # A lower-privileged account must not be able to touch the highest one —
    # not its password, not its active flag, not its role.
    if user.role == UserRole.SUPER_ADMIN and not caller_is_super:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only a super administrator may modify a super administrator account.",
        )

    before = {
        "role": user.role.value,
        "is_active": user.is_active,
        "permissions": list(user.permissions) if user.permissions is not None else None,
    }

    if body.full_name is not None:
        user.full_name = body.full_name

    if body.role is not None:
        try:
            new_role = UserRole(body.role)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Unknown role '{body.role}'",
            )
        if new_role != user.role:
            if editing_self:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="You cannot change your own role.",
                )
            # Granting OR removing super-admin is a super-admin act. Removing
            # matters as much as granting: otherwise an ADMIN demotes the
            # SUPER_ADMIN and is left the most privileged account standing.
            if (new_role == UserRole.SUPER_ADMIN or user.role == UserRole.SUPER_ADMIN) \
                    and not caller_is_super:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Only a super administrator may assign or remove the super administrator role.",
                )
            user.role = new_role

    if body.bhf_practice_number is not None:
        user.bhf_practice_number = body.bhf_practice_number

    if body.is_active is not None and body.is_active != user.is_active:
        if editing_self:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You cannot change your own active status.",
            )
        user.is_active = body.is_active

    if body.permissions is not None:
        if editing_self and set(body.permissions) != set(user.permissions or []):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You cannot change your own permissions.",
            )
        user.permissions = body.permissions

    password_changed = False
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
        password_changed = True
        # An administrative password reset must end the sessions the old
        # password minted, or the reset does not lock anybody out.
        user.tokens_revoked_at = datetime.now(timezone.utc)

    after = {
        "role": user.role.value,
        "is_active": user.is_active,
        "permissions": list(user.permissions) if user.permissions is not None else None,
    }

    # Audited unconditionally. Role and permission changes are the events an
    # investigator most needs and were the only privileged writes in the product
    # that left no trace at all.
    if before != after or password_changed:
        db.add(AuditLog(
            user_id=_admin.id,
            action="USER_UPDATED",
            entity_type="user",
            entity_id=user.id,
            details={
                "target_email": user.email,
                "changed_by": _admin.email,
                "password_reset": password_changed,
            },
            before_state=before,
            after_state=after,
            ip_address=get_trusted_client_ip(request),
        ))

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
