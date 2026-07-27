/**
 * Portal grant — proof the company password was entered on THIS device.
 *
 * WHY THIS EXISTS
 * ---------------
 * Starting a shift mints a 12-hour token that can read, edit and delete Patient
 * Report Forms. That used to require nothing at all: the crew list (with each
 * member's UUID) was public, and posting a UUID to /api/crew/shift-start-by-id
 * returned a working patient-record token. Anyone on the internet could do it.
 *
 * A device now exchanges the company password for a short-lived, provider-bound
 * grant, and the shift-start endpoints require it. One unlock per device per
 * shift — selecting a name from a dropdown is identification, not authentication.
 */
const KEY = (slug: string) => `portal_grant_${slug}`;

export function getPortalGrant(slug: string | undefined): string | null {
  if (!slug) return null;
  try { return localStorage.getItem(KEY(slug)); } catch { return null; }
}

export function savePortalGrant(slug: string, grant: string): void {
  try { localStorage.setItem(KEY(slug), grant); } catch { /* private mode */ }
}

export function clearPortalGrant(slug: string | undefined): void {
  if (!slug) return;
  try { localStorage.removeItem(KEY(slug)); } catch { /* ignore */ }
}

/**
 * Authorization header for the shift-start endpoints.
 *
 * Falls back to an existing crew token so a crew already on shift can add a
 * colleague without re-entering the company password — the server accepts
 * either for the same provider.
 */
export function grantHeaders(slug: string | undefined): Record<string, string> {
  const grant = getPortalGrant(slug);
  if (grant) return { Authorization: `Bearer ${grant}` };
  try {
    const crewToken = localStorage.getItem('crew_token');
    if (crewToken) return { Authorization: `Bearer ${crewToken}` };
  } catch { /* ignore */ }
  return {};
}

/** True when a 401 means "this device is not unlocked" and we should re-prompt. */
export function isLockedOut(err: any): boolean {
  return err?.response?.status === 401 || err?.response?.status === 403;
}
