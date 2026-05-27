# `app/rules/` — Hardcoded Scheme Rules & Tariffs

This package is the single source of truth for billing rules, tariff codes,
and scheme-specific logic. Every rule lives in code, is version-controlled,
diff-reviewable, and impossible to silently mutate via an admin UI or an AI
pipeline.

## Layout

```
app/rules/
├── base.py       Shared dataclasses, enums, and global constants.
├── __init__.py   Scheme-name registry + fuzzy dispatcher.
├── gems.py       GEMS tariffs + rules (the only scheme wired up today).
└── README.md     This file.
```

## How it's consumed

- **`app/services/rule_engine.py`** calls `get_rules_for_scheme(name)` and
  evaluates the returned module's `RULES` against the claim context.
- **`app/services/tariff_engine.py`** calls the same resolver, then uses
  `module.all_base_rates()`, `module.mileage_row(level, loaded)`, etc. to
  price each claim line.
- **`app/services/adjudication_engine.py`** reads global thresholds
  (`REQUIRE_PATIENT_ID`, `IHT_REQUIRES_REFERRING_DR`, etc.) from `base.py`.

## Adding a new scheme

1. Create `app/rules/{scheme_id}.py` following the shape of `gems.py`.
2. Populate `SCHEME_ID`, `SCHEME_KEYWORDS`, `PAYER_TYPE`, `TARIFFS`, `RULES`,
   `EXCLUSIONS`, `PREAUTH_CPT_CODES`, and the accessor helpers
   (`all_base_rates`, `all_mileage`, `mileage_row`, `base_rates_for_level`).
3. Register it in `__init__.py`:
   ```python
   from app.rules import bonitas as _bonitas
   register(_bonitas.SCHEME_ID, _bonitas)
   ```
4. Add env vars for the scheme's B2B API credentials, prefixed
   `SCHEME_{SCHEME_ID.upper()}_*` — see `app/config.py::get_scheme_credentials`.
5. Add regression tests in `tests/test_rules_{scheme_id}.py` covering the
   five billing modes: primary <100 km, primary ≥100 km, IFT, multi-patient,
   no-transport call-out.

## Updating rates

Rate changes are **code releases**. The workflow is:

1. Edit the `primary_rate` / `iht_rate` fields in the relevant scheme module.
2. Update the spot-check assertions in `tests/test_rules_{scheme_id}_sanity.py`.
3. Run the full regression suite (`pytest tests/test_rules_*`).
4. Open a PR. Reviewer compares the diff against the authoritative rate card.
5. Merge → deploy.

**Why not a CSV import?** The previous design had a CSV-import UI. In
practice, anyone with admin access could rewrite tariffs without code review,
and AI-extracted rates occasionally hallucinated into the table. Forcing
changes through code review gives us: diff history, PR approval, blame, and
CI-gated sanity tests.

## Description-string contract

The tariff engine matches rows by keyword phrases embedded in descriptions:

| Engine lookup | Required phrase |
|---|---|
| Base rate (time billing, ILS/BLS) | `up to 45` |
| Base rate (time billing, ALS) | `up to 60` |
| Time extension (all levels) | `every 15` |
| Call-out fee (IFT) | `call out fee` |
| Loaded mileage | `with patient` or `loaded` |
| Unloaded mileage | `without patient`, `unloaded`, or `callout` |
| Level filter | `[ALS]` / `[ILS]` / `[BLS]` bracket tag |

**Do not paraphrase** descriptions. If you rename "Up to 45 min" to "Within
45 minutes", the engine stops finding the row and falls back — silently
misbilling. Update the engine's keyword list and the tariff description in
the same PR.
