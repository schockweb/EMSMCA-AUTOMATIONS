/**
 * The Add New Client modal, driven the way an admin worker drives it.
 *
 * The backend suites prove the API behaves under a hundred entries. They cannot
 * see the failure that actually put one company's credentials on another's
 * record, because it never reached the API: the modal kept its state when it
 * was cancelled, so the NEXT client created inherited the previous one's logo,
 * portal password, admin password and Gmail app password. That is a pure
 * front-end state bug, and only driving the form can catch it.
 *
 * So these tests type into the real inputs, click the real buttons, and assert
 * on what the worker would see — including the request bodies actually sent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../api/client', () => {
  const post = vi.fn(async () => ({ data: { id: 'new-id', name: 'X', slug: 'x' } }));
  const get = vi.fn(async (url: string) => {
    if (url.includes('/account-security')) return { data: [] };
    return { data: EXISTING };
  });
  return { default: { get, post, patch: vi.fn(async () => ({ data: {} })), delete: vi.fn() } };
});

import api from '../api/client';
import ProviderManagement, { slugifyProviderName } from '../pages/ProviderManagement';

/** Two clients already onboarded, as the Clients page would have loaded them. */
const EXISTING = [
  {
    id: 'p1', name: 'Michaels EMS', slug: 'michaels-ems',
    pr_number: 'PR1', phone: '011', email: 'a@x.test', address: 'A',
    is_active: true, crew_count: 3, vehicle_count: 1, prf_count: 0, created_at: null,
    portal_login_username: 'michaels@x.test', admin_email: 'admin@michaels.test',
  },
];

const renderPage = () =>
  render(<MemoryRouter><ProviderManagement /></MemoryRouter>);

const openModal = async () => {
  await waitFor(() => expect(screen.getByText('+ Add Provider')).toBeTruthy());
  fireEvent.click(screen.getByText('+ Add Provider'));
  await waitFor(() => expect(screen.getByText('Add New Client')).toBeTruthy());
};

/** Inputs are unlabelled in this modal, so find by the visible label's sibling. */
const fieldUnder = (labelText: string): HTMLInputElement => {
  const label = screen.getAllByText(labelText)[0];
  const field = label.parentElement?.querySelector('input, textarea');
  if (!field) throw new Error(`no input under "${labelText}"`);
  return field as HTMLInputElement;
};

beforeEach(() => {
  vi.clearAllMocks();
  window.alert = vi.fn();
});
afterEach(cleanup);

describe('slug prediction matches the backend', () => {
  // A drifting port would show confident, wrong warnings. These are the exact
  // pairs verified against _slugify in backend/app/api/providers.py.
  it.each([
    ['Michaels EMS', 'michaels-ems'],
    ['MichaelsEMS', 'michaelsems'],
    ['Michaels E.M.S.', 'michaels-ems'],
    ['  Netcare 911  ', 'netcare-911'],
    ['!!! ???', ''],
    ['ER24 (Pty) Ltd', 'er24-pty-ltd'],
    ['A--B', 'a-b'],
    ['-lead-', 'lead'],
  ])('%s -> %s', (input, expected) => {
    expect(slugifyProviderName(input)).toBe(expected);
  });
});

describe('Add New Client — warnings before the work is lost', () => {
  it('warns while typing a name that would collide with an existing client', async () => {
    renderPage();
    await openModal();

    // Not the same string, but it reduces to the same slug — which is exactly
    // the case a worker cannot be expected to spot unaided.
    fireEvent.change(fieldUnder('Company Name *'), { target: { value: 'Michaels E.M.S.' } });

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/michaels-ems/i);
    });
    expect(screen.getByRole('alert').textContent).toMatch(/Michaels EMS/);
  });

  it('does not warn for a name that is genuinely distinct', async () => {
    renderPage();
    await openModal();
    fireEvent.change(fieldUnder('Company Name *'), { target: { value: 'Durban Rescue' } });
    await waitFor(() => expect(fieldUnder('Company Name *').value).toBe('Durban Rescue'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('warns that a punctuation-only name cannot make a web address', async () => {
    renderPage();
    await openModal();
    fireEvent.change(fieldUnder('Company Name *'), { target: { value: '!!! ???' } });
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/no letters or numbers/i));
  });
});

