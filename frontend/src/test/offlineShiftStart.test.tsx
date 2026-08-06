/**
 * A crew that unlocked the device while online must still be able to start a
 * shift when the server is unreachable.
 *
 * `offlineShiftCache.ts` was written to make that work — it caches both
 * rosters and reads the grant's own `exp` claim so an unlocked device can go
 * on without the server. It had unit tests. **Nothing in the application ever
 * called it.** `ProviderLogin` imported the crew-roster half only, so:
 *
 *   - the vehicle list was fetched with `.catch(() => {})` — the failure was
 *     swallowed whole, leaving an empty vehicle picker offline even though the
 *     crew list had come back from cache. Half a cached flow is no flow.
 *   - `unlocked` was `!!getPortalGrant(slug)` — presence, not validity. An
 *     expired grant rendered the picker and then failed with a 401 at the
 *     moment of starting a shift; offline, with nothing to answer, it sat on a
 *     picker that could never work.
 *
 * These tests drive the component, not the helpers, because the helpers were
 * already green while the feature did not exist.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import axios from 'axios';

vi.mock('axios');

// The pickers live in StartShiftWizard, behind a "Start Shift" launcher, so
// what matters is what ProviderLogin HANDS IT. Stubbing the wizard to print
// its props tests the data flow without driving a multi-step modal — and it
// keeps the test honest about which component owns the bug.
vi.mock('../pages/crew/StartShiftWizard', () => ({
  default: ({ crewList, vehicleList }: any) => (
    <div>
      <span data-testid="wizard-crew">{crewList.map((c: any) => c.full_name || c.name).join(',')}</span>
      <span data-testid="wizard-vehicles">{vehicleList.map((v: any) => v.callsign).join(',')}</span>
    </div>
  ),
}));

import ProviderLogin from '../pages/crew/ProviderLogin';

const SLUG = 'harness-ems';
const CREW = [{ id: 'c1', full_name: 'A. Dlamini', qualification: 'ECP' }];
const VEHICLES = [{ id: 'v1', callsign: 'A01', registration: 'XX00XXGP', vehicle_type: 'Ambulance' }];

/** A grant shaped like the real one: three parts, `exp` in SECONDS. */
function grant(expiresInMs: number): string {
  const payload = { provider_slug: SLUG, token_scope: 'portal_grant', exp: Math.floor((Date.now() + expiresInMs) / 1000) };
  const b64 = (o: any) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.sig`;
}

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={[`/${SLUG}/login`]}>
      <Routes>
        <Route path="/:providerSlug/login" element={<ProviderLogin />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Network down for the roster calls; anything else resolves empty. */
function offline() {
  (axios.get as any).mockImplementation((url: string) => {
    if (url.includes('/public-crew') || url.includes('/public-vehicles')) {
      return Promise.reject(Object.assign(new Error('Network Error'), { response: undefined }));
    }
    return Promise.resolve({ data: {} });
  });
}

function online() {
  (axios.get as any).mockImplementation((url: string) => {
    if (url.includes('/public-crew')) return Promise.resolve({ data: CREW });
    if (url.includes('/public-vehicles')) return Promise.resolve({ data: VEHICLES });
    return Promise.resolve({ data: {} });
  });
}

describe('offline shift start', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });
  afterEach(cleanup);

  it('caches the vehicle list on a successful online load', async () => {
    localStorage.setItem(`portal_grant_${SLUG}`, grant(12 * 60 * 60 * 1000));
    online();
    renderLogin();

    await waitFor(() => {
      const raw = localStorage.getItem(`offline_shift_vehicles_${SLUG}_v1`);
      expect(raw, 'vehicles were never cached, so an offline reopen has nothing to show').toBeTruthy();
      expect(JSON.parse(raw!).items).toHaveLength(1);
    });
  });

  it('shows the cached vehicles when the server is unreachable', async () => {
    localStorage.setItem(`portal_grant_${SLUG}`, grant(12 * 60 * 60 * 1000));
    localStorage.setItem(
      `offline_shift_vehicles_${SLUG}_v1`,
      JSON.stringify({ cachedAt: Date.now(), items: VEHICLES }),
    );
    localStorage.setItem(
      `offline_shift_crew_${SLUG}_v1`,
      JSON.stringify({ cachedAt: Date.now(), items: CREW }),
    );
    offline();
    const { user } = { user: null as any };
    renderLogin();
    // Open the wizard so it receives the lists.
    const launcher = await screen.findByRole('button', { name: /start shift/i });
    launcher.click();

    // The crew name proves the cached path runs at all; the callsign is the
    // half that used to be missing.
    await waitFor(() =>
      expect(screen.getByTestId('wizard-crew').textContent).toContain('A. Dlamini'),
    );
    expect(
      screen.getByTestId('wizard-vehicles').textContent,
      'vehicle picker was empty offline — the shift cannot be started',
    ).toContain('A01');
  });

  it('re-prompts for the company password when the stored grant has expired', async () => {
    localStorage.setItem(`portal_grant_${SLUG}`, grant(-60 * 1000)); // expired a minute ago
    localStorage.setItem(
      `offline_shift_crew_${SLUG}_v1`,
      JSON.stringify({ cachedAt: Date.now(), items: CREW }),
    );
    offline();
    renderLogin();

    // Assert the UNLOCK PROMPT is what renders. Checking that the crew picker
    // is absent is not enough — the picker lives behind a launcher, so it is
    // absent on this screen either way and the assertion passed even with the
    // expiry check removed. A mutation test caught that; this is the version
    // that actually fails when `unlocked` goes back to mere presence.
    await waitFor(() => {
      expect(
        screen.queryByLabelText(/company password/i)
          || screen.queryByPlaceholderText(/company password/i),
        'an expired grant left the device looking unlocked — offline there is '
          + 'no server to reject it, so the crew would sit on a dead screen',
      ).toBeTruthy();
    });
  });

  it('does not fall back to a cached roster when the server ANSWERS 401', async () => {
    // A transport failure means "unreachable" — use the cache. A 401 is the
    // server saying the grant is no longer good, and must be honoured.
    localStorage.setItem(`portal_grant_${SLUG}`, grant(12 * 60 * 60 * 1000));
    localStorage.setItem(
      `offline_shift_vehicles_${SLUG}_v1`,
      JSON.stringify({ cachedAt: Date.now(), items: VEHICLES }),
    );
    (axios.get as any).mockImplementation((url: string) => {
      if (url.includes('/public-crew') || url.includes('/public-vehicles')) {
        return Promise.reject({ response: { status: 401 } });
      }
      return Promise.resolve({ data: {} });
    });
    renderLogin();

    await waitFor(() => {
      expect(
        screen.queryByText(/A01/),
        'a revoked grant was papered over with a cached vehicle list',
      ).toBeNull();
    });
  });
});
