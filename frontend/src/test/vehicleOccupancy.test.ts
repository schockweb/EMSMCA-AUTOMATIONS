/**
 * Vehicle occupancy — the "already in use" warning on shift start.
 *
 * The only rule here that really matters is FAIL OPEN. This is a courtesy
 * feature standing between a paramedic and their ambulance, so every way the
 * check can go wrong — offline, 500, 404, timeout, a device with no grant —
 * has to end in "say nothing and let them through". A bug that made it warn
 * spuriously would be irritating; a bug that made it block would be dangerous,
 * and it would show up at a scene rather than in an office.
 *
 * These tests exist because that promise is invisible: nothing in the UI looks
 * different when it holds, so nothing looks different when it breaks either.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import {
  checkVehicleInUse,
  confirmTakeOccupiedVehicle,
  claimVehicle,
} from '../utils/vehicleOccupancy';

vi.mock('../utils/portalGrant', () => ({
  grantHeaders: () => ({ 'X-Portal-Grant': 'test-grant' }),
}));

const setOnline = (v: boolean) =>
  Object.defineProperty(navigator, 'onLine', { value: v, configurable: true });

describe('checkVehicleInUse', () => {
  beforeEach(() => { setOnline(true); vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('reports the crew when the vehicle is taken', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue({
      data: { in_use: true, crew_name: 'J. Mokoena', minutes_ago: 200,
              since: '2026-08-17T05:14:00Z' },
    } as any);

    const out = await checkVehicleInUse('emsmca', 'veh-1');
    expect(out?.in_use).toBe(true);
    expect(out?.crew_name).toBe('J. Mokoena');
  });

  it('says nothing when the vehicle is free', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue({ data: { in_use: false } } as any);
    expect(await checkVehicleInUse('emsmca', 'veh-1')).toBeNull();
  });

  it('never calls the server while offline', async () => {
    setOnline(false);
    const get = vi.spyOn(axios, 'get');
    expect(await checkVehicleInUse('emsmca', 'veh-1')).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it('fails open when the server errors', async () => {
    vi.spyOn(axios, 'get').mockRejectedValue(new Error('Network Error'));
    expect(await checkVehicleInUse('emsmca', 'veh-1')).toBeNull();
  });

  it('fails open on a 401 from a device with no grant', async () => {
    vi.spyOn(axios, 'get').mockRejectedValue({ response: { status: 401 } });
    expect(await checkVehicleInUse('emsmca', 'veh-1')).toBeNull();
  });

  it('caps the wait so a bad link cannot hold up a shift start', async () => {
    const get = vi.spyOn(axios, 'get').mockResolvedValue({ data: { in_use: false } } as any);
    await checkVehicleInUse('emsmca', 'veh-1');
    expect(get.mock.calls[0][1]).toMatchObject({ timeout: 3000 });
  });

  it('says nothing when the slug is missing', async () => {
    const get = vi.spyOn(axios, 'get');
    expect(await checkVehicleInUse(undefined, 'veh-1')).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });
});

describe('confirmTakeOccupiedVehicle', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('names the crew, the callsign and the sign-on time', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    confirmTakeOccupiedVehicle('ALPHA 12', {
      in_use: true, crew_name: 'J. Mokoena', partner_name: 'S. Ndlovu',
      since: '2026-08-17T05:14:00Z', minutes_ago: 200,
    });
    const msg = confirm.mock.calls[0][0] as string;
    expect(msg).toContain('ALPHA 12');
    expect(msg).toContain('J. Mokoena');
    expect(msg).toContain('S. Ndlovu');
    expect(msg).toContain('3h 20m ago');
  });

  it('still reads sensibly when the server sent no name or time', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    confirmTakeOccupiedVehicle('ALPHA 12', { in_use: true });
    const msg = confirm.mock.calls[0][0] as string;
    expect(msg).toContain('ALPHA 12');
    expect(msg).toContain('Another crew');
    expect(msg).not.toContain('undefined');
    expect(msg).not.toContain('NaN');
  });

  it('carries the crew through when they choose to continue', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    expect(confirmTakeOccupiedVehicle('ALPHA 12', { in_use: true })).toBe(true);
  });

  it('backs out when they decline', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    expect(confirmTakeOccupiedVehicle('ALPHA 12', { in_use: true })).toBe(false);
  });
});

describe('claimVehicle', () => {
  beforeEach(() => { setOnline(true); vi.restoreAllMocks(); });

  it('sends the vehicle with the crew token', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ data: {} } as any);
    await claimVehicle('crew-token', 'veh-1');
    expect(post.mock.calls[0][0]).toBe('/api/crew/claim-vehicle');
    expect(post.mock.calls[0][1]).toEqual({ vehicle_id: 'veh-1' });
    expect((post.mock.calls[0][2] as any).headers.Authorization).toBe('Bearer crew-token');
  });

  it('swallows a failure — a shift that started matters more than the warning', async () => {
    vi.spyOn(axios, 'post').mockRejectedValue(new Error('500'));
    await expect(claimVehicle('crew-token', 'veh-1')).resolves.toBeUndefined();
  });

  it('does not try while offline', async () => {
    setOnline(false);
    const post = vi.spyOn(axios, 'post');
    await claimVehicle('crew-token', 'veh-1');
    expect(post).not.toHaveBeenCalled();
  });
});
