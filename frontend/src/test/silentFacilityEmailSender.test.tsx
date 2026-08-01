/**
 * The facility email completes itself once there is signal — no crew action.
 *
 * A PRF captured offline syncs on reconnect (that already worked), but the
 * handover email did not: online, submit routes the crew to the viewer with
 * `?send=1`, and even THERE the crew still had to tap — `?send=1` only gates
 * the UI, it never fired the send. Offline nobody is watching, so the receiving
 * hospital simply never got the document.
 *
 * These cover the decision logic — WHICH entry gets sent, and when nothing
 * should be attempted. The render/upload itself needs a real browser and is
 * verified there, not in jsdom (which has no layout engine, so html2canvas
 * cannot produce a meaningful canvas).
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import SilentFacilityEmailSender from '../components/SilentFacilityEmailSender';
import {
  rememberPendingEmail,
  attachCaseId,
  recordAttempt,
  getPendingEmail,
  MAX_SEND_ATTEMPTS,
  __clearAllPendingEmails,
} from '../services/pendingFacilityEmail';
import { __resetServerHealth, reportFailure } from '../services/serverHealth';

const PRF = 'prf-1';
const CASE = 'case-1';
const PROVIDER = 'provider-a';

function setCrewSession(providerId = PROVIDER) {
  localStorage.setItem('crew_token', 'a.b.c');
  localStorage.setItem('crew_profile', JSON.stringify({ provider_id: providerId, id: 'crew-1' }));
}

/** The component waits before doing anything so the outbox drain gets priority.
 *
 * Wrapped in act(): the work is kicked off from a setTimeout, so the resulting
 * setState lands outside React's batching. Without this the component never
 * renders its host element and EVERY "stays silent" assertion below passes for
 * the wrong reason — the positive test at the bottom is what caught that. */
function runStartupTimers() {
  act(() => { vi.advanceTimersByTime(10_000); });
}

describe('silent facility email sender', () => {
  beforeEach(() => {
    localStorage.clear();
    __clearAllPendingEmails();
    __resetServerHealth();
    vi.useFakeTimers();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders nothing at all when there is no pending email', () => {
    setCrewSession();
    const { container } = render(<SilentFacilityEmailSender />);
    runStartupTimers();
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing while the PRF has not yet been given a Case', () => {
    // The email endpoint is keyed by CASE, not PRF. Attempting before the
    // billing pipeline has produced one would just 404.
    setCrewSession();
    rememberPendingEmail(PRF, 'dr@hospital.co.za', PROVIDER);
    const { container } = render(<SilentFacilityEmailSender />);
    runStartupTimers();
    expect(container.innerHTML).toBe('');
  });

  it('stays silent while the device is offline', () => {
    setCrewSession();
    rememberPendingEmail(PRF, 'dr@hospital.co.za', PROVIDER);
    attachCaseId(PRF, CASE);
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);

    const { container } = render(<SilentFacilityEmailSender />);
    runStartupTimers();
    expect(container.innerHTML).toBe('');
  });

  it('stays silent while the SERVER is unreachable, not just the radio', () => {
    // navigator.onLine is true with four bars and a dead portal. Rendering a
    // PDF and posting it then would just burn a retry.
    setCrewSession();
    rememberPendingEmail(PRF, 'dr@hospital.co.za', PROVIDER);
    attachCaseId(PRF, CASE);
    reportFailure({ code: 'ERR_NETWORK' });
    reportFailure({ code: 'ERR_NETWORK' });

    const { container } = render(<SilentFacilityEmailSender />);
    runStartupTimers();
    expect(container.innerHTML).toBe('');
  });

  it('stays silent when nobody is logged in to send as', () => {
    rememberPendingEmail(PRF, 'dr@hospital.co.za', PROVIDER);
    attachCaseId(PRF, CASE);
    // no crew_token
    const { container } = render(<SilentFacilityEmailSender />);
    runStartupTimers();
    expect(container.innerHTML).toBe('');
  });

  it('never sends another provider’s PRF under this session', () => {
    setCrewSession('provider-a');
    rememberPendingEmail(PRF, 'dr@hospital.co.za', 'provider-b');
    attachCaseId(PRF, CASE);

    const { container } = render(<SilentFacilityEmailSender />);
    runStartupTimers();
    expect(container.innerHTML).toBe('');
  });

  it('gives up after the attempt limit instead of retrying forever', () => {
    setCrewSession();
    rememberPendingEmail(PRF, 'dr@hospital.co.za', PROVIDER);
    attachCaseId(PRF, CASE);
    for (let i = 0; i < MAX_SEND_ATTEMPTS; i++) recordAttempt(PRF, 'smtp down');

    const { container } = render(<SilentFacilityEmailSender />);
    runStartupTimers();
    expect(container.innerHTML).toBe('');
    // Exhausted, but NOT deleted — an owed handover document stays on record.
    expect(getPendingEmail(PRF)).toBeDefined();
  });

  it('mounts the hidden viewer once everything is ready', () => {
    setCrewSession();
    rememberPendingEmail(PRF, 'dr@hospital.co.za', PROVIDER);
    attachCaseId(PRF, CASE);

    const { container } = render(<SilentFacilityEmailSender />);
    runStartupTimers();

    const host = container.firstElementChild as HTMLElement | null;
    expect(host).not.toBeNull();
    // It must be genuinely inert to the crew: off-screen rather than hidden
    // (html2canvas needs real layout), aria-hidden, and non-interactive.
    expect(host!.getAttribute('aria-hidden')).toBe('true');
    expect(host!.style.position).toBe('fixed');
    expect(parseInt(host!.style.left, 10)).toBeLessThan(-9999);
    expect(host!.style.pointerEvents).toBe('none');
  });
});
