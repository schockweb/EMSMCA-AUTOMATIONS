#!/usr/bin/env bash
# Push brand.json and staff.csv into the website, then regenerate
# every derived artefact. Run after ANY edit to brand.json or staff.csv.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "→ syncing brand.json into the website"
cp brand.json 04-website/site/src/data/brand.json

echo "→ converting staff.csv to staff.json"
python3 - <<'PY'
import csv, json, pathlib
rows = [r for r in csv.DictReader(open("staff.csv", encoding="utf-8-sig")) if r.get("slug")]
pathlib.Path("04-website/site/src/data/staff.json").write_text(json.dumps(rows, indent=2), encoding="utf-8")
print("   %d staff member(s)" % len(rows))
PY

echo "→ generating email signatures"
python3 scripts/build_signatures.py

echo "→ generating vCards and QR codes"
python3 scripts/build_cards.py

echo
echo "Done. Now run:  cd 04-website/site && npm run dev"
