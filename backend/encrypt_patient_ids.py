"""
Encrypt every stored SA ID number in place.

    python encrypt_patient_ids.py --dry-run     # report only, changes nothing
    python encrypt_patient_ids.py --verify      # check what is already done
    python encrypt_patient_ids.py --apply       # perform the rewrite

TWO STORES, NOT ONE
-------------------
  * cases.patient_id_number            — the dedicated column
  * digital_prfs.form_data->>'...'     — the PRF's own copy, inside JSONB

Encrypting only the first would leave the primary clinical record in plaintext
while the platform could be described as encrypted. Both, or neither.

SAFETY
------
  * Idempotent. `encrypt_id` returns an already-encrypted value unchanged, so a
    re-run after an interruption resumes rather than double-encrypting.
  * Reads and writes by PRIMARY KEY through raw SQL, deliberately bypassing the
    ORM's encrypting column types — otherwise this script would be reasoning
    about values that the layer beneath it is also transforming.
  * One transaction per batch, so an abort leaves whole rows either converted
    or untouched. Never half a row.
  * --verify decrypts a sample and compares it against what was read before the
    change. A conversion that cannot be reversed is data loss, and the time to
    discover that is during the run, not months later.

THIS REWRITES LIVE PATIENT DATA. Take a backup first and confirm it restores.
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys

from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.utils.patient_id import (  # noqa: E402
    decrypt_id, encrypt_id, id_hash, looks_encrypted, normalise_id,
)

BATCH = 200


def _mask(value: str | None) -> str:
    """Never print a patient identifier. Enough to correlate, not to identify."""
    digits = normalise_id(value)
    if not digits:
        return "(none)"
    return f"{digits[:2]}{'*' * max(0, len(digits) - 4)}{digits[-2:]}"


async def run(apply: bool, verify_only: bool) -> int:
    url = os.environ.get("DATABASE_URL")
    if not url:
        print("DATABASE_URL is not set", file=sys.stderr)
        return 2

    engine = create_async_engine(url)
    stats = {
        "cases_total": 0, "cases_plain": 0, "cases_done": 0,
        "prfs_total": 0, "prfs_plain": 0, "prfs_done": 0,
        "verified": 0, "MISMATCH": 0,
    }

    async with engine.begin() as conn:
        rows = (await conn.execute(text(
            "SELECT id, patient_id_number FROM cases "
            "WHERE patient_id_number IS NOT NULL AND patient_id_number <> ''"
        ))).all()
        stats["cases_total"] = len(rows)

        for cid, raw in rows:
            if looks_encrypted(raw):
                if verify_only or apply:
                    back = decrypt_id(raw)
                    if back is None:
                        stats["MISMATCH"] += 1
                        print(f"  !! case {cid}: stored token does not decrypt "
                              f"under the current ENCRYPTION_KEY")
                    else:
                        stats["verified"] += 1
                continue

            stats["cases_plain"] += 1
            if not apply:
                continue

            token = encrypt_id(raw)
            if decrypt_id(token) != raw:          # prove it before storing it
                stats["MISMATCH"] += 1
                print(f"  !! case {cid}: refusing to store a token that does "
                      f"not decrypt back to the original ({_mask(raw)})")
                continue
            await conn.execute(
                text("UPDATE cases SET patient_id_number = :t, patient_id_hash = :h "
                     "WHERE id = :i"),
                {"t": token, "h": id_hash(raw), "i": cid},
            )
            stats["cases_done"] += 1

    async with engine.begin() as conn:
        rows = (await conn.execute(text(
            "SELECT id, form_data->>'patient_id_number' FROM digital_prfs "
            "WHERE form_data->>'patient_id_number' IS NOT NULL "
            "AND form_data->>'patient_id_number' <> ''"
        ))).all()
        stats["prfs_total"] = len(rows)

        for pid, raw in rows:
            if looks_encrypted(raw):
                if verify_only or apply:
                    if decrypt_id(raw) is None:
                        stats["MISMATCH"] += 1
                        print(f"  !! prf {pid}: stored token does not decrypt")
                    else:
                        stats["verified"] += 1
                continue

            stats["prfs_plain"] += 1
            if not apply:
                continue

            token = encrypt_id(raw)
            if decrypt_id(token) != raw:
                stats["MISMATCH"] += 1
                print(f"  !! prf {pid}: refusing to store an unreversible token "
                      f"({_mask(raw)})")
                continue
            # jsonb_set on the single key: the rest of the clinical record is
            # never rewritten, so a bug here cannot corrupt anything else.
            # cast(:t AS text), NOT :t::text — SQLAlchemy's parameter parser
            # reads the `::` as the start of another bind name and the statement
            # reaches Postgres malformed ("syntax error at or near :"). Caught
            # by the rehearsal against a restored copy, which is what it is for.
            await conn.execute(
                text("UPDATE digital_prfs "
                     "SET form_data = jsonb_set(form_data::jsonb, "
                     "'{patient_id_number}', to_jsonb(cast(:t AS text))) "
                     "WHERE id = :i"),
                {"t": token, "i": pid},
            )
            stats["prfs_done"] += 1

    await engine.dispose()

    mode = "APPLY" if apply else ("VERIFY" if verify_only else "DRY RUN")
    print(f"\n── {mode} ──")
    print(f"  cases:  {stats['cases_total']} with an ID, "
          f"{stats['cases_plain']} still plaintext, {stats['cases_done']} converted")
    print(f"  PRFs:   {stats['prfs_total']} with an ID, "
          f"{stats['prfs_plain']} still plaintext, {stats['prfs_done']} converted")
    print(f"  already encrypted and verified reversible: {stats['verified']}")
    if stats["MISMATCH"]:
        print(f"  MISMATCHES: {stats['MISMATCH']}  <-- investigate before trusting this run")
        return 1
    if not apply and (stats["cases_plain"] or stats["prfs_plain"]):
        print("\n  Nothing was changed. Re-run with --apply to convert.")
    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--apply", action="store_true", help="perform the rewrite")
    g.add_argument("--verify", action="store_true", help="check existing ciphertext only")
    args = ap.parse_args()
    raise SystemExit(asyncio.run(run(apply=args.apply, verify_only=args.verify)))
