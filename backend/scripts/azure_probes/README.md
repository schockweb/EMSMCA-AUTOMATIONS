# Azure probe scripts

Ad-hoc scripts for poking Azure Document Intelligence / OpenAI by hand. They are
NOT tests: they hit live endpoints, need real credentials, and assert nothing.

They used to live in `backend/tests/`, where pytest tried to collect them. One
(`test_azure_ocr2.py`) is UTF-16 encoded, so collection aborted with
"source code string cannot contain null bytes" — and because CI ran pytest with
`-x`, that single file failed the entire backend test job. Combined with a
`needs: lint` gate that was already failing, the backend suite had never run on
any commit.

Moved here so pytest ignores them. The OCR intake they exercise is disabled
(`OCR_INTAKE_ENABLED=False`).
