"""
Scheme API Integration Service — B2B credentials resolver.

Previously loaded `SchemeConfig` ORM records from the `scheme_configs` table
and `scheme_api.*` rows from `system_settings`. Both are gone — credentials
now live in environment variables via `app.config.get_scheme_credentials`
and are dispatched to the right adapter based on `integration_type`.
"""
from __future__ import annotations

import logging
from typing import Optional

from app.config import (
    SchemeCredentials,
    get_scheme_credentials,
    get_scheme_credentials_by_name,
)

logger = logging.getLogger("ems.scheme_auth")


def resolve_scheme_credentials(scheme_name: Optional[str]) -> Optional[SchemeCredentials]:
    """Fuzzy-match a scheme name to its env-configured credentials.

    Returns None when either (a) no rule module exists for the scheme, or
    (b) the scheme has a rule module but no `SCHEME_<ID>_*` env vars set.
    """
    return get_scheme_credentials_by_name(scheme_name)


def get_adapter_for_scheme(scheme_name: Optional[str]):
    """Factory: return a scheme adapter (OAuth2 or API-key) for the given scheme.

    Returns None when credentials are not configured — callers should 422 in
    that case rather than silently using a default.
    """
    creds = resolve_scheme_credentials(scheme_name)
    if creds is None:
        logger.warning("No scheme credentials configured for '%s'", scheme_name)
        return None
    return get_adapter_from_credentials(creds)


def get_adapter_from_credentials(creds: SchemeCredentials):
    """Dispatch to the correct adapter subclass based on integration_type."""
    # Local import avoids circular dep with adapters/__init__.py
    from app.services.adapters.base import BaseSchemeAdapter
    from app.services.adapters.generic import OAuth2SchemeAdapter
    from app.services.adapters.medscheme import APIKeySchemeAdapter

    if creds.integration_type == "medscheme":
        return APIKeySchemeAdapter(creds)
    # "discovery", "generic", "mock" and unknown all use OAuth2 today
    return OAuth2SchemeAdapter(creds)


# ── Back-compat shims ────────────────────────────────────────────────────────
# These are retained so existing callers keep working during the transition.
# New code should use `resolve_scheme_credentials` / `get_adapter_for_scheme`.

async def resolve_scheme_config(_db, scheme_name: Optional[str]) -> Optional[SchemeCredentials]:
    """Back-compat: same shape as the old function, ignores `db`."""
    return resolve_scheme_credentials(scheme_name)


def get_adapter_from_config(config):
    """Back-compat: accepts either a SchemeCredentials or a scheme_id string."""
    if isinstance(config, SchemeCredentials):
        return get_adapter_from_credentials(config)
    if isinstance(config, str):
        return get_adapter_for_scheme(config)
    # Last resort: try to coerce via .scheme_id attribute
    scheme_id = getattr(config, "scheme_id", None) or getattr(config, "scheme_name", None)
    if scheme_id:
        return get_adapter_for_scheme(scheme_id)
    return None


async def get_adapter_from_settings(_db):
    """Back-compat stub. The default-settings path no longer exists —
    callers should resolve per-scheme adapters via `get_adapter_for_scheme`."""
    logger.warning(
        "get_adapter_from_settings() is deprecated. "
        "Resolve adapters per-scheme via get_adapter_for_scheme(scheme_name)."
    )
    # Fall back to 'mock' if anyone is still calling this in tests
    return get_adapter_for_scheme("mock")
