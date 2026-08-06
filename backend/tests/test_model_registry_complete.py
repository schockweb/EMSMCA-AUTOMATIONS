"""Every ORM model must be reachable from `Base.metadata`.

WHY THIS EXISTS
---------------
`bootstrap_schema.py` builds a brand-new instance's schema from
`Base.metadata.create_all()` and then stamps Alembic at head WITHOUT running
the migrations. That is deliberate — the initial revision cannot build the
schema from nothing. The consequence is that a table which only a MIGRATION
knows about is silently absent on every fresh install.

That is exactly what happened to `system_faults`: migration f7c1a9e35b84
created it in raw DDL, and `app/models/__init__.py` never imported
`app.models.system_fault`, so the model was not in `Base.metadata`. Existing
installs had the table and a fresh one did not — the fault monitor would have
written to a table that does not exist, on a new box where nobody is watching
yet and the fault monitor is the thing you are relying on.

Nothing failed loudly. The schema looked complete, the app booted, and the
tests passed, because every environment that had ever run the migration had
the table. Only a clean-database rehearsal surfaced it.

HOW IT IS CHECKED — read this before "simplifying" it
-----------------------------------------------------
The obvious implementation does not work, and it took a mutation test to
notice. Walking the package with `importlib.import_module()` and then asking
whether each class is in `Base.metadata` ALWAYS passes: importing the module
is itself what registers the model. Deleting the import from
`app/models/__init__.py` left that version of this test green.

So the two sides are gathered by methods that cannot contaminate each other:

  * DECLARED  — parsed out of the files with `ast`. No import, no side effect.
  * REGISTERED — collected in a SUBPROCESS that imports only `app.models`,
    so this test process (where conftest and other tests have imported all
    sorts of things) cannot supply a table the package itself would not.

Verified by mutation: commenting out the `system_fault` import in
`app/models/__init__.py` fails both tests below.
"""
from __future__ import annotations

import ast
import json
import pathlib
import subprocess
import sys

MODELS_DIR = pathlib.Path(__file__).resolve().parents[1] / "app" / "models"


def _declared_tables() -> dict[str, str]:
    """{tablename: source file} for every `__tablename__` in the model files.

    Parsed, never imported — importing is what would mask the defect.
    """
    declared: dict[str, str] = {}
    for path in sorted(MODELS_DIR.glob("*.py")):
        if path.name == "__init__.py":
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if not isinstance(node, ast.ClassDef):
                continue
            for stmt in node.body:
                if not isinstance(stmt, ast.Assign):
                    continue
                for target in stmt.targets:
                    if (
                        isinstance(target, ast.Name)
                        and target.id == "__tablename__"
                        and isinstance(stmt.value, ast.Constant)
                        and isinstance(stmt.value.value, str)
                    ):
                        declared[stmt.value.value] = path.name
    return declared


def _registered_tables() -> set[str]:
    """Tables in Base.metadata after importing ONLY `app.models`.

    Runs in a subprocess on purpose: in-process, whatever the rest of the test
    session has already imported would count as "registered" and the check
    would pass no matter what `app/models/__init__.py` contains.
    """
    code = (
        "import json, app.models;"
        " from app.database import Base;"
        " print(json.dumps(sorted(Base.metadata.tables)))"
    )
    proc = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        text=True,
        cwd=str(MODELS_DIR.parents[1]),
    )
    assert proc.returncode == 0, f"importing app.models failed:\n{proc.stderr[-2000:]}"
    return set(json.loads(proc.stdout.strip().splitlines()[-1]))


def test_every_declared_model_is_registered_in_metadata():
    """A model file nobody imports is invisible to create_all()."""
    declared = _declared_tables()
    registered = _registered_tables()

    missing = {t: f for t, f in declared.items() if t not in registered}

    assert not missing, (
        "These tables are declared by a model file but are NOT in "
        "Base.metadata, so bootstrap_schema.py would not create them on a "
        "fresh install:\n  "
        + "\n  ".join(f"{t}  (declared in app/models/{f})" for t, f in sorted(missing.items()))
        + "\n\nFix: import the model in app/models/__init__.py."
    )


def test_system_faults_specifically_is_registered():
    """The regression that motivated this file.

    Named separately so a failure says what broke rather than appearing as one
    line in the list above.
    """
    assert "system_faults" in _registered_tables(), (
        "system_faults is missing from Base.metadata — a fresh install would "
        "have no table for the fault monitor to write to. Import "
        "app.models.system_fault in app/models/__init__.py."
    )