describe('Add New Client — the form must not carry data between clients', () => {
  // Verified by re-injecting the original defect: with NEITHER openAddProvider
  // nor closeAddProvider clearing, all three of these fail
  // ("expected 'Alpha EMS' to be ''"). Removing only the close-side clear does
  // NOT fail them — opening is the load-bearing half, because every path into
  // this modal goes through the + Add Provider button. The close-side clear is
  // kept as defence in depth: it also stops a cancelled client's passwords and
  // Gmail app password sitting in component state for the rest of the session.
  it('is empty again after Cancel, so the next client inherits nothing', async () => {
    renderPage();
    await openModal();

    fieldUnder('Company Name *').value;
    fireEvent.change(fieldUnder('Company Name *'), { target: { value: 'Alpha EMS' } });
    fireEvent.change(fieldUnder('Phone Number'), { target: { value: '011 555 0000' } });

    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() => expect(screen.queryByText('Add New Client')).toBeNull());

    // Ten minutes later, the next client.
    fireEvent.click(screen.getByText('+ Add Provider'));
    await waitFor(() => expect(screen.getByText('Add New Client')).toBeTruthy());

    expect(fieldUnder('Company Name *').value, 'the previous client\'s name is still here').toBe('');
    expect(fieldUnder('Phone Number').value, 'the previous client\'s phone is still here').toBe('');
  });

  it('is empty again after the × close', async () => {
    renderPage();
    await openModal();
    fireEvent.change(fieldUnder('Company Name *'), { target: { value: 'Beta EMS' } });

    fireEvent.click(screen.getByText('×'));
    await waitFor(() => expect(screen.queryByText('Add New Client')).toBeNull());

    fireEvent.click(screen.getByText('+ Add Provider'));
    await waitFor(() => expect(screen.getByText('Add New Client')).toBeTruthy());
    expect(fieldUnder('Company Name *').value).toBe('');
  });

  it('sends only the client being created, never a leftover field', async () => {
    renderPage();
    await openModal();
    fireEvent.change(fieldUnder('Company Name *'), { target: { value: 'Gamma EMS' } });
    fireEvent.change(fieldUnder('Phone Number'), { target: { value: '011 111 1111' } });
    fireEvent.click(screen.getByText('Cancel'));

    fireEvent.click(screen.getByText('+ Add Provider'));
    await waitFor(() => expect(screen.getByText('Add New Client')).toBeTruthy());
    fireEvent.change(fieldUnder('Company Name *'), { target: { value: 'Delta EMS' } });
    fireEvent.click(screen.getByText('Create Client'));

    await waitFor(() => {
      const call = (api.post as any).mock.calls.find((c: any[]) => c[0] === '/api/providers');
      expect(call, 'no create request was sent').toBeTruthy();
      expect(call[1].name).toBe('Delta EMS');
      // The give-away that state carried over.
      expect(call[1].phone ?? '').toBe('');
    });
  });
});

describe('Add New Client — the submit button', () => {
  it('refuses a blank name WITHOUT locking itself up afterwards', async () => {
    // The in-flight guard is set before the request; an early return placed
    // after it left the button permanently disabled until a page reload.
    renderPage();
    await openModal();

    fireEvent.click(screen.getByText('Create Client'));
    await waitFor(() => expect(window.alert).toHaveBeenCalled());

    const btn = screen.getByText('Create Client') as HTMLButtonElement;
    expect(btn.disabled, 'the button stayed disabled after a validation refusal').toBe(false);

    // And it still works immediately afterwards.
    fireEvent.change(fieldUnder('Company Name *'), { target: { value: 'Epsilon EMS' } });
    fireEvent.click(screen.getByText('Create Client'));
    await waitFor(() =>
      expect((api.post as any).mock.calls.some((c: any[]) => c[0] === '/api/providers')).toBe(true));
  });

  it('does not fire twice when double-clicked', async () => {
    let resolve: (v: any) => void = () => {};
    (api.post as any).mockImplementationOnce(
      () => new Promise(r => { resolve = r; }));

    renderPage();
    await openModal();
    fireEvent.change(fieldUnder('Company Name *'), { target: { value: 'Zeta EMS' } });

    const btn = screen.getByText(/Create Client|Creating/) as HTMLButtonElement;
    fireEvent.click(btn);
    fireEvent.click(btn);          // the impatient second click
    fireEvent.click(btn);

    resolve({ data: { id: 'x', name: 'Zeta EMS', slug: 'zeta-ems' } });

    await waitFor(() => {
      const creates = (api.post as any).mock.calls.filter((c: any[]) => c[0] === '/api/providers');
      expect(creates.length, 'a double-click created the client more than once').toBe(1);
    });
  });
});
