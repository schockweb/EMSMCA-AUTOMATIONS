from __future__ import annotations
from .base import BaseSchemeAdapter
from .generic import OAuth2SchemeAdapter
from .medscheme import APIKeySchemeAdapter


def get_scheme_adapter(config) -> BaseSchemeAdapter:
    """
    Factory: return the correct integration adapter based on the credentials'
    integration_type. `config` is a `SchemeCredentials` from `app.config`.
    """
    if getattr(config, "integration_type", "generic") == "medscheme":
        return APIKeySchemeAdapter(config)

    # "discovery", "generic", "mock", or unknown → OAuth2 today
    return OAuth2SchemeAdapter(config)
