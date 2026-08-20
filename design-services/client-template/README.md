# Client project template — branding & website

Copy this whole folder for each new client and rename it, e.g. `2026-03-acme/`.
Everything downstream is generated from two files, so the second job takes a
fraction of the time of the first.

## The one rule

**`brand.json` and `staff.csv` are the single source of truth.**

Colours, fonts, contact details and staff live there and nowhere else. The
website, the email signatures and the virtual business cards all read from them.
Change a phone number in `brand.json`, run `scripts/sync.sh`, and it updates in
every deliverable at once. If you hard-code a hex value or a phone number
anywhere else, you have created a bug that will surface six months later when
the client changes their number.

## First-time setup

    pip install -r scripts/requirements.txt
    cd 04-website/site && npm install && cd ../..

## Daily loop

    # 1. edit brand.json and/or staff.csv
    ./scripts/sync.sh                    # regenerates everything
    cd 04-website/site && npm run dev    # preview at localhost:4321

## Folder map

| Folder | Contents |
|---|---|
| `00-admin/` | Completed brief, quote, signed contract, invoices |
| `01-brand/` | Logo source and exports (RGB **and** CMYK), brand guide |
| `02-stationery/` | Letterhead, cards, with-compliments, quote/invoice templates |
| `03-email-signatures/` | Template, generated `.htm` files, client install guide |
| `04-website/site/` | The Astro website |
| `05-virtual-cards/` | Generated `.vcf` contact files and QR codes |
| `06-assets/` | Photography, icons, and **proof of licence for every asset** |
| `07-delivery/` | The final handover pack |
| `scripts/` | Generators — do not edit generated output by hand |

## What each script does

| Script | Reads | Writes |
|---|---|---|
| `scripts/sync.sh` | everything | runs the two below, plus copies data into the site |
| `scripts/build_signatures.py` | `brand.json`, `staff.csv`, signature template | `03-email-signatures/generated/*.htm` |
| `scripts/build_cards.py` | `brand.json`, `staff.csv` | `.vcf` + QR codes, and copies `.vcf` into the site |

Generated files are overwritten on every run. Never edit them directly.

## How the pieces connect

    brand.json ─┬─→ website CSS custom properties
                ├─→ email signature colours and contact block
                └─→ vCard organisation and address fields

    staff.csv ──┬─→ one signature .htm per person
                ├─→ one .vcf + QR code per person
                └─→ one /card/<slug> page per person

    QR code → https://client.co.za/card/jane-doe → "Save to contacts" → .vcf

The QR encodes the **page URL**, not the contact data. A job title can change
without reprinting a single card.

## Non-negotiables before handover

- [ ] Logo exported in **CMYK** for anything going to a printer. Screen RGB
      prints muddy and the printer will reject the file.
- [ ] Every font is Google Fonts, or a licence is filed in `06-assets/licences/`.
- [ ] Every photograph has its licence filed in `06-assets/licences/`.
- [ ] Signatures tested in **both** Outlook and Gmail — they render differently.
- [ ] Website live **before** business cards go to print, or the QR codes 404.
- [ ] The contact form is wired to a real handler. An unconnected form that
      silently swallows enquiries is worse than no form.
- [ ] `07-delivery/HANDOVER.md` completed and the handover pack assembled.
