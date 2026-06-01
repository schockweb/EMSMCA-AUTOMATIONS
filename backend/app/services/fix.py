from __future__ import annotations
import sys

correct_block = """        # ── Load & inject learned corrections (few-shot examples from human reviewers) ──
        learned_block = ""
        if db is not None:
            try:
                from app.api.corrections import _build_prompt_examples, _format_examples_for_prompt
                examples = await _build_prompt_examples(db)
                if examples:
                    learned_block = _format_examples_for_prompt(examples)
                    logger.info("[OCR] Injecting %d learned correction examples into prompt.", len(examples))
            except Exception as _corr_err:
                logger.warning("[OCR] Could not load learned corrections (non-fatal): %s", _corr_err)

        system_prompt = (
            "You are an Expert Medical Claims AI for South African EMS. "
            "Extract ALL structured data from the Patient Report Form (PRF) OCR text provided.\\n\\n"

            "## CRITICAL SA PRF LAYOUT RULES\\n"

            "### HEADER (top of form)\\n"
            "- Provider name, BHF Practice Number, PRF/form number.\\n"
            "- PRF number is the printed form ID (e.g. EMS0012556 or Re-C117343-E-01). Found top-left labelled 'PRF NR'.\\n"
            "- 'Practice No.' or 'Prac No.' labels in the header = bhf_practice_number.\\n\\n"

            "### PATIENT / SCHEME SECTION\\n"
            "- 'PT NAME & SURNAME', 'PT NAAM & VAN', 'PAT NAME', 'PAT. NAME', 'NAME OF PATIENT', 'NAAM/VAN', 'PN' = patient_name. Patient name = Main Member name if undefined.\\n"
            "- 'PT ID NR', 'ID NR', 'PAT ID' = patient_id_number; \\n"
            "- 'FUNDING DETAILS' = contains medical_scheme and scheme_option.\\n"
            "- 'MED AID REFERENCE NR' = member_number.\\n"
            "- 'NETCARE AUTH NR' = authorization_number / preauth_number.\\n"
            "\\n"
            "### HOSPITAL STICKER RULES (CRITICAL)\\n"
            "- A printed 'hospital sticker' is often placed haphazardly on the form (top corners, over other text).\\n"
            "- These stickers usually contain the BEST and most accurate Patient Name, DOB, Address, and Contact numbers.\\n"
            "- PRIORITY: Always prefer the typed hospital sticker data over handwritten data if there is a conflict.\\n"
            "- Scan the ENTIRE document text for any cluster of 10-digit numbers, names, or addresses that look like a sticker.\\n"
            "\\n"
            "### CONTACT NUMBER ABBREVIATIONS (SA PRF standard)\\n"
            "South African PRFs and Hospital Stickers use shorthand labels for phone numbers. Map ALL of the following to a contact number field:\\n"
            "  (H) or H: or H/W: = Home number\\n"
            "  (W) or W: or H/W: = Work number\\n"
            "  (B) or B: = Business number\\n"
            "  (C) or C: = Cell/Mobile number\\n"
            "  (M) or M: = Mobile/Cell number\\n"
            "  (T) or T: or TEL: = Telephone\\n"
            "  TEL, TELNR, TEL NR, TELEPHONE\\n"
            "  CEL, CELL, SELFOON, MOBIEL\\n"
            "  HUIS or HUISNR = Home (Afrikaans)\\n"
            "  WERK or WERKNR = Work (Afrikaans)\\n"
            "RULE: If a phone abbreviation appears anywhere on the form (ESPECIALLY on a hospital sticker), you MUST extract it. "
            "If it appears next to the patient details, put it in patient_phone. "
            "If it belongs to the parent/guardian or main member, put it in main_member_phone. "
            "NEVER skip a contact number. If only one number exists on the whole form (e.g. on a sticker), place it in BOTH patient_phone and main_member_phone.\\n"
            "\\n"
            "- DEPENDENT PATIENT RULE: If the patient is a child/minor or has a non-00 dependent_code, "
            "they typically do not have their own phone number on the PRF. "
            "In this case, extract the MAIN MEMBER's contact number into main_member_phone. "
            "Also copy that number into patient_phone so the field is not left blank. "
            "Never leave both blank if any contact number at all appears on the form.\\n\\n"
"""

target = "c:/Users/USER-PC/Desktop/New EMS AUTOMATIONS/backend/app/services/ocr_extraction.py"
with open(target, "r", encoding="utf-8") as f:
    text = f.read()

lines = text.split("\\n")
start_idx = 0
for i, l in enumerate(lines):
    if "[OCR] Phase 2: Strict Pydantic Structured Output extraction" in l:
        start_idx = i + 2
        break

end_idx = start_idx
for i in range(start_idx, len(lines)):
    if "### TIMES AND KILOMETRES TABLE" in lines[i]:
        end_idx = i - 1
        break

if start_idx > 0 and end_idx > start_idx:
    new_lines = lines[:start_idx] + correct_block.split("\\n") + lines[end_idx:]
    with open(target, "w", encoding="utf-8") as f:
        f.write("\\n".join(new_lines))
    print("Fixed!")
else:
    print("Could not find blocks")
