# Design services

Client-facing design and web work. Unrelated to the claims ingestion
application — kept in its own folder so the two never entangle.

| Path | What it is |
|---|---|
| `Project-Brief-Scoping-Form.pdf` | Fillable 2-page client scoping form (63 tick boxes, 21 text fields) |
| `build_scoping_form.py` | Regenerates the form above. `pip install reportlab && python3 build_scoping_form.py` |
| `client-template/` | Per-client project template — copy and rename for each new job |

Start with `client-template/README.md`.
