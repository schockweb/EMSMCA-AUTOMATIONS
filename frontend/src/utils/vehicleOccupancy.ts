/**
 * Vehicle occupancy — "ALPHA 12 is already in use" on the shift-start picker.
 *
 * Asked when a crew TAPS a vehicle, never when the list is drawn. Two reasons:
 * the list stays clean and readable at arm's length on a tablet, and one crew's
 * whereabouts are disclosed only to a crew who is about to take the same
 * ambulance and therefore has a reason to know.
 *
 * FAIL OPEN, ALWAYS. If the check cannot be answered — no signal, server down,
 * slow link — the crew proceeds with no warning. A crew standing at a scene
 * must never be held up by a courtesy feature, and shift start deliberately
 * works offline (see offlineShiftCache), where this endpoint is unreachable by
 * definition. Every failure path here returns null and every caller reads null
 * as "say nothing".
 *
 * The 3-second timeout is the whole point of that promise: the default has no
 * ceiling, so on a bad link this would sit between a paramedic and their
 * ambulance for as long as the socket stayed open.
 */
import axios from 'axios';
import { grantHeaders } from './portalGrant';

export interface VehicleOccupancy {
  in_use: boolean;
  crew_name?: string | null;
  partner_name?: string | null;
  vehicle_callsign?: string | null;
  since?: string;
  minutes_ago?: number;
}

const TIMEOUT_MS = 3000;

/** Who is on this vehicle, or null when the question could not be answered. */
export async function checkVehicleInUse(
  providerSlug: string | undefined,
  vehicleId: string,
): Promise<VehicleOccupancy | null> {
  if (!providerSlug || !vehicleId || !navigator.onLine) return null;
  try {
    const res = await axios.get(
      `/api/providers/${providerSlug}/vehicle-status/${vehicleId}`,
      { headers: grantHeaders(providerSlug), timeout: TIMEOUT_MS },
    );
    return res.data?.in_use ? (res.data as VehicleOccupancy) : null;
  } catch {
    return null;
  }
}

/** "3h 20m" / "45m" — how long they have been on it. */
function humanAge(minutes?: number): string {
  if (!minutes || minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m ago` : `${h}h ago`;
}

/** Local clock time of the sign-on, e.g. "07:14". */
function clockTime(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

/**
 * Ask the crew whether to take a vehicle someone else is on.
 *
 * Returns true to proceed. `window.confirm` rather than a styled dialog, on
 * purpose: it is what End Shift already uses, it cannot be missed or scrolled
 * past, and it renders identically on every tablet in the fleet — this is the
 * one moment where being noticed matters more than being pretty.
 */
export function confirmTakeOccupiedVehicle(
  callsign: string,
  occ: VehicleOccupancy,
): boolean {
  const who = occ.crew_name || 'Another crew';
  const at = clockTime(occ.since);
  const withPartner = occ.partner_name ? ` with ${occ.partner_name}` : '';

  const line = at
    ? `${who}${withPartner} signed on to this vehicle at ${at} (${humanAge(occ.minutes_ago)}).`
    : `${who}${withPartner} is already signed on to this vehicle.`;

  return window.confirm(
    `${callsign} is already in use.\n\n${line}\n\n` +
    `If you are taking over, or this is a second crew on the same vehicle, carry on.\n\n` +
    `Continue with ${callsign}?`,
  );
}

/**
 * Record that this crew is now on the vehicle.
 *
 * Needed only by the dashboard flow, which authenticates through lookup-hpcsa
 * and never sends a vehicle to the server; the login-page wizard's
 * shift-start-by-id already carries one and claims it server-side.
 *
 * Never throws and never blocks — a shift that started is more important than
 * a warning the next crew might have seen.
 */
export async function claimVehicle(token: string, vehicleId: string): Promise<void> {
  if (!token || !vehicleId || !navigator.onLine) return;
  try {
    await axios.post(
      '/api/crew/claim-vehicle',
      { vehicle_id: vehicleId },
      { headers: { Authorization: `Bearer ${token}` }, timeout: TIMEOUT_MS },
    );
  } catch {
    /* advisory only */
  }
}
