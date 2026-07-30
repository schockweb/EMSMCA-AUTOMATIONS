from __future__ import annotations
import logging
from typing import Literal
from fastapi import APIRouter, Depends, HTTPException, status, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.user import User, UserRole
from app.services.gateway import forward_to_scheme
from app.utils.security import require_role

logger = logging.getLogger("ems.gateway.api")

router = APIRouter(prefix="/gateway", tags=["Integration API Gateway"])

class GatewayRequest(BaseModel):
    internal_claim_id: str = Field(..., description="Internal claim or case ID tracking the event")
    scheme_destination_code: str = Field(..., description="Target scheme identifier (e.g. DEST_DISC_001, discovery)")
    action: Literal["REQUEST_AUTH", "SUBMIT_CLAIM"] = Field(..., description="The action to perform")
    payload_data: dict = Field(..., description="The JSON payload to forward to the scheme")

@router.post("/")
async def submit_gateway_request(
    request: Request,
    gateway_req: GatewayRequest,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(require_role(UserRole.ADMIN, UserRole.SUPER_ADMIN)),
):
    """
    Centralized Gateway for transmitting standardized claims and authorizations.
    Wrapped in Idempotency Lock.

    ADMIN-only. This route forwards a caller-supplied `payload_data` dict to a
    caller-selected medical scheme's live B2B endpoint, under OUR credentials
    and practice number. It had no authentication, so anyone who could reach
    /gateway/ could transmit arbitrary content to a scheme as us — and read the
    scheme's response back out of the proxied reply.
    """
    from app.utils.idempotency import process_idempotent_request

    async def _execute():
        status_code, response_payload = await forward_to_scheme(
            db=db,
            internal_claim_id=gateway_req.internal_claim_id,
            scheme_destination_code=gateway_req.scheme_destination_code,
            action=gateway_req.action,
            payload_data=gateway_req.payload_data
        )

        if str(status_code).startswith("5"):
            return JSONResponse(status_code=status.HTTP_502_BAD_GATEWAY, content=response_payload)

        return JSONResponse(status_code=status_code, content=response_payload)

    return await process_idempotent_request(request, db, _execute)


