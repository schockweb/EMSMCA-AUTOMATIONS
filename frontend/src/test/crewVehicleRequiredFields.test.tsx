/**
 * You cannot save a crew member without an HPCSA number, or a vehicle without
 * a callsign and registration.
 *
 * The HPCSA number is why this exists. It was optional on the form and
 * compulsory on the document: a crew member saved without one looked perfectly
 * fine on this page, and then printed a dash where their registration number
 * belongs on every report they signed — on a record a medical scheme
 * adjudicates. It was found by inspecting a finished PDF, which is the worst
 * place to find it and the last place anyone looks.
 *
 * The gate is on the BUTTON rather than on submit, so the operator sees what is
 * outstanding while they are still typing. That is a UI-shaped rule, so only
 * driving the UI can prove it — hence clicking real buttons and asserting that
 * no request left the page.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const PROVIDERS = [{
  id: 'p1', name: 'Michaels EMS', slug: 'michaels-ems',
  pr_number: 'PR1', phone: '011', email: 'a@x.test', address: 'A',
  is_active: true, crew_count: 1, vehicle_count: 1, prf_count: 0, created_at: null,
}];
const CREW = [
  { id: 'c1', full_name: 'A. Mokoena', email: 'a@x.test', initials: 'AM',
    hpcsa_number: 'AEA0001', qualification: 'AEA', phone: '', role: 'crew', is_active: true },
  // A back-office login. Real ones exist on production with no HPCSA number.
  { id: 'c2', full_name: 'MichaelsEMS Admin', email: 'admin@x.test', initials: '',
    hpcsa_number: '', qualification: 'ILS', phone: '', role: 'admin', is_active: true },
];
const VEHICLES = [{ id: 'v1', callsign: 'ALPHA 12', registration: 'GP 123-456', vehicle_type: 'Ambulance' }];

vi.mock('../api/client', () => {
  const post = vi.fn(async () => ({ data: { id: 'new', temp_password: 'x' } }));
  const patch = vi.fn(async () => ({ data: {} }));
  const get = vi.fn(async (url: string) => {
    if (url.includes('/account-security')) return { data: [] };
    if (url.includes('/crew')) return { data: CREW };
    if (url.includes('/vehicles')) return { data: VEHICLES };
    return { data: PROVIDERS };
  });
  return { default: { get, post, patch, delete: vi.fn() } };
});

import api from '../api/client';
import ProviderManagement from '../pages/ProviderManagement';

/** Inputs here are unlabelled; find them by their visible label's sibling. */
const fieldUnder = (labelText: string): HTMLInputElement => {
  const label = screen.getAllByText(labelText)[0];
  const el = label.parentElement?.querySelector('input, textarea');
  if (!el) throw new Error(`no input under "${labelText}"`);
  return el as HTMLInputElement;
};
const type = (labelText: string, value: string) =>
  fireEvent.change(fieldUnder(labelText), { target: { value } });
const btn = (name: string) =>
  screen.getAllByRole('button', { name }).slice(-1)[0] as HTMLButtonElement;

