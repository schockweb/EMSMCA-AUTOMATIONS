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
    """The PRF form blob, with just the ID number encrypted inside it.

    Only that one key is transformed. Encrypting the whole blob would make the
    record unqueryable and unindexable, and would put the clinical narrative
    — which staff legitimately search — behind a decrypt on every read.
    """

    impl = JSON
    cache_ok = True

    def process_bind_param(self, value: Any, dialect) -> Any:  # noqa: ARG002
        if not isinstance(value, dict):
            return value
        raw = value.get(PATIENT_ID_KEY)
        if raw in (None, ""):
            return value
        # str(): the ID arrives as an int from some OCR paths, and a numeric SA
        # ID reaching .encode() would raise and fail the whole save.
        return {**value, PATIENT_ID_KEY: encrypt_id(str(raw))}

    def process_result_value(self, value: Any, dialect) -> Any:  # noqa: ARG002
        if not isinstance(value, dict):
            return value
        raw = value.get(PATIENT_ID_KEY)
        if raw in (None, ""):
            return value
        return {**value, PATIENT_ID_KEY: decrypt_id(str(raw))}


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
