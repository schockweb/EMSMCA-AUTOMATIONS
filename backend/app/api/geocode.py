import httpx
from fastapi import APIRouter
from fastapi.responses import JSONResponse

router = APIRouter()

@router.get("/{query}")
async def geocode_query(query: str):
    """
    Proxy to OpenStreetMap Nominatim.
    Bypasses browser CORS rules and user-agent restrictions.
    """
    url = f"https://nominatim.openstreetmap.org/search"
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