/** Open a client, then the named tab and its Add modal. */
const openAddModal = async (which: 'crew' | 'vehicle') => {
  render(<MemoryRouter><ProviderManagement /></MemoryRouter>);
  await waitFor(() => expect(screen.getAllByText('Michaels EMS').length).toBeGreaterThan(0));
  fireEvent.click(screen.getAllByText('Michaels EMS')[0]);
  if (which === 'vehicle') {
    await waitFor(() => expect(screen.getAllByText(/Vehicles \(/).length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText(/Vehicles \(/)[0]);
    await waitFor(() => expect(screen.getByText('+ Add Vehicle')).toBeTruthy());
    fireEvent.click(screen.getByText('+ Add Vehicle'));
    await waitFor(() => expect(screen.getByText('Add Vehicle', { selector: 'button' })).toBeTruthy());
  } else {
    await waitFor(() => expect(screen.getByText('+ Add Crew')).toBeTruthy());
    fireEvent.click(screen.getByText('+ Add Crew'));
    await waitFor(() => expect(screen.getByText('Add Crew Member', { selector: 'div' })).toBeTruthy());
  }
};

beforeEach(() => { vi.clearAllMocks(); window.alert = vi.fn(); });
afterEach(() => cleanup());

describe('Add Crew Member', () => {
  it('is disabled on an empty form', async () => {
    await openAddModal('crew');
    expect(btn('Add Crew Member').disabled).toBe(true);
  });

  it('stays disabled with a name but no HPCSA number — the original hole', async () => {
    await openAddModal('crew');
    type('Full Name *', 'S. Ndlovu');
    await waitFor(() => expect(btn('Add Crew Member').disabled).toBe(true));
  });

  it('stays disabled with an HPCSA number but no name', async () => {
    await openAddModal('crew');
    type('HPCSA Number *', 'AEA0042');
    await waitFor(() => expect(btn('Add Crew Member').disabled).toBe(true));
  });

  it('treats blank space as blank', async () => {
    await openAddModal('crew');
    type('Full Name *', 'S. Ndlovu');
    type('HPCSA Number *', '   ');
    await waitFor(() => expect(btn('Add Crew Member').disabled).toBe(true));
  });

  it('enables once both are filled, and then actually saves', async () => {
    await openAddModal('crew');
    type('Full Name *', 'S. Ndlovu');
    type('HPCSA Number *', 'AEA0042');
    await waitFor(() => expect(btn('Add Crew Member').disabled).toBe(false));

    fireEvent.click(btn('Add Crew Member'));
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const [url, body] = (api.post as any).mock.calls[0];
    expect(url).toContain('/crew');
    expect(body).toMatchObject({ full_name: 'S. Ndlovu', hpcsa_number: 'AEA0042' });
  });

  it('sends nothing while incomplete, even if the click is forced', async () => {
    // The disabled attribute is the visible half. The handler refuses too, so
    // the rule does not rest on a style prop somebody later "tidies up".
    await openAddModal('crew');
    type('Full Name *', 'S. Ndlovu');
    fireEvent.click(btn('Add Crew Member'));
    await new Promise(r => setTimeout(r, 60));
    expect(api.post).not.toHaveBeenCalled();
  });
});

describe('Add Vehicle', () => {
  it('is disabled on an empty form', async () => {
    await openAddModal('vehicle');
    expect(btn('Add Vehicle').disabled).toBe(true);
  });

  it('stays disabled with a callsign but no registration', async () => {
    await openAddModal('vehicle');
    type('Callsign *', 'ALPHA 13');
    await waitFor(() => expect(btn('Add Vehicle').disabled).toBe(true));
  });

  it('stays disabled with a registration but no callsign', async () => {
    await openAddModal('vehicle');
    type('Registration *', 'GP 999-000');
    await waitFor(() => expect(btn('Add Vehicle').disabled).toBe(true));
  });

  it('enables once both are filled, and then actually saves', async () => {
    await openAddModal('vehicle');
    type('Callsign *', 'ALPHA 13');
    type('Registration *', 'GP 999-000');
    await waitFor(() => expect(btn('Add Vehicle').disabled).toBe(false));

    fireEvent.click(btn('Add Vehicle'));
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const [url, body] = (api.post as any).mock.calls[0];
    expect(url).toContain('/vehicles');
    expect(body).toMatchObject({ callsign: 'ALPHA 13', registration: 'GP 999-000' });
  });

  it('sends nothing while incomplete, even if the click is forced', async () => {
    await openAddModal('vehicle');
    type('Callsign *', 'ALPHA 13');
    fireEvent.click(btn('Add Vehicle'));
    await new Promise(r => setTimeout(r, 60));
    expect(api.post).not.toHaveBeenCalled();
  });
});

describe('Edit Crew Member', () => {
  const openEdit = async (which: 'practitioner' | 'admin') => {
    render(<MemoryRouter><ProviderManagement /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByText('Michaels EMS').length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText('Michaels EMS')[0]);
    const name = which === 'admin' ? 'MichaelsEMS Admin' : 'A. Mokoena';
    await waitFor(() => expect(screen.getAllByText(name).length).toBeGreaterThan(0));
    const row = screen.getAllByText(name)[0].closest('tr') || screen.getAllByText(name)[0].parentElement!;
    const edit = [...row.querySelectorAll('button')].find(b => /edit/i.test(b.title || b.getAttribute('aria-label') || ''));
    fireEvent.click(edit!);
    await waitFor(() => expect(screen.getByText('Edit Crew Member')).toBeTruthy());
  };

  it('will not let a practitioner have their HPCSA number blanked', async () => {
    await openEdit('practitioner');
    expect(btn('Save Changes').disabled).toBe(false);
    type('HPCSA Number *', '');
    await waitFor(() => expect(btn('Save Changes').disabled).toBe(true));
  });

  it('offers no Email or Phone field, and never sends either', async () => {
    // Email was dead: the value shown was the auto-generated portal
    // placeholder, and the PATCH schema (CrewMemberUpdate) has no `email`
    // field, so edits to it were silently discarded server-side — crew sign in
    // with their HPCSA number via the portal grant. Phone did save; it was
    // dropped by request, and stays editable on the provider's own dashboard.
    // Add Crew Member has never offered either.
    await openEdit('practitioner');
    expect(screen.queryByText('Email (for Portal Login) *')).toBeNull();
    // 'Phone' scoped to the modal: the crew table behind it still lists one.
    const modal = screen.getByText('Edit Crew Member').closest('div')!.parentElement!;
    expect([...modal.querySelectorAll('label')].map(l => l.textContent))
      .toEqual(['Full Name *', 'Initials', 'HPCSA Number *', 'Qualification']);

    type('Full Name *', 'A. Mokoena-Smith');
    fireEvent.click(btn('Save Changes'));
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    const [, body] = (api.patch as any).mock.calls[0];
    expect(body).toEqual({
      full_name: 'A. Mokoena-Smith', initials: 'AM',
      hpcsa_number: 'AEA0001', qualification: 'AEA',
    });
  });

  it('does not demand one from a back-office admin login', async () => {
    // These records legitimately have no registration number. Requiring one
    // would make them uneditable, or get a fake number typed in — which is
    // worse than the blank the gate exists to prevent.
    await openEdit('admin');
    // Prove we are actually on the admin record before trusting the verdict:
    // opening the wrong row would have an HPCSA number in it and the button
    // would be enabled for the wrong reason.
    expect(fieldUnder('Full Name *').value).toBe('MichaelsEMS Admin');
    expect(fieldUnder('HPCSA Number').value).toBe('');
    expect(btn('Save Changes').disabled).toBe(false);
  });
});
