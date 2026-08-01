/**
 * The crew on this shift, as the DEVICE knows them.
 *
 * WHY THIS EXISTS
 * ---------------
 * Everything the PRF form knows about Crew 2 came from `prfMeta` — the server
 * row, fetched by GET /api/digital-prf/{id}. A PRF started with no signal has
 * no server row at all, so that fetch cannot succeed and `prfMeta` stays `{}`.
 * The consequences were silent and clinical:
 *
 *   • the end-of-call sign-off list contained ONLY Crew 1, so the second
 *     practitioner was never asked to sign a document they are named on;
 *   • Crew 2 was missing from the treating-practitioner / IV / medication
 *     picker, so no procedure could be attributed to them — and HPCSA scope
 *     enforcement keys off that attribution.
 *
 * The device already knows who the partner is: shift start stores the roster in
 * localStorage. This module reads it back in one normalised shape.
 *
 * IDENTITY IS MATCHED BY ID, NEVER "WHOEVER IS STORED NOW"
 * -------------------------------------------------------
 * The roster changes during a shift (crew swap at handover, a third member
 * added). Falling back to whoever happens to be stored would print the wrong
 * practitioner's name and HPCSA number onto an earlier call's legal record and
 * ask them to sign it. So a lookup only resolves when the id matches; an
 * unknown id yields null and the form behaves as it does today.
 */
import { CREW_SESSION_KEYS } from '../../utils/crewSession';

/** A crew member in the shape the PRF form expects (mirrors the server's
 *  nested `crew_member_2` object, so callers can treat both alike). */
export interface LocalCrewRef {
  id?: string;
  full_name: string;
  qualification?: string;
  hpcsa_number?: string | null;
}

function readJson(key: string): any {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null');
  } catch {
    return null;
  }
}

/**
 * Normalise a stored profile.
 *
 * The writers disagree on the name field: `saveShiftSession` declares
 * `CrewMemberProfile` with both `name` and `full_name`, while the dashboard's
 * own crew lookup writes `{ id, name, hpcsa_number, qualification }` with no
 * `full_name` at all. The PRF form read `.full_name` — so its existing offline
 * fallback resolved to undefined every time and quietly did nothing. Accept
 * either.
 */
function toRef(raw: any): LocalCrewRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const full = String(raw.full_name || raw.name || '').trim();
  if (!full) return null;
  return {
    id: raw.id || undefined,
    full_name: full,
    qualification: raw.qualification || undefined,
    hpcsa_number: raw.hpcsa_number ?? null,
  };
}

/**
 * Everyone on the current shift besides Crew 1, partner first.
 *
 * `crew2_profile` is a mirror of `extra_crew_profiles[0]` kept for the create
 * payload (which still sends a single `crew_member_2_id`), so the two overlap
 * by design — de-duplicated here.
 */
export function shiftCrew(): LocalCrewRef[] {
  const extras = readJson(CREW_SESSION_KEYS.extraCrew);
  const raw = [
    readJson(CREW_SESSION_KEYS.partner),
    ...(Array.isArray(extras) ? extras : []),
  ];

  const out: LocalCrewRef[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const ref = toRef(entry);
    if (!ref) continue;
    const key = ref.id || `name:${ref.full_name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

/**
 * Resolve a crew member id against this device's shift roster.
 *
 * Returns null for an unknown id — see the identity note at the top of the
 * file. Null means "this device cannot vouch for who that is", which is the
 * only safe answer for a name that goes onto a signed clinical record.
 */
export function crewMemberById(id: string | null | undefined): LocalCrewRef | null {
  if (!id) return null;
  return shiftCrew().find(c => c.id === id) || null;
}
