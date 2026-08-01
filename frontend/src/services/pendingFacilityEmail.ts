/**
 * "Email this PRF to the receiving facility, once you can."
 *
 * WHY THIS EXISTS
 * ---------------
 * Online, submitting a PRF that carries a handover email routes the crew to the
 * PRF viewer with `?send=1`, where they confirm the address and it goes. Offline
 * that whole step was skipped: the submit was queued and the crew was returned
 * to the dashboard, so the receiving hospital never got the handover document
 * and nothing recorded that it was supposed to.
 *
 * The crew now confirms the address at submit time — while they are standing at
 * the handover and can actually check it — and the intent is recorded here.
 * The send itself happens after the PRF syncs.
 *
 * WHY THE SEND CANNOT BE A SERVER JOB
 * -----------------------------------
 * `POST /admin/by-case/{id}/email-facility` takes an UPLOADED PDF, and the
 * backend says why in its own docstring: "The PDF travels from the device
 * because the pixel-perfect render only exists client-side." There is no
 * server-side renderer, so the device has to produce the file. That is the one
 * hard constraint shaping this design — the send is completed by the device on
 * reconnect, not by a worker.
 *
 * A device that is lost, broken, or simply never reopened would therefore never
 * send. That is what the server-side pending flag is for: the PRF is marked as
 * awaiting a facility email when it syncs, so the back office can see it and
 * complete the send from the admin viewer.
 */

const KEY = 'pending_facility_emails_v1';

export interface PendingEmail {
  /** The device-minted PRF id — stable across the offline/online boundary. */
  prfId: string;
  /** Address the crew CONFIRMED, not merely what was typed into the form. */
  recipient: string;
  /** When the crew confirmed it, for staleness reporting. */
  confirmedAt: number;
  /** Provider that owns the record — mirrors the outbox author stamp so a
   *  different crew on a shared tablet cannot send another company's PRF. */
  providerId?: string;
  /** Set once the PRF has synced and its Case exists; the send needs a caseId. */
  caseId?: string;
  /** Attempts made since the PRF synced, so a permanently failing send does not
   *  retry forever and silently look "in progress". */
  attempts: number;
  lastError?: string;
}

function readAll(): PendingEmail[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAll(items: PendingEmail[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    /* quota / private mode — the server-side pending flag is the backstop */
  }
}

/** Record that the crew confirmed an address for this PRF. */
export function rememberPendingEmail(
  prfId: string,
  recipient: string,
  providerId?: string,
): void {
  if (!prfId || !recipient) return;
  const items = readAll().filter((e) => e.prfId !== prfId);   // last confirm wins
  items.push({
    prfId,
    recipient: recipient.trim(),
    confirmedAt: Date.now(),
    providerId,
    attempts: 0,
  });
  writeAll(items);
}

export function getPendingEmails(): PendingEmail[] {
  return readAll();
}

export function getPendingEmail(prfId: string): PendingEmail | undefined {
  return readAll().find((e) => e.prfId === prfId);
}

/** Attach the Case id once the PRF has synced and been processed. */
export function attachCaseId(prfId: string, caseId: string): void {
  const items = readAll();
  const e = items.find((x) => x.prfId === prfId);
  if (!e) return;
  e.caseId = caseId;
  writeAll(items);
}

export function recordAttempt(prfId: string, error?: string): void {
  const items = readAll();
  const e = items.find((x) => x.prfId === prfId);
  if (!e) return;
  e.attempts += 1;
  e.lastError = error;
  writeAll(items);
}

/** Remove once the server has confirmed the email is queued for delivery. */
export function clearPendingEmail(prfId: string): void {
  writeAll(readAll().filter((e) => e.prfId !== prfId));
}

/**
 * Entries this device should stop retrying on its own.
 *
 * They are NOT deleted — the crew can still see them, and the server-side
 * pending flag means the back office can complete the send regardless. Giving
 * up quietly and deleting would reproduce exactly the failure this whole
 * feature exists to prevent.
 */
export const MAX_SEND_ATTEMPTS = 5;

export function isExhausted(e: PendingEmail): boolean {
  return e.attempts >= MAX_SEND_ATTEMPTS;
}

/**
 * A handover document loses clinical value as it ages — the receiving team
 * needs it while the patient is still in front of them. Surface anything that
 * has been waiting longer than this.
 */
export const STALE_AFTER_MS = 2 * 60 * 60 * 1000;   // 2 hours

export function isStale(e: PendingEmail, now = Date.now()): boolean {
  return now - e.confirmedAt > STALE_AFTER_MS;
}

/** Only this provider's entries — a shared tablet may hold another crew's. */
export function pendingForProvider(providerId: string | undefined): PendingEmail[] {
  return readAll().filter((e) => !e.providerId || !providerId || e.providerId === providerId);
}

/** Test seam. */
export function __clearAllPendingEmails(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
