"""
SQLAlchemy column types that encrypt the SA ID number at rest.

WHY A COLUMN TYPE RATHER THAN CALLS AT EACH SITE
------------------------------------------------
`patient_id_number` is touched by eighteen backend modules — the OCR extractor,
the crew form's save path, three scheme rule engines, the adjudication engine,
the EDI generator, the spreadsheet export, the PDF payload. Encrypting at each
call site means eighteen chances to miss one, and a miss is invisible: the app
keeps working and the field is simply still plaintext on disk. That is worse
than not encrypting at all, because the platform would then be described as
encrypted while some records are not.

A TypeDecorator puts the transform at the boundary between the ORM and the
database. Every module keeps reading and writing a plain string; the value
crossing to storage is a Fernet token. There is exactly one place to get right,
and it cannot be bypassed by code that does not know about it.

WHAT THIS DOES NOT COVER
------------------------
Raw SQL. A query written as `WHERE form_data->>'patient_id_number' = ...` or
`cast(form_data AS text) ILIKE ...` sees ciphertext and will not match. That is
correct behaviour — a plaintext scan of an encrypted field should not work — but
it does mean free-text search will no longer find a patient by ID number. Use
`Case.patient_id_hash` with `id_hash(value)` for equality lookups.
"""
from __future__ import annotations

from typing import Any

from sqlalchemy import JSON, Text

from sqlalchemy.types import TypeDecorator

from app.utils.patient_id import decrypt_id, encrypt_id

PATIENT_ID_KEY = "patient_id_number"

# EVERY national identifier in the blob, not just the patient's SA ID.
#
# The first version of this encrypted exactly one key, which left three others
# sitting in plaintext in the SAME JSONB column:
#
#   debtor_id_number          — a 13-digit SA ID belonging to the account holder,
#                               who is frequently the patient's parent or spouse
#   patient_passport_number   — for a FOREIGN NATIONAL this is the patient's only
#                               national identifier, so for that entire class of
#                               patient the field the platform claims to encrypt
#                               was stored in the clear beside their clinical record
#   debtor_passport_number    — same, for the account holder
#
# "The SA ID field is encrypted" is not the same claim as "the patient's
# identifier is encrypted", and only the second one is worth making to a scheme.
#
# PATIENT_ID_KEY stays separate because it alone drives the lookup hash.
#
# THIS LIST WAS BUILT FROM THE DATA, NOT FROM MEMORY — and the first attempt,
# written from memory, named four of ten. A rehearsal of the backfill against a
# restored production backup is what found the rest: after converting everything
# the list named, 25 rows still held a bare 13-digit string. Among the missing
# were the principal medical-aid member's SA ID, present on 56 production
# records, and a DECEASED patient's ID number. Nothing failed — the backfill
# simply reported the table done.
#
# When adding a form field that holds a national identifier, add it here in the
# SAME change. tests/test_privilege_and_phi_hardening.py reads the crew form and
# fails if an identifier-shaped field is missing from this set. The query that
# finds an omission in live data is:
#
#   select key, count(*) from digital_prfs, lateral jsonb_each_text(form_data::jsonb)
#   where value ~ '^[0-9]{13}$' group by key;
_EXTRA_ID_KEYS = (
    "debtor_id_number",                     # account holder — often a parent or spouse
    "patient_passport_number",              # a foreign national's ONLY identifier
    "debtor_passport_number",
    "main_member_id",                       # principal medical-aid member
    "med_aid_dec_death_deceased_id",        # declaration of death — the deceased
    "med_aid_dec_death_deceased_passport",
    "med_aid_dec_death_hcp_id",             # the certifying practitioner
    "pvt_account_holder_id",                # private (non-scheme) account holder
    "id_document_image",                    # a captured ID document, ~874 chars
)

ENCRYPTED_FORM_KEYS = (PATIENT_ID_KEY,) + _EXTRA_ID_KEYS


class EncryptedPatientID(TypeDecorator):
    """A patient identifier: Fernet token on disk, plain string in Python."""

    impl = Text
    cache_ok = True

    def process_bind_param(self, value: Any, dialect) -> Any:  # noqa: ARG002
        if value is None:
            return None
        return encrypt_id(str(value))

    def process_result_value(self, value: Any, dialect) -> Any:  # noqa: ARG002
        return decrypt_id(value)


