"""
Middleware package — production hardening layers.
"""
from __future__ import annotations
from app.middleware.rate_limit import RateLimitMiddleware
from app.middleware.sanitization import XSSProtectionMiddleware
from app.middleware.logging_config import setup_logging, get_logger
from app.middleware.crash_handler import CrashHandlerMiddleware

__all__ = [
    "RateLimitMiddleware",
    "XSSProtectionMiddleware",
    "CrashHandlerMiddleware",
    "setup_logging",
    "get_logger",
]
