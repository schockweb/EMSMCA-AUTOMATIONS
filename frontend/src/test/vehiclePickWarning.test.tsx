/**
 * The warning fires on the TAP, and only on the tap.
 *
 * The unit tests beside this one cover the helper; these drive the wizard the
 * crew actually touches, because the helper was green in isolation long before
 * anything called it — the exact way the offline shift-start feature managed to
 * not exist while its tests passed (see offlineShiftStart.test.tsx).
 *
 * Three things are pinned:
 *   * drawing the list asks nothing — no request per vehicle, and no crew
 *     member's whereabouts disclosed to someone merely looking at the picker
 *   * tapping an occupied vehicle asks, and declining leaves the crew where
 *     they were rather than half-selecting it
 *   * a check that cannot be answered selects exactly as before
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import StartShiftWizard from '../pages/crew/StartShiftWizard';
import * as occupancy from '../utils/vehicleOccupancy';

vi.mock('../utils/portalGrant', () => ({ grantHeaders: () => ({}) }));

const VEHICLES = [
  { id: 'v-1', callsign: 'ALPHA 12', registration_number: 'GP 123-456' },
  { id: 'v-2', callsign: 'ALPHA 13', registration_number: 'GP 654-321' },
];
const CREW = [
  { id: 'c-1', full_name: 'J. Mokoena', qualification: 'AEA', hpcsa_number: 'A01' },
  { id: 'c-2', full_name: 'S. Ndlovu', qualification: 'BAA', hpcsa_number: 'A02' },
];

const renderWizard = () =>
  render(
    <MemoryRouter>
      <StartShiftWizard
        providerSlug="emsmca"
        crewList={CREW}
        vehicleList={VEHICLES}
        onClose={() => {}}
      />
    </MemoryRouter>,
  );

/** Step 2 is on screen once the crew list appears. */
const atCrewStep = () => screen.queryByText('Select Crew') !== null;

describe('vehicle pick warning', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('asks nothing while the list is merely drawn', async () => {
    const check = vi.spyOn(occupancy, 'checkVehicleInUse');
    renderWizard();
    await screen.findByText('ALPHA 12');
    expect(screen.getByText('ALPHA 13')).toBeTruthy();
    expect(check).not.toHaveBeenCalled();
  });

  it('warns on the tap, and only about the vehicle tapped', async () => {
    const check = vi.spyOn(occupancy, 'checkVehicleInUse')
      .mockResolvedValue({ in_use: true, crew_name: 'T. Botha', minutes_ago: 30 });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);

    renderWizard();
    fireEvent.click(await screen.findByText('ALPHA 12'));

    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(check).toHaveBeenCalledTimes(1);
    expect(check.mock.calls[0][1]).toBe('v-1');
    expect(confirm.mock.calls[0][0]).toContain('ALPHA 12');
  });

  it('declining leaves the crew on the vehicle list', async () => {
    vi.spyOn(occupancy, 'checkVehicleInUse')
      .mockResolvedValue({ in_use: true, crew_name: 'T. Botha' });
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    renderWizard();
    fireEvent.click(await screen.findByText('ALPHA 12'));

    await waitFor(() => expect(window.confirm).toHaveBeenCalled());
    expect(atCrewStep()).toBe(false);
    expect(screen.getByText('ALPHA 13')).toBeTruthy();
  });

  it('continuing carries them through to crew selection', async () => {
    vi.spyOn(occupancy, 'checkVehicleInUse')
      .mockResolvedValue({ in_use: true, crew_name: 'T. Botha' });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    renderWizard();
    fireEvent.click(await screen.findByText('ALPHA 12'));

    await waitFor(() => expect(atCrewStep()).toBe(true));
    expect(screen.getByText('J. Mokoena')).toBeTruthy();
  });

  it('a free vehicle advances with no dialog at all', async () => {
    vi.spyOn(occupancy, 'checkVehicleInUse').mockResolvedValue(null);
    const confirm = vi.spyOn(window, 'confirm');

    renderWizard();
    fireEvent.click(await screen.findByText('ALPHA 12'));

    await waitFor(() => expect(atCrewStep()).toBe(true));
    expect(confirm).not.toHaveBeenCalled();
  });

  it('an unanswerable check does not hold the crew up', async () => {
    // checkVehicleInUse swallows its own failures, so this is what the wizard
    // sees offline or when the server is down. It must behave as before.
    vi.spyOn(occupancy, 'checkVehicleInUse').mockResolvedValue(null);
    const confirm = vi.spyOn(window, 'confirm');

    renderWizard();
    fireEvent.click(await screen.findByText('ALPHA 12'));

    await waitFor(() => expect(atCrewStep()).toBe(true));
    expect(confirm).not.toHaveBeenCalled();
  });
});
