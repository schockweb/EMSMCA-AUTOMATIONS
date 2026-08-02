"""
Field-level encryption for the SA ID number, at rest.

WHY THIS EXISTS
---------------
`cases.patient_id_number` was declared `String(13)` — exactly the length of a
South African ID number and far too small for a Fernet token, so there was
nowhere to put ciphertext even if the write path had encrypted it, which it did
not. The same number is also carried inside `digital_prfs.form_data`, a JSONB
blob read by eighteen backend modules.

An SA ID number is not just an identifier. It encodes date of birth, sex and
citizenship, and it is the key South African institutions use to bind a record
to a person. It is the single most consequential field in this database.

HOW IT IS PROTECTED
-------------------
Two columns, because encryption alone would make the value unfindable:

  * the ciphertext — a Fernet token (AES-128-CBC + HMAC), so the value at rest
    is unreadable to anyone holding a dump, a disk image or a backup file;
  * a lookup HASH — HMAC-SHA256 of the NORMALISED number under the same key.
    Deterministic, so equality lookups and duplicate detection still work
    without decrypting anything. HMAC rather than a bare SHA-256 because the
    input space is tiny: SA ID numbers are 13 digits with a checksum, so a plain
    digest is brute-forceable in minutes on a laptop. Keyed, it is not.

Sorting, prefix search and range queries on the ID are gone. That is inherent to
encrypting a field, and none of them are things this product does.

NORMALISATION
-------------
Hashes are computed on digits only. "900101 5800 083" and "9001015800083" are
the same person, and a lookup that missed because of a space would silently
create a duplicate patient record.
"""
from __future__ import annotations

import hashlib
import hmac
import re
from functools import lru_cache
from typing import Optional

from app.utils.crypto import decrypt_str, encrypt_str

# A Fernet token always starts with this version byte, base64-encoded. It is the
# marker that tells encrypted rows from ones written before this shipped, so the
# read path can serve both during and after the backfill.
_TOKEN_PREFIX = "gAAAAA"


def normalise_id(value: str | None) -> str:
    """Digits only. Everything else is formatting."""
    return re.sub(r"\D", "", value or "")


@lru_cache(maxsize=1)
def _hmac_key() -> bytes:
    from app.config import get_settings
    # Domain-separated from the Fernet key derivation so the lookup hash can
    # never be used to attack the ciphertext, or vice versa.
    raw = (get_settings().ENCRYPTION_KEY or "").encode()
    return hashlib.sha256(b"patient-id-lookup:" + raw).digest()


def id_hash(value: str | None) -> Optional[str]:
    """Deterministic lookup hash, or None when there is no number.

    Same value in, same hash out, forever — that is what makes it usable as a
    lookup key, and also why it must be keyed.
    """
    digits = normalise_id(value)
    if not digits:
        return None
    return hmac.new(_hmac_key(), digits.encode(), hashlib.sha256).hexdigest()


def looks_encrypted(value: str | None) -> bool:
    """True when the stored value is already ciphertext.

    Cheap and structural: a Fernet token is base64 and starts with a fixed
    version byte, and an SA ID number is 13 digits. They cannot be confused.
    """
    return bool(value) and value.startswith(_TOKEN_PREFIX)


def encrypt_id(value: str | None) -> Optional[str]:
    """Plaintext ID -> Fernet token. Idempotent: an already-encrypted value is
    returned unchanged, so a backfill can be re-run safely."""
    if not value:
        return None
    if looks_encrypted(value):
        return value
    return encrypt_str(value)


def decrypt_id(value: str | None) -> Optional[str]:
    """Fernet token -> plaintext ID.

    A value that is NOT a token is returned as-is. That is deliberate: rows
    written before this shipped hold plaintext, and the application must keep
    serving them correctly while the backfill runs rather than showing blanks
    on real patient records.

    A token that fails to decrypt returns None — it was written under a
    different ENCRYPTION_KEY, and returning the raw ciphertext would put a wall
    of base64 where a clinician expects an ID number.
    """
    if not value:
        return None
    if not looks_encrypted(value):
        return value
    return decrypt_str(value)
