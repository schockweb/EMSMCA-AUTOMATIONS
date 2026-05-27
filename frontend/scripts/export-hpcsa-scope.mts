/**
 * Export the HPCSA scope matrix as JSON for the backend rule engine.
 *
 * Why this script exists:
 *   The matrix is authored + edited in TypeScript at
 *   `frontend/src/data/hpcsaScope.ts` so the crew UI gets type-checked
 *   capability keys, autocomplete in the IDE, and inline comments documenting
 *   each row's provenance. But the backend rule engine (Python) also needs the
 *   same matrix to enforce scope on PRF submit (Phase 5a — defence in depth).
 *   This script is the single bridge: it imports the TS source and writes a
 *   JSON mirror that Python loads at startup. Run it whenever the TS matrix
 *   changes. A CI check that re-runs this and fails on diff would prevent
 *   drift, but isn't wired up yet.
 *
 * Usage:
 *   cd frontend
 *   node --experimental-strip-types scripts/export-hpcsa-scope.mts
 *
 * Output: backend/app/data/hpcsa_scope.json
 */
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HPCSA_SCOPE,
  FORM_LABEL_TO_CAPABILITY,
  CONSULTATION_REQUIRED,
} from '../src/data/hpcsaScope.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT = resolve(__dirname, '../../backend/app/data/hpcsa_scope.json');

// Flatten the section→capabilities tree into a flat dict keyed by capability
// key — Python lookups stay O(1) and the section name travels along on each
// row for grouping in error messages.
const capabilities: Record<string, {
  label: string;
  section: string;
  authorised: string[];
  forbidden: boolean;
  conditions: Record<string, string>;
  note: string | null;
}> = {};

for (const section of HPCSA_SCOPE) {
  for (const cap of section.capabilities) {
    capabilities[cap.key] = {
      label: cap.label,
      section: section.name,
      authorised: [...cap.authorised],
      forbidden: cap.forbidden ?? false,
      conditions: cap.conditions ? { ...cap.conditions } as Record<string, string> : {},
      note: cap.note ?? null,
    };
  }
}

const payload = {
  // Bump when the JSON shape changes — the backend reader can fail fast if it
  // sees a version it doesn't understand.
  version: 1,
  generated_from: 'frontend/src/data/hpcsaScope.ts',
  generated_note: 'DO NOT EDIT BY HAND — run `node --experimental-strip-types frontend/scripts/export-hpcsa-scope.mts` to regenerate.',
  consultation_required_text: CONSULTATION_REQUIRED,
  form_label_to_capability: { ...FORM_LABEL_TO_CAPABILITY },
  capabilities,
};

writeFileSync(OUTPUT, JSON.stringify(payload, null, 2) + '\n', 'utf8');

const capCount = Object.keys(capabilities).length;
const medCount = Object.values(capabilities).filter(c => c.section.startsWith('List of Medications')).length;
const formCount = Object.keys(payload.form_label_to_capability).length;
console.log(`HPCSA scope exported → ${OUTPUT}`);
console.log(`  ${capCount} capabilities total (${medCount} medications), ${formCount} form-label mappings.`);
