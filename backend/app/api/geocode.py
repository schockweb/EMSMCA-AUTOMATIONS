from __future__ import annotations
import httpx
from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from app.utils.security import get_current_user

# AUTHENTICATION IS NOT OPTIONAL HERE.
#
# This router was mounted with no dependency at all, so GET /api/geocode/{query}
# was reachable by anyone on the internet. Two problems, and the second is the
# worse one:
#
#   * It is an OPEN RELAY to a third-party service. Anyone could drive arbitrary
#     query volume through our server's identity, which is how a deployment gets
#     its IP blocked by Nominatim's usage policy — taking the crew's address
#     lookup down with it.
#   * Whatever is typed into it is forwarded to a service in Europe under our
#     User-Agent. An unauthenticated endpoint that forwards caller-supplied text
#     off-shore is an exfiltration path that appears in no access log.
router = APIRouter(dependencies=[Depends(get_current_user)])


@router.get("/{query}")
async def geocode_query(query: str):
    """
    Proxy to OpenStreetMap Nominatim. Requires an authenticated session.
    Bypasses browser CORS rules and user-agent restrictions.
    """
    url = "https://nominatim.openstreetmap.org/search"
    params = {
        "format": "json",
        "addressdetails": "1",
        "limit": "6",
        "countrycodes": "za",
        "q": query
    }
    headers = {
        "User-Agent": "EMS-Forms-Claim-Adjudication/1.0",
        "Accept-Language": "en"
    }

    async with httpx.AsyncClient() as client:
        try:
            res = await client.get(url, params=params, headers=headers, timeout=5.0)
            res.raise_for_status()
            return res.json()
        except Exception as e:
            return JSONResponse(status_code=502, content={"error": str(e), "results": []})
