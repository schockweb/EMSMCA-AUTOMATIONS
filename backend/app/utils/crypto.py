"""
Fernet field encryption for secrets stored at rest (POPIA / credential
hygiene). Backed by settings.ENCRYPTION_KEY.

The env example says the key should be a generated Fernet key, but nothing
has enforced that until now — so a prod key that is an arbitrary string must
not brick the app. If the configured key isn't a valid Fernet key we derive
one deterministically from it (SHA-256 → urlsafe base64), which keeps
encrypt/decrypt stable across restarts for any key value.
"""
from __future__ import annotations

import base64
import hashlib
from functools import lru_cache

from cryptography.fernet import Fernet, InvalidToken

from app.config import get_settings


@lru_cache(maxsize=1)
def _fernet() -> Fernet:
    key = (get_settings().ENCRYPTION_KEY or "").strip()
    try:
        return Fernet(key.encode())
    except Exception:
        derived = base64.urlsafe_b64encode(hashlib.sha256(key.encode()).digest())
        return Fernet(derived)


def encrypt_str(plaintext: str) -> str:
    """Encrypt a string → urlsafe token string for a Text column."""
    return _fernet().encrypt(plaintext.encode("utf-8")).decode("ascii")


def decrypt_str(token: str) -> str | None:
    """Decrypt a stored token. Returns None (never raises) when the token is
    invalid/corrupt or was encrypted under a different key — callers treat
    that as 'credential not usable' and surface a reconfigure message."""
    try:
        return _fernet().decrypt(token.encode("ascii")).decode("utf-8")
    except (InvalidToken, Exception):
        return None
