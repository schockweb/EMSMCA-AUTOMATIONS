/**
 * Crew session storage — the single source of truth for the crew_token /
 * crew_profile family of localStorage keys.
 *
 * These keys are written when a crew member logs in (company-portal admin
 * login) or starts a shift, and read by the crew-side pages (ProviderLogin,
 * CrewDashboard, ProviderAdminDashboard, DigitalPRFForm). Historically each
 * writer hand-rolled the key strings and JSON shapes inline, which made it easy
 * for a writer and a reader to silently drift out of sync. Centralize the WRITE
 * path here so every writer agrees on the exact key names and object shapes.
 *
 * NOTE: crew pages authenticate with crew_token as an explicit Bearer header on
 * raw axios — never through the admin api/client interceptor. This module only
 * touches localStorage; it makes no network calls.
 */

export const CREW_SESSION_KEYS = {
  token: 'crew_token',
  profile: 'crew_profile',
  partner: 'crew2_profile',
  extraCrew: 'extra_crew_profiles',
  vehicle: 'active_vehicle',
} as const;

/** The primary crew member's session profile. */
export interface CrewProfile {
  id: string;
  name: string;
  provider_id: string;
  provider_name: string;
  provider_slug: string;
  qualification: string;
  hpcsa_number: string | null;
  role: string;
  // Present only on the shift-start path.
  partner_name?: string;
  vehicle_id?: string;
  vehicle_callsign?: string;
}

/** A secondary/assisting crew member stored for the PRF form + dashboard. */
export interface CrewMemberProfile {
  id: string;
  name: string;
  full_name: string;
  hpcsa_number: string | null;
  qualification: string;
}

/** The vehicle selected for the active shift. */
export interface ActiveVehicle {
  id: string;
  callsign: string;
  registration: string;
  vehicle_type: string;
}

export function getCrewToken(): string | null {
  return localStorage.getItem(CREW_SESSION_KEYS.token);
}

export function getCrewProfile(): Record<string, any> {
  try {
    return JSON.parse(localStorage.getItem(CREW_SESSION_KEYS.profile) || '{}');
  } catch {
    return {};
  }
}

/**
 * Clear the crew_token / crew_profile family. Only the five session keys owned
 * by this module are removed — callers that also track their own extra keys
 * (e.g. last_prf_id, shift_supervisor) must clear those themselves.
 */
/**
 * Tenant guard for every crew-side page. The URL's provider slug is
 * AUTHORITATIVE: if the stored crew session belongs to a DIFFERENT provider,
 * the session is stale/foreign and is wiped on the spot — Provider A's data
 * must never render under Provider B's URL, and a leftover login must never
 * teleport the user between providers' portals.
 *
 * Call at the very top of a crew page's render, BEFORE reading the profile:
 *     if (!ensureProviderSession(providerSlug)) →  no usable session for this
 *     provider (absent or just wiped) — send the user to `/${slug}/login`.
 */
export function ensureProviderSession(urlSlug: string | undefined): boolean {
  const prof = getCrewProfile();
  if (urlSlug && prof?.provider_slug && prof.provider_slug !== urlSlug) {
    clearCrewSession();
    // Companion per-shift keys that would otherwise leak between providers.
    try {
      localStorage.removeItem('last_prf_id');
      localStorage.removeItem('shift_supervisor');
    } catch { /* storage unavailable — nothing to clear */ }
    return false;
  }
  return !!getCrewToken();
}

/**
 * Clear the crew's session keys ONLY.
 *
 * Deliberately does NOT touch the `prf-draft:` keys or the IndexedDB outbox.
 * This runs on session expiry (a 401) and on foreign-provider detection, and in
 * both cases the unsynced work must SURVIVE: the crew logs back in and the
 * outbox drains. Purging here would destroy patient records captured at a scene
 * — the failure mode fixed in b69ea03.
 *
 * Device-wide patient data is cleared in exactly one place, End Shift
 * (CrewDashboard.handleLogout), which is a deliberate end-of-duty action, tells
 * the crew how many records are unsent, and asks twice. A different provider
 * logging in is handled by syncEngine refusing to DRAIN a foreign entry, not by
 * deleting it.
 */
export function clearCrewSession(): void {
  localStorage.removeItem(CREW_SESSION_KEYS.token);
  localStorage.removeItem(CREW_SESSION_KEYS.profile);
  localStorage.removeItem(CREW_SESSION_KEYS.partner);
  localStorage.removeItem(CREW_SESSION_KEYS.extraCrew);
  localStorage.removeItem(CREW_SESSION_KEYS.vehicle);
}

/**
 * Persist a company-portal admin login. No shift context (no partner / vehicle),
 * so any stale shift keys from a previous session are intentionally left as-is —
 * the admin dashboard does not read them.
 */
export function saveAdminSession(data: {
  access_token: string;
  crew_id: string;
  crew_name: string;
  provider_id: string;
  provider_name: string;
  provider_slug: string;
  qualification: string;
  hpcsa_number: string | null;
  role: string;
}): void {
  localStorage.setItem(CREW_SESSION_KEYS.token, data.access_token);
  localStorage.setItem(
    CREW_SESSION_KEYS.profile,
    JSON.stringify({
      id: data.crew_id,
      name: data.crew_name,
      provider_id: data.provider_id,
      provider_name: data.provider_name,
      provider_slug: data.provider_slug,
      qualification: data.qualification,
      hpcsa_number: data.hpcsa_number,
      role: data.role,
    }),
  );
}

/**
 * Persist a crew shift-start. Writes the token + primary profile, and mirrors
 * the assisting crew + vehicle exactly as the crew dashboard and PRF form expect
 * to read them: the first assisting member is duplicated into `crew2_profile`
 * for backend hand-off, while the full assisting list lives in
 * `extra_crew_profiles` for the UI. Passing `partner: null` / `extraCrew: []`
 * removes those keys so a solo shift doesn't inherit a previous partner.
 */
export function saveShiftSession(params: {
  token: string;
  profile: CrewProfile;
  partner: CrewMemberProfile | null;
  extraCrew: CrewMemberProfile[];
  vehicle: ActiveVehicle | null;
}): void {
  const { token, profile, partner, extraCrew, vehicle } = params;

  localStorage.setItem(CREW_SESSION_KEYS.token, token);
  localStorage.setItem(CREW_SESSION_KEYS.profile, JSON.stringify(profile));

  if (partner) {
    localStorage.setItem(CREW_SESSION_KEYS.partner, JSON.stringify(partner));
  } else {
    localStorage.removeItem(CREW_SESSION_KEYS.partner);
  }

  if (extraCrew.length > 0) {
    localStorage.setItem(CREW_SESSION_KEYS.extraCrew, JSON.stringify(extraCrew));
  } else {
    localStorage.removeItem(CREW_SESSION_KEYS.extraCrew);
  }

  // Only set when a vehicle was chosen — matches the previous inline behaviour,
  // which left any existing active_vehicle untouched on a vehicle-less start.
  if (vehicle) {
    localStorage.setItem(CREW_SESSION_KEYS.vehicle, JSON.stringify(vehicle));
  }
}