class FormDataWithEncryptedPatientID(TypeDecorator):
    """The PRF form blob, with every national identifier inside it encrypted.

    Only the identifier keys are transformed. Encrypting the whole blob would
    make the record unqueryable and unindexable, and would put the clinical
    narrative — which staff legitimately search — behind a decrypt on every read.
    """

    impl = JSON
    cache_ok = True

    def process_bind_param(self, value: Any, dialect) -> Any:  # noqa: ARG002
        if not isinstance(value, dict):
            return value
        out = None
        for key in ENCRYPTED_FORM_KEYS:
            raw = value.get(key)
            if raw in (None, ""):
                continue
            if out is None:
                out = dict(value)
            # str(): the ID arrives as an int from some OCR paths, and a numeric
            # SA ID reaching .encode() would raise and fail the whole save.
            out[key] = encrypt_id(str(raw))
        return value if out is None else out

    def process_result_value(self, value: Any, dialect) -> Any:  # noqa: ARG002
        if not isinstance(value, dict):
            return value
        out = None
        for key in ENCRYPTED_FORM_KEYS:
            raw = value.get(key)
            if raw in (None, ""):
                continue
            if out is None:
                out = dict(value)
            out[key] = decrypt_id(str(raw))
        return value if out is None else out


# The OCR intake path, which the PRF work never covered.
#
# `documents.extracted_data` is a bare JSONB holding the structured result of
# reading a SCANNED patient report form, and the extraction schema captures both
# the patient's SA ID (`patient_id_number`) and the principal member's
# (`main_member_id`). None of it was encrypted, and encrypt_patient_ids.py never
# touched this table — so "patient IDs are encrypted at rest" was true of the
# digital PRF and the case, and false of every scanned form ever uploaded.
_EXTRACTED_ID_KEYS = (
    "patient_id_number",
    "main_member_id",
    "patient_passport_number",
    "debtor_id_number",
)


class ExtractedDataWithEncryptedIDs(TypeDecorator):
    """OCR extraction output, with the identifier fields encrypted at rest.

    impl is JSON, NOT JSONB, and that is not a detail. The model imports
    `JSON as JSONB` (models/document.py:7) — an alias, so the column reads as
    JSONB in the source while `information_schema` reports plain `json`. Using a
    real JSONB impl here would declare a type the column does not have. The same
    alias trap is why `.astext` had to become `.as_string()` on
    `digital_prfs.form_data`.
    """

    impl = JSON
    cache_ok = True

    def process_bind_param(self, value: Any, dialect) -> Any:  # noqa: ARG002
        if not isinstance(value, dict):
            return value
        out = None
        for key in _EXTRACTED_ID_KEYS:
            raw = value.get(key)
            if raw in (None, ""):
                continue
            if out is None:
                out = dict(value)
            out[key] = encrypt_id(str(raw))
        return value if out is None else out

    def process_result_value(self, value: Any, dialect) -> Any:  # noqa: ARG002
        if not isinstance(value, dict):
            return value
        out = None
        for key in _EXTRACTED_ID_KEYS:
            raw = value.get(key)
            if raw in (None, ""):
                continue
            if out is None:
                out = dict(value)
            out[key] = decrypt_id(str(raw))
        return value if out is None else out


def register_patient_id_hash_sync() -> None:
    """Keep `Case.patient_id_hash` in step with `Case.patient_id_number`.

    A lookup column that anything can forget to update is a lookup column that
    silently stops finding records — and the failure mode here is a duplicate
    patient, not an error. So it is derived automatically on every insert and
    update rather than being the caller's responsibility.

    The listener runs BEFORE flush, while the attribute still holds plaintext:
    the column type only encrypts on the way to the database, so this sees the
    real number and can hash it.
    """
    from sqlalchemy import event, inspect as sa_inspect

    from app.models.case import Case
    from app.utils.patient_id import id_hash

    def _sync(mapper, connection, target):  # noqa: ARG001
        state = sa_inspect(target)
        # Only recompute when the number actually changed, so an unrelated
        # update never pays for a hash.
        if not state.attrs.patient_id_number.history.has_changes():
            return
        target.patient_id_hash = id_hash(target.patient_id_number)

    event.listen(Case, "before_insert", _sync)
    event.listen(Case, "before_update", _sync)
