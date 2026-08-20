#!/usr/bin/env python3
"""Generate a .vcf contact file and a QR code per staff member.

Reads:  brand.json, staff.csv
Writes: 05-virtual-cards/vcf/<slug>.vcf   — the downloadable contact file
        05-virtual-cards/qr/<slug>.svg    — QR pointing at <url>/card/<slug>
        05-virtual-cards/qr/<slug>.png    — same, for print
        04-website/site/public/card/<slug>.vcf  — served by the website

The QR encodes the card PAGE URL, not the vCard itself: a URL survives a
change of job title without reprinting anything, and it works on every
phone camera. Never route these through a third-party QR shortener —
printed cards outlive free tiers.
"""
import csv
import json
import pathlib
import sys

try:
    import segno
except ImportError:
    sys.exit("segno is not installed.  pip install segno")

ROOT = pathlib.Path(__file__).resolve().parent.parent
BRAND = ROOT / "brand.json"
STAFF = ROOT / "staff.csv"
VCF = ROOT / "05-virtual-cards" / "vcf"
QR = ROOT / "05-virtual-cards" / "qr"
WEB = ROOT / "04-website" / "site" / "public" / "card"


def esc(v):
    """Escape a value for a vCard property (RFC 6350 §3.4)."""
    return (str(v or "").replace("\\", "\\\\").replace(";", "\;")
            .replace(",", "\\,").replace("\n", "\\n"))


def vcard(row, brand):
    c, ct = brand["client"], brand["contact"]
    a = ct["address"]
    full = row["fullName"].strip()
    parts = full.split()
    given = row.get("firstName", "").strip() or (parts[0] if parts else "")
    family = " ".join(parts[1:]) if len(parts) > 1 else ""

    lines = [
        "BEGIN:VCARD",
        "VERSION:3.0",
        "N:%s;%s;;;" % (esc(family), esc(given)),
        "FN:%s" % esc(full),
        "ORG:%s" % esc(c["tradingName"]),
        "TITLE:%s" % esc(row["title"].strip()),
        "EMAIL;type=INTERNET;type=WORK:%s" % esc(row["email"].strip()),
    ]
    if row.get("mobile"):
        lines.append("TEL;type=CELL;type=VOICE:%s" % esc(row["mobile"].strip()))
    if row.get("directLine"):
        lines.append("TEL;type=WORK;type=VOICE:%s" % esc(row["directLine"].strip()))
    lines += [
        "ADR;type=WORK:;;%s %s;%s;%s;%s;%s" % (
            esc(a["line1"]), esc(a["line2"]), esc(a["city"]),
            esc(a["province"]), esc(a["postalCode"]), esc(a["country"])),
        "URL:%s" % esc(c["url"]),
        "URL;type=CARD:%s/card/%s" % (esc(c["url"].rstrip("/")), esc(row["slug"].strip())),
        "END:VCARD",
    ]
    # vCard requires CRLF line endings; some iOS versions reject LF-only files.
    return "\r\n".join(lines) + "\r\n"


def main():
    brand = json.loads(BRAND.read_text(encoding="utf-8"))
    base = brand["client"]["url"].rstrip("/")
    dark = brand["colour"]["primary"]["hex"]

    for d in (VCF, QR, WEB):
        d.mkdir(parents=True, exist_ok=True)

    count = 0
    with STAFF.open(encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            slug = (row.get("slug") or "").strip()
            if not slug:
                continue
            card = vcard(row, brand)
            (VCF / ("%s.vcf" % slug)).write_text(card, encoding="utf-8", newline="")
            (WEB / ("%s.vcf" % slug)).write_text(card, encoding="utf-8", newline="")

            # error correction 'h' survives a logo overlay and a scuffed card
            q = segno.make("%s/card/%s" % (base, slug), error="h")
            q.save(str(QR / ("%s.svg" % slug)), scale=8, border=2, dark=dark)
            q.save(str(QR / ("%s.png" % slug)), scale=12, border=2, dark=dark)
            count += 1

    print("generated %d card(s): .vcf + QR (svg/png)" % count)
    print("QR codes point at %s/card/<slug> — publish the site before printing." % base)


if __name__ == "__main__":
    main()
