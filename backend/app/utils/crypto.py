"""
Fernet field encryption for data stored at rest (POPIA / credential hygiene).

WHAT THIS PROTECTS
------------------
Ten identifier keys across three stores — patient and debtor SA ID numbers,
passport numbers, the principal member's ID, a captured ID document — plus each
provider's outbound SMTP app password. If this module is wrong, all of it is
either exposed or unreadable.

THREE PROBLEMS FIXED 2026-08-03
-------------------------------
1. A WRONG KEY WAS INDISTINGUISHABLE FROM A RIGHT ONE. Any string that is not a
   valid Fernet key was silently SHA-256-derived into one. Pragmatic — it keeps
   a misconfigured instance running — but it means a mistyped, truncated or
   rolled-back key produces a perfectly valid cipher object rather than an
   error. Combined with (2), that is silent data loss. It still derives, because
   failing to boot would be worse, but it now says so, loudly, once.

2. "CANNOT DECRYPT" LOOKED LIKE "NOT SET". `decrypt_str` caught everything and
   returned None, and callers render None as an empty field. So a wrong key
   would have made every patient ID, passport number and SMTP credential read as
   ABSENT across the whole platform, with no exception and no log line — a
   database that looks empty rather than one that looks broken. Failures are now
   logged with the reason, and `decrypt_str_strict` exists for callers that must
   distinguish the two.

3. NO KEY VERSION, SO NO ROTATION. Ciphertext carried no identifier, so re-keying
   meant a bespoke one-shot script over every column with no way to run old and
   new keys concurrently — and if the key were ever disclosed there was no
   remediation available at all. `MultiFernet` now accepts a comma-separated
   ENCRYPTION_KEY: the FIRST key encrypts, and ALL of them are tried on decrypt.
   Rotation becomes: prepend the new key, redeploy, re-encrypt in the
   background, then drop the old one.

ROTATION IS DELIBERATELY NOT AUTOMATIC. Re-encrypting is a write across every
patient identifier in the database and belongs to a person running
`encrypt_patient_ids.py` with a backup in hand, not to a background task.
"""
from __future__ import annotations

import base64
import hashlib
import logging
from functools import lru_cache

from cryptography.fernet import Fernet, InvalidToken, MultiFernet

from app.config import get_settings

logger = logging.getLogger("ems.crypto")

# Warn once per process rather than per call — this runs on every encrypt and
# every decrypt, and a per-call warning would bury the log it is trying to make
# visible.
_warned: set[str] = set()


def _warn_once(tag: str, msg: str, *args) -> None:
    if tag not in _warned:
        _warned.add(tag)
        logger.error(msg, *args)


def _build_one(raw: str, index: int) -> Fernet:
    """One Fernet from one configured key, deriving if it is not already valid."""
    try:
        return Fernet(raw.encode())
    except Exception:
        _warn_once(
            f"derived:{index}",
            "ENCRYPTION_KEY%s is not a valid Fernet key, so one was DERIVED from "
            "it by SHA-256. This works and is stable across restarts, but it means "
            "a mistyped or truncated key produces a working cipher rather than an "
            "error — and data written under it can only be read back with the "
            "exact same string. Generate a real key with "
            "`python -c \"from cryptography.fernet import Fernet; "
            "print(Fernet.generate_key().decode())\"`.",
            f" (key #{index + 1})" if index else "",
        )
        return Fernet(base64.urlsafe_b64encode(hashlib.sha256(raw.encode()).digest()))


@lru_cache(maxsize=1)
def _fernet() -> MultiFernet:
    """The active cipher.

    ENCRYPTION_KEY may hold several comma-separated keys. The FIRST is used to
    encrypt; every key is tried when decrypting, which is what makes a rotation
    possible without a flag day.

    Whitespace is stripped from each key. That is not tidiness: `patient_id.py`
    derives the lookup HMAC from the same setting, and for a long time one
    stripped and the other did not — so a key that gained a trailing newline
    (a re-paste, a Docker secret file) kept decrypting perfectly while every
    lookup hash silently changed.
    """
    raw = (get_settings().ENCRYPTION_KEY or "").strip()
    parts = [p.strip() for p in raw.split(",") if p.strip()]
    if not parts:
        _warn_once("empty", "ENCRYPTION_KEY is empty — a key was derived from an "
                            "empty string. Patient identifiers are effectively "
                            "unprotected. Set it.")
        parts = [""]
    if len(parts) > 1:
        logger.info("Field encryption: %d keys loaded (first encrypts, all decrypt)",
                    len(parts))
    return MultiFernet([_build_one(p, i) for i, p in enumerate(parts)])


def encrypt_str(plaintext: str) -> str:
    """Encrypt a string → urlsafe token for a Text column. Uses the FIRST key."""
    return _fernet().encrypt(plaintext.encode("utf-8")).decode("ascii")


def decrypt_str(token: str) -> str | None:
    """Decrypt a stored token, or None.

    None is returned for a token this instance cannot read — a different key, a
    truncated value, corruption. Callers render that as an empty field, so a
    silent None across the whole database is what a wrong key looks like from
    the outside. It is therefore LOGGED (once per reason), which is the
    difference between an incident that is noticed and one that is not.
    """
    try:
        return _fernet().decrypt(token.encode("ascii")).decode("utf-8")
    except InvalidToken:
        _warn_once(
            "invalid_token",
            "A stored value could not be decrypted with any configured "
            "ENCRYPTION_KEY. It was written under a different key, or is "
            "corrupt. Every affected field will read as EMPTY until the right "
            "key is restored — this is not the same as the field being unset. "
            "If a key was recently changed, add the previous one to "
            "ENCRYPTION_KEY as a second comma-separated value.",
        )
        return None
    except Exception as exc:
        _warn_once("decrypt_error", "Unexpected decryption failure: %s", exc)
        return None


def decrypt_str_strict(token: str) -> str:
    """Decrypt, or RAISE.

    For callers that must not treat "cannot decrypt" as "not set" — a
    verification pass, a backfill, an export. The whole point of the ten-key
    encryption work is undone if a script reads unreadable data as absent and
    then writes that absence back.
    """
    return _fernet().decrypt(token.encode("ascii")).decode("utf-8")


def key_fingerprint() -> str:
    """A short, non-reversible identifier for the ACTIVE key.

    Lets an operator confirm that two environments — or a container and the
    backup it is restoring — hold the same key, without either of them printing
    or comparing the key itself. Used by the encryption-integrity probe.
    """
    raw = (get_settings().ENCRYPTION_KEY or "").strip()
    first = raw.split(",")[0].strip()
    return hashlib.sha256(f"ems-key-fingerprint:{first}".encode()).hexdigest()[:12]
