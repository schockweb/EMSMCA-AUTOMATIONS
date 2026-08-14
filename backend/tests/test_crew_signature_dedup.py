"""_drop_duplicated_crew_signature — remove the second copy, never the only copy.

Crew 1's signature was stored twice: in the `crew_signature` column and again in
form_data['crew_signoff_sigs']['c1']. On production 25 of 36 real records carried
both. The reader prefers the blob and falls back to the column, so dropping the
blob copy renders identically.

The risk this guards is the opposite case. These are signatures on a clinical
record: if the column is empty, or the two copies differ, the blob is the ONLY
evidence that a crew member signed, and removing it would be unrecoverable.
Every test below is about NOT deleting in those cases.
"""
from types import SimpleNamespace

from app.api.digital_prf import _drop_duplicated_crew_signature

SIG_A = "data:image/webp;base64,AAAAcrew1"
SIG_B = "data:image/webp;base64,BBBBcrew2"
SIG_OTHER = "data:image/webp;base64,ZZZZdifferent"


def prf(form_data, crew_signature):
    # SimpleNamespace stands in for the ORM object: the helper only touches
    # .form_data and .crew_signature, and a real DigitalPRF would drag the whole
    # encrypted-column machinery into a unit test for no benefit.
    return SimpleNamespace(form_data=form_data, crew_signature=crew_signature)


def test_drops_c1_when_identical_to_the_column():
    p = prf({"crew_signoff_sigs": {"c1": SIG_A, "c2": SIG_B}, "patient_name": "X"}, SIG_A)
    _drop_duplicated_crew_signature(p)
    assert "c1" not in p.form_data["crew_signoff_sigs"]
    # c2 has no column anywhere — it must survive untouched.
    assert p.form_data["crew_signoff_sigs"]["c2"] == SIG_B
    assert p.form_data["patient_name"] == "X"
    assert p.crew_signature == SIG_A          # the surviving copy


def test_keeps_c1_when_the_column_is_empty():
    # The blob is the only copy. Dropping it would destroy the signature.
    for empty in (None, ""):
        p = prf({"crew_signoff_sigs": {"c1": SIG_A}}, empty)
        _drop_duplicated_crew_signature(p)
        assert p.form_data["crew_signoff_sigs"]["c1"] == SIG_A


def test_keeps_c1_when_the_two_copies_differ():
    # Different bytes mean they are not the same signature; keep both and let a
    # human decide, rather than silently discarding one.
    p = prf({"crew_signoff_sigs": {"c1": SIG_A}}, SIG_OTHER)
    _drop_duplicated_crew_signature(p)
    assert p.form_data["crew_signoff_sigs"]["c1"] == SIG_A


def test_removes_the_container_when_c1_was_its_only_key():
    p = prf({"crew_signoff_sigs": {"c1": SIG_A}, "other": 1}, SIG_A)
    _drop_duplicated_crew_signature(p)
    assert "crew_signoff_sigs" not in p.form_data
    assert p.form_data["other"] == 1


def test_keeps_other_crew_keys_beside_c1():
    p = prf({"crew_signoff_sigs": {"c1": SIG_A, "c2": SIG_B, "c3": SIG_OTHER}}, SIG_A)
    _drop_duplicated_crew_signature(p)
    assert p.form_data["crew_signoff_sigs"] == {"c2": SIG_B, "c3": SIG_OTHER}


def test_reassigns_form_data_rather_than_mutating_it():
    # form_data is a plain JSON column: an in-place edit leaves no history for
    # SQLAlchemy to detect and the change would never reach the database.
    original = {"crew_signoff_sigs": {"c1": SIG_A, "c2": SIG_B}}
    p = prf(original, SIG_A)
    _drop_duplicated_crew_signature(p)
    assert p.form_data is not original
    assert original["crew_signoff_sigs"]["c1"] == SIG_A     # untouched


def test_tolerates_records_with_nothing_to_do():
    for fd in (None, {}, {"crew_signoff_sigs": None}, {"crew_signoff_sigs": "not-a-dict"},
               {"crew_signoff_sigs": {}}, {"patient_name": "X"}):
        p = prf(fd, SIG_A)
        _drop_duplicated_crew_signature(p)      # must not raise
