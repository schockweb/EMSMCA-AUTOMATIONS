"""
Input Sanitization & XSS Protection Middleware.
Strips dangerous HTML/JS from query parameters AND request bodies.
Adds security response headers to all responses.
"""
from __future__ import annotations
import re
import html
import json
from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.responses import Response


# Patterns that indicate XSS attempts
XSS_PATTERNS = [
    re.compile(r'<script[^>]*>.*?</script>', re.IGNORECASE | re.DOTALL),
    re.compile(r'javascript\s*:', re.IGNORECASE),
    re.compile(r'on\w+\s*=', re.IGNORECASE),  # onclick=, onerror=, etc.
    re.compile(r'<iframe[^>]*>', re.IGNORECASE),
    re.compile(r'<object[^>]*>', re.IGNORECASE),
    re.compile(r'<embed[^>]*>', re.IGNORECASE),
    re.compile(r'expression\s*\(', re.IGNORECASE),  # CSS expression()
    re.compile(r'url\s*\(\s*["\']?\s*javascript:', re.IGNORECASE),
    re.compile(r'<svg[^>]*onload', re.IGNORECASE),  # SVG XSS
    re.compile(r'<img[^>]*onerror', re.IGNORECASE),  # img onerror XSS
]


def contains_xss(value: str) -> bool:
    """Check if a string contains potential XSS payloads."""
    if not isinstance(value, str):
        return False
    for pattern in XSS_PATTERNS:
        if pattern.search(value):
            return True
    return False


def _scan_value(value) -> bool:
    """Recursively scan a value (str, dict, list) for XSS payloads."""
    if isinstance(value, str):
        return contains_xss(value)
    elif isinstance(value, dict):
        return any(_scan_value(v) for v in value.values())
    elif isinstance(value, list):
        return any(_scan_value(item) for item in value)
    return False


def sanitize_string(value: str) -> str:
    """Sanitize a string by escaping HTML entities."""
    if not isinstance(value, str):
        return value
    # Escape HTML entities
    sanitized = html.escape(value, quote=True)
    return sanitized


def sanitize_dict(data: dict) -> dict:
    """Recursively sanitize all string values in a dictionary."""
    sanitized = {}
    for key, value in data.items():
        if isinstance(value, str):
            sanitized[key] = sanitize_string(value)
        elif isinstance(value, dict):
            sanitized[key] = sanitize_dict(value)
        elif isinstance(value, list):
            sanitized[key] = [
                sanitize_dict(v) if isinstance(v, dict)
                else sanitize_string(v) if isinstance(v, str)
                else v
                for v in value
            ]
        else:
            sanitized[key] = value
    return sanitized


# Paths that should skip body XSS scanning (binary uploads, etc.)
_SKIP_BODY_SCAN_PATHS = {
    "/api/documents/upload",
}


class XSSProtectionMiddleware(BaseHTTPMiddleware):
    """
    Middleware that:
    1. Scans query parameters for XSS payloads
    2. Scans JSON request bodies for XSS payloads (POST/PUT/PATCH)
    3. Adds security response headers
    """

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        # Check query parameters for XSS
        for key, value in request.query_params.items():
            if contains_xss(value):
                from starlette.responses import JSONResponse
                return JSONResponse(
                    status_code=400,
                    content={"detail": f"Potentially unsafe input detected in parameter '{key}'."},
                )

        # Check JSON request bodies for XSS (skip file uploads and GET requests)
        if request.method in ("POST", "PUT", "PATCH"):
            content_type = request.headers.get("content-type", "")
            path = request.url.path.rstrip("/")

            if "application/json" in content_type and path not in _SKIP_BODY_SCAN_PATHS:
                try:
                    body = await request.body()
                    if body and len(body) < 1_000_000:  # Skip huge payloads
                        body_data = json.loads(body)
                        if _scan_value(body_data):
                            from starlette.responses import JSONResponse
                            return JSONResponse(
                                status_code=400,
                                content={"detail": "Potentially unsafe content detected in request body."},
                            )
                except (json.JSONDecodeError, UnicodeDecodeError):
                    pass  # Not valid JSON — let the route handler deal with it

        response = await call_next(request)

        # Security response headers
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-XSS-Protection"] = "1; mode=block"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"

        return response
