"""
Scheme-rule registry.

Every scheme with hardcoded pricing rules lives in its own module under this
package. The registry maps a free-text scheme name (as it appears on a PRF
form or case record — "GEMS", "Government Employees Medical Scheme", etc.)
to the correct module via exact match, then keyword fuzzy match.

Usage:
    from app.rules import get_rules_for_scheme

    module = get_rules_for_scheme("Government Employees Medical Scheme")
    if module is None:
        raise HTTPException(422, f"No pricing module configured for '{name}'")
    # module.TARIFFS, module.RULES, module.PAYER_TYPE etc.

To add a new scheme:
    1. Create `app/rules/{scheme_id}.py` following the `SchemeRuleModule` protocol.
    2. Import + register it in this file (see gems registration below).
    3. Add corresponding `SCHEME_{SCHEME_ID}_*` env vars for API credentials.
"""
from __future__ import annotations

import logging
from typing import Optional

from app.rules.base import SchemeRuleModule

logger = logging.getLogger("ems.rules.registry")


# ── Registry ─────────────────────────────────────────────────────────────────

_REGISTRY: dict[str, SchemeRuleModule] = {}


def register(scheme_id: str, module: SchemeRuleModule) -> None:
    """Register a scheme module. Called at import time by each scheme file."""
    key = scheme_id.strip().lower()
    if key in _REGISTRY:
        logger.warning("Overriding already-registered scheme module '%s'", key)
    _REGISTRY[key] = module
    logger.info("Registered scheme rule module: %s", key)


def get_rules_for_scheme(scheme_name: Optional[str]) -> Optional[SchemeRuleModule]:
    """Resolve a scheme module by name.

    Resolution order:
      1. Exact match on SCHEME_ID (case-insensitive)
      2. Keyword match against each module's SCHEME_KEYWORDS
      3. None
    """
    if not scheme_name:
        return None
    query = scheme_name.strip().lower()
    if not query:
        return None

    # 1. Exact match
    module = _REGISTRY.get(query)
    if module is not None:
        return module

    # 2. Keyword fuzzy match — first module whose keyword is contained in the query
    for module in _REGISTRY.values():
        for kw in getattr(module, "SCHEME_KEYWORDS", ()):
            if kw and kw.strip().lower() in query:
                return module

    return None


def list_configured_schemes() -> list[str]:
    """Return the registered scheme IDs (useful for health checks + UIs)."""
    return sorted(_REGISTRY.keys())


# ═══════════════════════════════════════════════════════════════════════════
# Scheme registrations — import each module then call register()
# ═══════════════════════════════════════════════════════════════════════════

from app.rules import gems as _gems            # noqa: E402
from app.rules import discovery as _discovery  # noqa: E402

register(_gems.SCHEME_ID, _gems)               # type: ignore[arg-type]
register(_discovery.SCHEME_ID, _discovery)     # type: ignore[arg-type]
