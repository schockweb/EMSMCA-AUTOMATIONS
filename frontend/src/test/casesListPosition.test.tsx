/**
 * Coming back from a PRF must land where you left, not at the top of page 1.
 *
 * The bug: `page` and `searchTerm` were plain component state. Opening a PRF
 * unmounts the list, so Back rebuilt it from nothing — page 7 of a search
 * became page 1 of everything. Reviewing a page of cases meant paging back out
 * after every single document, and the further into the list you were, the
 * worse it got, which is why it survived every casual test.
 *
 * These tests drive the component through the real thing: render at a URL,
 * click through, and assert on what the list asks the SERVER for — the skip
 * offset is the honest witness to which page is actually being shown.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import Cases from '../pages/Cases';
import api from '../api/client';

// Dated newest-first, because the list sorts created_at DESC — so case-1 is
// the top row and "click the first View PRF" means something definite.
const mkCase = (i: number) => ({
  id: `case-${i}`,
  display_name: `PRF ${1000 + i}`,
  patient_name: `Patient ${i}`,
  preauth_status: 'none',
  created_at: `2026-08-${20 - i}T08:00:00Z`,
});

/** Records every /api/cases/ list URL the page requests. */
const listCalls: string[] = [];

function stubApi(pageCases = [mkCase(1), mkCase(2), mkCase(3)], total = 1000) {
  vi.spyOn(api, 'get').mockImplementation((url: string) => {
    if (url.startsWith('/api/cases/?')) {
      listCalls.push(url);
      return Promise.resolve({ data: pageCases });
    }
    if (url.startsWith('/api/cases/count')) return Promise.resolve({ data: { total } });
    if (url.startsWith('/api/failed-prfs/stats')) return Promise.resolve({ data: {} });
    if (url.startsWith('/api/adjudication/rfis')) return Promise.resolve({ data: [] });
    return Promise.resolve({ data: {} });
  });
  vi.spyOn(api, 'patch').mockResolvedValue({ data: {} } as any);
}

const renderAt = (url: string) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/cases" element={<Cases />} />
        <Route path="/cases/:id/prf" element={<div>PDF VIEW</div>} />
      </Routes>
    </MemoryRouter>,
  );

const lastSkip = () => {
  const url = listCalls[listCalls.length - 1];
  return Number(new URL(`http://x${url}`).searchParams.get('skip'));
};

beforeEach(() => { listCalls.length = 0; sessionStorage.clear(); stubApi(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('the list position survives leaving the page', () => {
  it('opens at page 1 when the URL says nothing', async () => {
    renderAt('/cases');
    await waitFor(() => expect(listCalls.length).toBeGreaterThan(0));
    expect(lastSkip()).toBe(0);
  });

  it('restores the page from the URL — the actual bug', async () => {
    renderAt('/cases?page=7');
    await waitFor(() => expect(listCalls.length).toBeGreaterThan(0));
    // PAGE_SIZE 50 → page 7 starts at record 300.
    expect(lastSkip()).toBe(300);
  });

  it('restores the search term too, so Back does not silently widen the list', async () => {
    renderAt('/cases?q=Mokoena');
    await waitFor(() => expect(listCalls.length).toBeGreaterThan(0));
    expect(listCalls[listCalls.length - 1]).toContain('search=Mokoena');
  });

  it('restores page AND search together', async () => {
    renderAt('/cases?page=3&q=Mokoena');
    await waitFor(() => expect(listCalls.length).toBeGreaterThan(0));
    expect(lastSkip()).toBe(100);
    expect(listCalls[listCalls.length - 1]).toContain('search=Mokoena');
  });

  it('does not let the mount-time search reset wipe a restored page', async () => {
    // The reset-to-page-1-on-new-search effect also fires on mount. Unguarded
    // it would undo the restore a tick later — the list would flash page 7 and
    // settle on page 1, which is indistinguishable from the original bug.
    renderAt('/cases?page=7');
    await waitFor(() => expect(listCalls.length).toBeGreaterThan(0));
    await new Promise(r => setTimeout(r, 450));   // past the 300ms fetch debounce
    expect(lastSkip()).toBe(300);
  });

  it('clamps a page that has run off the end instead of stranding the user', async () => {
    // A URL can now outlive the list it described — a bookmark, a refresh, a
    // link shared when there were more results. Past the last page the table
    // is empty AND the pager is hidden, so there is no control left to climb
    // back with. 3 results = one page, so ?page=99 must settle on page 1.
    stubApi([mkCase(1), mkCase(2), mkCase(3)], 3);
    renderAt('/cases?page=99');
    // First request goes out at the bad offset; the clamp then refetches at 0.
    await waitFor(() => expect(lastSkip()).toBe(0), { timeout: 2000 });
    await waitFor(() => expect(screen.getAllByText(/PRF 1001/).length).toBeGreaterThan(0));
  });

  it('writes the page into the URL when the user pages forward', async () => {
    renderAt('/cases');
    await waitFor(() => expect(screen.getAllByText(/PRF 1001/).length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText(/Next/));
    await waitFor(() => expect(lastSkip()).toBe(50));
  });
});

describe('returning to the case you clicked', () => {
  it('leaves a note naming the case, the page and the search', async () => {
    renderAt('/cases?page=2&q=Naidoo');
    await waitFor(() => expect(screen.getAllByText(/PRF 1001/).length).toBeGreaterThan(0));

    fireEvent.click(screen.getAllByText('View PRF')[0]);
    await waitFor(() => expect(screen.getByText('PDF VIEW')).toBeTruthy());

    const note = JSON.parse(sessionStorage.getItem('cases_focus_return') || '{}');
    expect(note).toMatchObject({ id: 'case-1', page: 1, q: 'Naidoo' });
  });

  it('ignores a note left against a different page', async () => {
    // Wandering off and coming back later must not highlight a row at random.
    sessionStorage.setItem('cases_focus_return',
      JSON.stringify({ id: 'case-1', page: 5, q: '' }));
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    renderAt('/cases');
    await waitFor(() => expect(screen.getAllByText(/PRF 1001/).length).toBeGreaterThan(0));
    await new Promise(r => setTimeout(r, 100));
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('scrolls the row back into view when the note matches', async () => {
    sessionStorage.setItem('cases_focus_return',
      JSON.stringify({ id: 'case-2', page: 0, q: '' }));
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    renderAt('/cases');
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
  });

  it('consumes the note once — a later visit is not highlighted again', async () => {
    sessionStorage.setItem('cases_focus_return',
      JSON.stringify({ id: 'case-2', page: 0, q: '' }));
    renderAt('/cases');
    await waitFor(() => expect(screen.getAllByText(/PRF 1001/).length).toBeGreaterThan(0));
    expect(sessionStorage.getItem('cases_focus_return')).toBeNull();
  });
});
