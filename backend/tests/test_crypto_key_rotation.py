"""
The encryption key: rotation, and failing loudly instead of silently.

This module protects ten identifier keys across three stores plus every
provider's SMTP credential. Its failure mode was the dangerous kind: a wrong key
produced a working cipher object, and every read came back None, which callers
render as an empty field. A misconfigured instance therefore looked like a
database with no patient identifiers in it rather than one that could not read
them.
"""
import importlib

import pytest
from cryptography.fernet import Fernet, InvalidToken

pytestmark = pytest.mark.asyncio


def _crypto_with(key: str):
    """A freshly-configured crypto module. The Fernet builder is lru_cached and
    Settings is cached too, so both have to be cleared for the new key to take."""
    from app.config import get_settings
    import app.utils.crypto as crypto

    get_settings.cache_clear()
    monkey = pytest.MonkeyPatch()
    monkey.setenv("ENCRYPTION_KEY", key)
    get_settings.cache_clear()
    crypto._fernet.cache_clear()
    crypto._warned.clear()
    return crypto, monkey


def _restore(monkey):
    from app.config import get_settings
    import app.utils.crypto as crypto
    monkey.undo()
    get_settings.cache_clear()
    crypto._fernet.cache_clear()
    crypto._warned.clear()


# ════════════════════════════════════════════════════════════════════
# Rotation
# ════════════════════════════════════════════════════════════════════

def test_a_second_key_can_read_what_the_first_key_wrote():
    """The whole point of rotation: old ciphertext stays readable while new
    writes use the new key. Without this, re-keying required a flag day and a
    bespoke script — and a disclosed key had no remediation at all."""
    old_key = Fernet.generate_key().decode()
    new_key = Fernet.generate_key().decode()

    crypto, mk = _crypto_with(old_key)
    try:
        token_under_old = crypto.encrypt_str("9001015800083")
    finally:
        _restore(mk)

    # Rotate: NEW key first (it encrypts), old key retained (it still decrypts).
    crypto, mk = _crypto_with(f"{new_key},{old_key}")
    try:
        assert crypto.decrypt_str(token_under_old) == "9001015800083", \
            "old ciphertext became unreadable after adding a new key"
        fresh = crypto.encrypt_str("8505125800084")
    finally:
        _restore(mk)

    # After the old key is dropped, the NEW ciphertext must still read.
    crypto, mk = _crypto_with(new_key)
    try:
        assert crypto.decrypt_str(fresh) == "8505125800084"
        assert crypto.decrypt_str(token_under_old) is None, \
            "old ciphertext still readable after the old key was removed"
    finally:
        _restore(mk)


def test_the_first_key_is_the_one_that_encrypts():
    """Order matters: put the new key first or rotation never makes progress."""
    k1 = Fernet.generate_key().decode()
    k2 = Fernet.generate_key().decode()

    crypto, mk = _crypto_with(f"{k1},{k2}")
    try:
        token = crypto.encrypt_str("secret-value")
    finally:
        _restore(mk)

    # k1 alone must be able to read it; k2 alone must not.
    crypto, mk = _crypto_with(k1)
    try:
        assert crypto.decrypt_str(token) == "secret-value"
    finally:
        _restore(mk)

    crypto, mk = _crypto_with(k2)
    try:
        assert crypto.decrypt_str(token) is None, "the SECOND key encrypted"
    finally:
        _restore(mk)


def test_whitespace_around_a_key_is_ignored():
    """A key that gains a trailing newline — a re-paste, a Docker secret file —
    must not change what can be read. The same setting derives the lookup HMAC,
    and for a while one side stripped and the other did not."""
    key = Fernet.generate_key().decode()

    crypto, mk = _crypto_with(key)
    try:
        token = crypto.encrypt_str("9001015800083")
    finally:
        _restore(mk)

    crypto, mk = _crypto_with(f"  {key}\n")
    try:
        assert crypto.decrypt_str(token) == "9001015800083"
    finally:
        _restore(mk)


# ════════════════════════════════════════════════════════════════════
# Failing loudly
# ════════════════════════════════════════════════════════════════════

def test_a_non_fernet_key_is_reported_not_silently_derived(caplog):
    """It still derives — refusing to boot would be worse — but it says so.

    Silently deriving means a mistyped or truncated key produces a working
    cipher, and data written under it is readable only with that exact string.
    """
    crypto, mk = _crypto_with("not-a-real-fernet-key")
    try:
        with caplog.at_level("ERROR"):
            crypto.encrypt_str("x")
        assert any("not a valid Fernet key" in r.message for r in caplog.records), \
            "a derived key was accepted with no log line"
    finally:
        _restore(mk)


def test_an_unreadable_value_is_reported_not_silently_blank(caplog):
    """The dangerous one.

    decrypt_str returns None for a value it cannot read, and callers render None
    as an empty field — so a wrong key made the entire database look EMPTY
    rather than broken, with no exception and no log line anywhere.
    """
    written_under = Fernet.generate_key().decode()
    read_under = Fernet.generate_key().decode()

    crypto, mk = _crypto_with(written_under)
    try:
        token = crypto.encrypt_str("9001015800083")
    finally:
        _restore(mk)

    crypto, mk = _crypto_with(read_under)
    try:
        with caplog.at_level("ERROR"):
            assert crypto.decrypt_str(token) is None
        assert any("could not be decrypted" in r.message for r in caplog.records), \
            "an unreadable patient identifier produced no log line"
    finally:
        _restore(mk)


def test_strict_decrypt_raises_instead_of_returning_none():
    """For a backfill, a verification pass or an export, "cannot decrypt" must
    not be read as "not set" — otherwise a script writes that absence back."""
    written_under = Fernet.generate_key().decode()
    read_under = Fernet.generate_key().decode()

    crypto, mk = _crypto_with(written_under)
    try:
        token = crypto.encrypt_str("9001015800083")
    finally:
        _restore(mk)

    crypto, mk = _crypto_with(read_under)
    try:
        with pytest.raises(InvalidToken):
            crypto.decrypt_str_strict(token)
    finally:
        _restore(mk)


def test_the_key_fingerprint_identifies_without_revealing():
    """Lets an operator confirm two environments hold the same key without
    either of them printing it."""
    k1 = Fernet.generate_key().decode()
    k2 = Fernet.generate_key().decode()

    crypto, mk = _crypto_with(k1)
    try:
        fp1, fp1_again = crypto.key_fingerprint(), crypto.key_fingerprint()
    finally:
        _restore(mk)

    crypto, mk = _crypto_with(k2)
    try:
        fp2 = crypto.key_fingerprint()
    finally:
        _restore(mk)

    assert fp1 == fp1_again, "the fingerprint is not stable"
    assert fp1 != fp2, "two different keys share a fingerprint"
    assert k1 not in fp1 and len(fp1) == 12, "the fingerprint leaks the key"


def test_rotation_does_not_change_the_fingerprint_of_the_active_key():
    """The fingerprint tracks the key that ENCRYPTS, so adding a decrypt-only
    fallback must not change it."""
    k_new = Fernet.generate_key().decode()
    k_old = Fernet.generate_key().decode()

    crypto, mk = _crypto_with(k_new)
    try:
        alone = crypto.key_fingerprint()
    finally:
        _restore(mk)

    crypto, mk = _crypto_with(f"{k_new},{k_old}")
    try:
        with_fallback = crypto.key_fingerprint()
    finally:
        _restore(mk)

    assert alone == with_fallback
