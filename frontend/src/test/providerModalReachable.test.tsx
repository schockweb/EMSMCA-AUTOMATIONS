/**
 * No pop-up on the Clients page may hide its own top or bottom on a phone.
 *
 * THE BUG THIS PINS
 * -----------------
 * Every modal here centred its card with `align-items: center` and capped it in
 * `vh`. Centring a card TALLER than its container pushes the overflow off BOTH
 * ends, and the overlay had `overflow-y: visible`, so nothing could bring the
 * top back — the close button and the first fields were simply gone.
 *
 * On a phone that is not an edge case, it is the normal state. iOS resolves
 * `vh` against the LARGE viewport (browser chrome hidden) while a
 * position:fixed overlay is laid out against the SMALL one, so a `92vh` card
 * is taller than the box holding it the moment the toolbar is showing.
 * Measured in Chrome on Add New Client at 390x664: card 744px, its top at
 * -48px, its close button at -35px. The worker could not close the dialog or
 * reach the company-name field.
 *
 * WHY A STYLE CONTRACT AND NOT A LAYOUT ASSERTION
 * -----------------------------------------------
 * jsdom has no layout engine — every getBoundingClientRect here is 0x0, so a
 * test that measured reachability would pass against the broken code too. The
 * reachability was proven in a real browser (playwright, iPhone 12 and Pixel 5
 * profiles, touch-only swipes). What this file defends is the four style
 * decisions that make it true, because those are what a later tidy-up would
 * quietly revert.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const PROVIDERS = [{
  id: 'p1', name: 'Michaels EMS', slug: 'michaels-ems',
  pr_number: 'PR1', phone: '011', email: 'a@x.test', address: 'A',
  is_active: true, crew_count: 1, vehicle_count: 1, prf_count: 0, created_at: null,
}];
const CREW = [{
  id: 'c1', full_name: 'A. Mokoena', email: 'a@x.test', initials: 'AM',
  hpcsa_number: 'AEA0001', qualification: 'AEA', phone: '', role: 'crew', is_active: true,
}];
const VEHICLES = [{ id: 'v1', callsign: 'ALPHA 12', registration: 'GP 123-456', vehicle_type: 'Ambulance' }];

vi.mock('../api/client', () => {
  const get = vi.fn(async (url: string) => {
    if (url.includes('/account-security')) return { data: [] };
    if (url.includes('/crew')) return { data: CREW };
    if (url.includes('/vehicles')) return { data: VEHICLES };
    return { data: PROVIDERS };
  });
  return { default: { get, post: vi.fn(async () => ({ data: {} })), patch: vi.fn(async () => ({ data: {} })), delete: vi.fn() } };
});

import ProviderManagement from '../pages/ProviderManagement';

/**
 * The overlay is the fixed, full-screen flex box a dialog sits in. Identified
 * structurally rather than by a test id, so it keeps working if the markup
 * around it is rewritten.
 */
const overlays = (): HTMLElement[] =>
  [...document.querySelectorAll<HTMLElement>('div')].filter(d =>
    d.style.position === 'fixed' && d.style.inset === '0px' && d.style.display === 'flex');

const open = async (label: string) => {
  render(<MemoryRouter><ProviderManagement /></MemoryRouter>);
  await waitFor(() => expect(screen.getAllByText(label).length).toBeGreaterThan(0));
  fireEvent.click(screen.getAllByText(label)[0]);
};

/** Open a client first — the crew and vehicle dialogs live inside one. */
const openInsideClient = async (label: string, tab?: RegExp) => {
  render(<MemoryRouter><ProviderManagement /></MemoryRouter>);
  await waitFor(() => expect(screen.getAllByText('Michaels EMS').length).toBeGreaterThan(0));
  fireEvent.click(screen.getAllByText('Michaels EMS')[0]);
  if (tab) {
    await waitFor(() => expect(screen.getAllByText(tab).length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText(tab)[0]);
  }
  await waitFor(() => expect(screen.getAllByText(label).length).toBeGreaterThan(0));
  fireEvent.click(screen.getAllByText(label)[0]);
};

beforeEach(() => { vi.clearAllMocks(); window.alert = vi.fn(); });
afterEach(cleanup);

describe('modal overlays', () => {
  const cases: Array<[string, () => Promise<void>]> = [
    ['Add Provider', () => open('+ Add Provider')],
    ['Add Crew',     () => openInsideClient('+ Add Crew')],
    ['Add Vehicle',  () => openInsideClient('+ Add Vehicle', /Vehicles \(/)],
  ];

  for (const [name, openIt] of cases) {
    it(`${name} scrolls its own overlay and never centres a card it cannot fit`, async () => {
      await openIt();
      await waitFor(() => expect(overlays().length).toBeGreaterThan(0));
      const overlay = overlays().slice(-1)[0];

      // flex-start, not center: centring is what makes an over-tall card
      // unreachable at BOTH ends.
      expect(overlay.style.alignItems, `${name} overlay re-centred its card`).toBe('flex-start');
      // The overlay is the scroll surface. Without this there is nothing to
      // scroll once the card is taller than the screen.
      expect(overlay.style.overflowY, `${name} overlay cannot scroll`).toBe('auto');
      // Stops the scroll chaining to the page behind, which useScrollLock has
      // pinned with position:fixed.
      expect(overlay.style.overscrollBehavior).toBe('contain');

      const card = [...overlay.children].find(c => (c as HTMLElement).style.maxHeight) as HTMLElement | undefined;
      if (card) {
        // margin:auto is what still centres the card when it DOES fit — losing
        // it would jam every short dialog against the top of the screen.
        expect(card.style.margin, `${name} card lost its auto margin`).toBe('auto');
        // dvh is the currently visible viewport; vh is the toolbar-hidden one
        // and can therefore exceed the overlay it sits in.
        expect(card.style.maxHeight, `${name} card cap is in vh, not dvh`).toMatch(/dvh$/);
      }
    });
  }

  it('leaves no pop-up on the page still using the centred, unscrollable pattern', async () => {
    // A sweep, so a modal added later cannot quietly reintroduce it.
    await open('+ Add Provider');
    await waitFor(() => expect(overlays().length).toBeGreaterThan(0));
    for (const o of overlays()) {
      expect(o.style.alignItems).not.toBe('center');
    }
  });
});
