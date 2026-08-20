#!/usr/bin/env python3
"""Generate one HTML email signature per staff member.

Reads:  brand.json, staff.csv, 03-email-signatures/template/signature.html
Writes: 03-email-signatures/generated/<slug>.htm

Run from the project root:  python3 scripts/build_signatures.py
"""
import csv
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
BRAND = ROOT / "brand.json"
STAFF = ROOT / "staff.csv"
TPL = ROOT / "03-email-signatures" / "template" / "signature.html"
DISC = ROOT / "03-email-signatures" / "template" / "disclaimer.txt"
OUT = ROOT / "03-email-signatures" / "generated"


def tel(raw):
    """Strip a phone number to a tel: href-safe form."""
    return re.sub(r"[^\d+]", "", raw or "")


def main():
    for p in (BRAND, STAFF, TPL):
        if not p.exists():
            sys.exit("missing required file: %s" % p.relative_to(ROOT))

    brand = json.loads(BRAND.read_text(encoding="utf-8"))
    # Strip HTML comments: authoring notes must never ship inside a signature.
    tpl = re.sub(r"<!--.*?-->", "", TPL.read_text(encoding="utf-8"), flags=re.S).lstrip()
    disclaimer = DISC.read_text(encoding="utf-8").strip() if DISC.exists() else ""
    disclaimer = disclaimer.replace("{{legal_name}}", brand["client"]["legalName"])

    c, ct, col = brand["client"], brand["contact"], brand["colour"]
    addr = ct["address"]
    address_line = ", ".join(
        x for x in (addr["line1"], addr["line2"], addr["city"], addr["postalCode"]) if x
    )

    base = {
        "trading_name": c["tradingName"],
        "legal_name": c["legalName"],
        "domain": c["domain"],
        "url": c["url"],
        "logo_url": brand["logo"]["emailPng"],
        "primary": col["primary"]["hex"],
        "accent": col["accent"]["hex"],
        "ink": col["ink"]["hex"],
        "muted": col["muted"]["hex"],
        "line": col["line"]["hex"],
        "font_stack": brand["type"]["fallbackBody"],
        "address_line": address_line,
        "disclaimer": disclaimer,
    }

    OUT.mkdir(parents=True, exist_ok=True)
    for stale in OUT.glob("*.htm"):
        stale.unlink()

    count = 0
    with STAFF.open(encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            if not row.get("slug"):
                continue
            direct = (row.get("directLine") or "").strip()
            direct_block = ""
            if direct:
                direct_block = (
                    '&nbsp;&nbsp;<span style="color:%s;">T</span> '
                    '<a href="tel:%s" style="color:%s;text-decoration:none;">%s</a>'
                    % (base["muted"], tel(direct), base["ink"], direct)
                )

            vals = dict(base)
            vals.update({
                "full_name": row["fullName"].strip(),
                "title": row["title"].strip(),
                "email": row["email"].strip(),
                "mobile": (row.get("mobile") or "").strip(),
                "mobile_raw": tel(row.get("mobile")),
                "direct_line_block": direct_block,
                "card_url": "%s/card/%s" % (c["url"].rstrip("/"), row["slug"].strip()),
            })

            html = tpl
            for k, v in vals.items():
                html = html.replace("{{%s}}" % k, str(v))

            left = re.findall(r"\{\{(\w+)\}\}", html)
            if left:
                sys.exit("unreplaced placeholder(s) %s for %s" % (sorted(set(left)), row["slug"]))

            (OUT / ("%s.htm" % row["slug"].strip())).write_text(html, encoding="utf-8")
            count += 1

    print("generated %d signature(s) in %s" % (count, OUT.relative_to(ROOT)))
    print("Test in BOTH Outlook and Gmail before delivery — they render differently.")


if __name__ == "__main__":
    main()
