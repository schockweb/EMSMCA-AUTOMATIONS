/**
 * Sends a PRF to the receiving facility by itself, once there is signal.
 *
 * THE GAP THIS FILLS
 * ------------------
 * A PRF captured with no signal queues in the outbox and syncs on reconnect —
 * that part already worked. But the facility email did not: online, submitting
 * routes the crew to the viewer with `?send=1`, and even there the crew still
 * has to TAP send (`?send=1` only gates the UI — it never fired the send
 * itself). Offline there is nobody watching, so the handover document simply
 * never went, and nothing recorded that it was owed.
 *
 * WHY IT HAS TO BE DONE ON THE DEVICE
 * -----------------------------------
 * The backend says it plainly: "The PDF travels from the device because the
 * pixel-perfect render only exists client-side." `email-facility` takes an
 * uploaded file and there is no server-side renderer. So the only way to send
 * automatically is to render the sheet again on the device — which means
 * mounting the viewer, off-screen, and letting it do exactly what it does when
 * a crew member taps the button.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * No banner, no toast, no badge. The crew asked for none, and they are right:
 * a paramedic mid-call should not be told about background bookkeeping. It runs
 * or it doesn't, and the server-side record is what catches the case where it
 * doesn't.
 *
 * It is also careful to be invisible in the technical sense. The hidden viewer
 * must not touch the viewport meta (that would re-enable iOS focus-zoom on the
 * form the crew is typing into), must not steal focus, and must not be
 * reachable by a screen reader — hence aria-hidden and inert.
 */
import { useEffect, useRef, useState } from 'react';
import { MemoryRouter, Routes, Route } from 'react-router';
import PRFView from '../pages/PRFView';
import {
  getPendingEmails,
  clearPendingEmail,
  recordAttempt,
  isExhausted,
  type PendingEmail,
} from '../services/pendingFacilityEmail';
import { getCrewToken } from '../utils/crewSession';
import { shouldSkipNetwork } from '../services/serverHealth';

/** Wait this long after regaining connectivity before rendering a PDF. The
 *  outbox drain gets priority — the PRF itself reaching the server matters more
 *  than its email, and html2canvas is heavy enough to compete on a phone. */
const START_DELAY_MS = 8_000;

/** Re-check for newly-sendable work on this cadence while the app is open. */
const POLL_MS = 30_000;

/** A single attempt may not run forever — html2canvas can stall on a
 *  backgrounded tab, and a wedged attempt would block every later one. */
const ATTEMPT_TIMEOUT_MS = 120_000;

function nextSendable(): PendingEmail | null {
  const providerNow = (() => {
    try { return JSON.parse(localStorage.getItem('crew_profile') || '{}')?.provider_id; }
    catch { return undefined; }
  })();

  return getPendingEmails().find((e) =>
    // Needs a Case: the email endpoint is keyed by case, not PRF.
    !!e.caseId &&
    !isExhausted(e) &&
    // Never send another provider's record under this session's credentials.
    (!e.providerId || !providerNow || e.providerId === providerNow)
  ) || null;
}

export default function SilentFacilityEmailSender() {
  const [active, setActive] = useState<PendingEmail | null>(null);
  const busyRef = useRef(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const finish = (prfId: string, outcome: string) => {
    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }

    if (outcome === 'sent' || outcome === 'already-sent') {
      clearPendingEmail(prfId);
    } else {
      // Counted, never deleted. An exhausted entry stops this device retrying
      // but stays on record — silently dropping an owed handover document is
      // the exact failure this whole feature exists to prevent.
      recordAttempt(prfId, outcome);
    }

    busyRef.current = false;
    setActive(null);
  };

  useEffect(() => {
    let cancelled = false;

    const tick = () => {
      if (cancelled || busyRef.current) return;
      if (!navigator.onLine || shouldSkipNetwork()) return;
      if (!getCrewToken()) return;          // nobody logged in to send as
      const next = nextSendable();
      if (!next) return;

      busyRef.current = true;
      setActive(next);
      timeoutRef.current = setTimeout(() => finish(next.prfId, 'timeout'), ATTEMPT_TIMEOUT_MS);
    };

    const startTimer = setTimeout(tick, START_DELAY_MS);
    const poll = setInterval(tick, POLL_MS);
    // Reconnecting is the whole trigger for this feature; give the outbox its
    // head start, then look.
    const onOnline = () => setTimeout(tick, START_DELAY_MS);
    window.addEventListener('online', onOnline);

    return () => {
      cancelled = true;
      clearTimeout(startTimer);
      clearInterval(poll);
      window.removeEventListener('online', onOnline);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  if (!active?.caseId) return null;

  return (
    <div
      aria-hidden="true"
      // @ts-expect-error — `inert` is valid HTML; React's types lag behind.
      inert=""
      style={{
        // Off-screen rather than display:none or visibility:hidden — both stop
        // layout, and html2canvas needs the sheet genuinely laid out at its
        // 1220px design width to capture it. Fixed keeps it out of document
        // flow so nothing on the crew's actual page shifts.
        position: 'fixed',
        left: '-100000px',
        top: 0,
        width: 1280,
        height: 1,
        overflow: 'hidden',
        pointerEvents: 'none',
        opacity: 0,
      }}
    >
      <MemoryRouter
        initialEntries={[`/silent/cases/${active.caseId}/prf?send=1`]}
      >
        <Routes>
          <Route
            path="/silent/cases/:caseId/prf"
            element={
              <PRFView
                silentMode
                onSilentDone={(outcome) => finish(active.prfId, outcome)}
              />
            }
          />
        </Routes>
      </MemoryRouter>
    </div>
  );
}
