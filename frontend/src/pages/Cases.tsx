import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import api from '../api/client';
import { useScrollLock } from '../hooks/useScrollLock';
import useIsMobile from '../hooks/useIsMobile';

interface Case {
  id: string;
  file_name?: string;
  original_filename?: string;
  display_name?: string;
  custom_display_name?: string;
  extracted_data?: Record<string, any>;
  patient_name: string;
  patient_id_number?: string;
  patient_dob?: string;
  medical_scheme_name?: string;
  scheme_member_number?: string;
  incident_date?: string;
  incident_location?: string;
  preauth_number?: string;
  preauth_status: string;
  dependant_code?: string;
  dispatch_type?: string;
  referring_doctor_pr?: string;
  auth_flag?: boolean;
  auth_flag_reason?: string;
  document_id?: string;
  claim_id?: string;
  adjudication_status?: string;
  created_at: string;
}

interface RFI {
  id: string;
  claim_id: string;
  rfi_status: string;
  priority: string;
  reason_code: string;
  reason_description: string;
  document_id: string;
  missing_fields?: Record<string, any> | null;
  created_at: string;
}

export default function Cases() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [cases, setCases] = useState<Case[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [total, setTotal] = useState(0);
  // Server-side paging. The list used to pull a flat 200 and tell the user
  // "showing 200 of N" — everything past the 200th was reachable only by
  // guessing a search term. At ~1500 PRFs a day that is most of a day's work
  // invisible by lunchtime, so the page walks the whole set instead.
  const PAGE_SIZE = 50;
  const [page, setPage] = useState(0);

  // Failed-PRF alert (amber triangle in the header). Counts PRFs that failed
  // processing + ones stuck in SUBMITTED with no case. When > 0 the triangle
  // appears; clicking it opens a popup tile that states what's wrong with
  // each PRF and provides the fix (Retry). There is deliberately no separate
  // Failed Forms page.
  const [failedCount, setFailedCount] = useState(0);
  const [showFailedAlert, setShowFailedAlert] = useState(false);

  // Rename dialog state
  const [renameCase, setRenameCase] = useState<Case | null>(null);

  // RFI Queue State
  const [showRfiQueue, setShowRfiQueue] = useState(false);
  const [rfis, setRfis] = useState<RFI[]>([]);
  const [rfiLoading, setRfiLoading] = useState(false);

  // Formatting state matching Admin Queue
  const [prfNameTemplate, setPrfNameTemplate] = useState<string[]>(['provider_practice_number', 'prf_number', 'medical_scheme']);
  const nameSeparator = localStorage.getItem('prf_name_separator') || ' . ';

  useEffect(() => {
    loadRFIs();
    // Load PRF name template from settings
    api.get('/api/knowledge-base/extraction-settings')
       .then(res => {
         if (res.data.prf_name_template) setPrfNameTemplate(res.data.prf_name_template);
       })
       .catch(() => {});
  }, []);

  // Failed-PRF alert poll: on mount and every 60s, so the triangle "pops up"
  // for staff already sitting on this page — not just on a reload. A fetch
  // error leaves the count unchanged (never falsely clears an active alert).
  const fetchFailedStats = async () => {
    try {
      const res = await api.get('/api/failed-prfs/stats');
      setFailedCount((res.data?.total_failed ?? 0) + (res.data?.total_stuck ?? 0));
    } catch { /* keep last known count */ }
  };
  useEffect(() => {
    fetchFailedStats();
    const id = setInterval(fetchFailedStats, 60000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Server-side search (debounced). Fires on mount too (empty term = full list),
  // so 7 years of retained cases stay reachable — matching happens on the server,
  // not just within the loaded page. See GET /api/cases + /api/cases/count.
  // A new search restarts at page 1 — staying on page 12 of the old result set
  // would show an empty list and read as "no matches".
  useEffect(() => { setPage(0); }, [searchTerm]);

  useEffect(() => {
    const t = setTimeout(() => { fetchCases(); }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchTerm, page]);

  useEffect(() => {
    if (showRfiQueue) loadRFIs();
  }, [showRfiQueue]);

  const loadRFIs = async () => {
    setRfiLoading(true);
    try {
      const res = await api.get('/api/adjudication/rfis');
      setRfis(res.data);
    } catch {
      /* ignore */
    } finally {
      setRfiLoading(false);
    }
  };

  const getPrfDisplayName = (c: Case): string => {
    // Prefer the backend's canonical PRF name (matches the exported-PDF filename:
    // "{PREFIX}{prf_number} PRF {scheme} {call_type}"). Falls back to the OCR
    // extraction template only when no DigitalPRF is linked to the case.
    if (c.display_name) return c.display_name;
    const data = c.extracted_data;
    if (!data) return c.original_filename || c.file_name || 'Unknown File';
    const parts = prfNameTemplate
      .map(key => (data[key] || '').toString().trim())
      .filter(Boolean);
    return parts.length > 0 ? parts.join(nameSeparator) : c.original_filename || c.file_name || 'Unknown File';
  };

  const fetchCases = async () => {
    try {
      setLoading(true);
      const term = searchTerm.trim();
      const searchQs = term ? `&search=${encodeURIComponent(term)}` : '';
      // One page at a time, plus the true total so the pager knows how far it
      // can walk. The list is ordered created_at DESC, id DESC server-side, so
      // skip/limit is stable and a record cannot appear on two pages.
      const [listRes, countRes] = await Promise.all([
        api.get(`/api/cases/?queue=management&skip=${page * PAGE_SIZE}&limit=${PAGE_SIZE}${searchQs}`),
        api.get(`/api/cases/count?queue=management${searchQs}`),
      ]);
      setCases(listRes.data);
      setTotal(countRes.data?.total ?? listRes.data.length);
      setError('');
    } catch (err: any) {
      setError(err.message || 'Failed to fetch cases');
    } finally {
      setLoading(false);
    }
  };

  const saveRename = async (caseId: string, newName: string) => {
    const cleaned = newName.trim();
    // Persist the override; empty string clears it and reverts to the computed name.
    const res = await api.patch(`/api/cases/${caseId}`, { custom_display_name: cleaned });
    const updated = res.data as Case;
    setCases(prev => prev.map(c => c.id === caseId
      ? { ...c, custom_display_name: updated.custom_display_name, display_name: updated.display_name }
      : c));
    setRenameCase(null);
  };

  // Scheme-configuration warnings are PARKED (user request, 2026-08-13): the
  // auth_flag feature still needs tuning before it goes in front of the
  // client, so the footer chip, the amber row tint and the flagged-first
  // sort are all disabled together. Flip this one constant to re-enable.
  const SHOW_SCHEME_CONFIG_WARNINGS = false;

  // Search is now server-side (so it reaches the full 7-year history, not just
  // the loaded page) — `cases` already holds the matches. Here we only pin
  // flagged cases to the top (while the warnings are live) and sort the rest
  // newest-first.
  const sortedCases = [...cases].sort((a, b) => {
    if (SHOW_SCHEME_CONFIG_WARNINGS) {
      if (a.auth_flag && !b.auth_flag) return -1;
      if (!a.auth_flag && b.auth_flag) return 1;
    }
    return new Date(b.created_at || '').getTime() - new Date(a.created_at || '').getTime();
  });

  const flaggedCount = SHOW_SCHEME_CONFIG_WARNINGS ? cases.filter(c => c.auth_flag).length : 0;
  const activeRfis = rfis.filter(r => cases.some(c => c.claim_id === r.claim_id));
  const openRfiCount = activeRfis.filter(r => r.rfi_status === 'open').length;

  return (
    <div className="page-content" style={{ padding: isMobile ? '14px 0 32px' : '28px 36px 48px', maxWidth: 1320, margin: '0 auto', fontFamily: 'var(--font-sans)' }}>
      <style>{`
        @keyframes casesSpin { to { transform: rotate(360deg); } }
        @keyframes casesFadeUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes casesRowPulse  { 0%,100%{opacity:1} 50%{opacity:0.78} }
        @keyframes casesAlertPulse {
          0%,100% { box-shadow: 0 0 0 0 rgba(220,38,38,0.35); }
          50%     { box-shadow: 0 0 0 6px rgba(220,38,38,0); }
        }
        .cases-in { animation: casesFadeUp 0.4s ease-out forwards; }
        .cases-th { cursor:pointer; user-select:none; white-space:nowrap; }
        .cases-th:hover { color: var(--brand-teal); }
        .cases-table tbody tr:hover td { background: rgba(8,131,149,0.03); }
        .cases-table th { padding: 12px 16px; font-size:0.8rem; font-weight:700; text-transform:uppercase; letter-spacing:0.06em; color:var(--text-muted); background:var(--surface-50); border-bottom:1px solid var(--glass-border); }
        .cases-table td { padding: 13px 16px; border-bottom:1px solid var(--surface-100); vertical-align:middle; }
        .cases-table tbody tr:last-child td { border-bottom:none; }
      `}</style>

      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div className="cases-in" style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        gap: 16, marginBottom: 22, flexWrap: 'wrap',
      }}>
        <div>
          <h1 style={{
            fontSize: '1.7rem', fontWeight: 800, color: 'var(--text-primary)',
            margin: 0, letterSpacing: '-0.025em',
          }}>
            Case Management
          </h1>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {/* Amber triangle — appears when any PRF failed to process, so
              EMSMCA staff see it immediately from the Cases section. Click
              opens the popup tile explaining each problem + its fix. */}
          {failedCount > 0 && (
            <button
              onClick={() => setShowFailedAlert(true)}
              title={`${failedCount} PRF${failedCount === 1 ? '' : 's'} failed to process — click to review`}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '9px 16px', borderRadius: 'var(--radius-md)',
                border: '1px solid rgba(220,38,38,0.35)',
                background: 'rgba(245,124,0,0.09)',
                color: '#dc2626', fontWeight: 800, fontSize: '0.85rem',
                cursor: 'pointer', fontFamily: 'inherit',
                animation: 'casesAlertPulse 2s ease-in-out infinite',
                transition: 'transform var(--transition-fast)',
              }}
              onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-1px)'; }}
              onMouseLeave={e => { e.currentTarget.style.transform = 'none'; }}
            >
              {/* Warning triangle: amber fill, red outline */}
              <svg width="18" height="18" viewBox="0 0 24 24" fill="rgba(245,124,0,0.25)"
                stroke="#dc2626" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              {failedCount} PRF{failedCount === 1 ? '' : 's'} failed to process
            </button>
          )}
          <button onClick={() => { fetchCases(); fetchFailedStats(); }}
            style={{
              padding: '9px 16px', borderRadius: 'var(--radius-md)',
              border: '1px solid var(--glass-border)', background: 'var(--surface-0)',
              color: 'var(--text-secondary)', fontWeight: 600, fontSize: '0.85rem',
              cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 7,
              fontFamily: 'inherit', transition: 'all var(--transition-fast)',
            }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = 'rgba(8,131,149,0.3)'; e.currentTarget.style.color = 'var(--brand-teal)'; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--glass-border)'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
            </svg>
            Refresh
          </button>
        </div>
      </div>

      {/* ── Error ───────────────────────────────────────────────────────── */}
      {error && (
        <div className="cases-in" style={{
          padding: '12px 16px', background: 'rgba(220,38,38,0.06)', color: '#dc2626',
          borderRadius: 'var(--radius-md)', marginBottom: 16,
          border: '1px solid rgba(220,38,38,0.2)', fontSize: '0.85rem', fontWeight: 600,
        }}>
          {error}
        </div>
      )}

      {/* ── Toolbar ─────────────────────────────────────────────────────── */}
      <div className="cases-in" style={{ display: 'flex', gap: 12, marginBottom: 18, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ position: 'relative', flex: '1 1 320px', maxWidth: 460 }}>
          <svg style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
          <input value={searchTerm} onChange={e => setSearchTerm(e.target.value)}
            placeholder="Search patient, scheme, PRF number, auth…"
            style={{
              width: '100%', paddingLeft: 38, paddingRight: 14, paddingTop: 10, paddingBottom: 10,
              borderRadius: 'var(--radius-md)', border: '1px solid var(--glass-border)',
              fontSize: '0.86rem', outline: 'none',
              background: 'var(--surface-0)', color: 'var(--text-primary)',
              fontFamily: 'inherit', transition: 'all var(--transition-fast)',
            }}
            onFocus={e => { e.currentTarget.style.borderColor = 'var(--brand-teal)'; e.currentTarget.style.boxShadow = '0 0 0 3px rgba(8,131,149,0.12)'; }}
            onBlur={e => { e.currentTarget.style.borderColor = 'var(--glass-border)'; e.currentTarget.style.boxShadow = 'none'; }}
          />
        </div>
        <button onClick={() => setShowRfiQueue(true)}
          style={{
            padding: '9px 16px', borderRadius: 'var(--radius-md)',
            border: `1px solid ${openRfiCount > 0 ? 'rgba(8,131,149,0.35)' : 'var(--glass-border)'}`,
            background: openRfiCount > 0 ? 'rgba(8,131,149,0.06)' : 'var(--surface-0)',
            color: openRfiCount > 0 ? 'var(--brand-teal)' : 'var(--text-secondary)',
            fontWeight: 700, fontSize: '0.85rem', cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 8,
            fontFamily: 'inherit', transition: 'all var(--transition-fast)',
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" /><line x1="4" y1="22" x2="4" y2="15" /></svg>
          RFI Queue
          {openRfiCount > 0 && (
            <span style={{
              background: 'var(--brand-teal)', color: 'white', borderRadius: 99,
              fontSize: '0.7rem', fontWeight: 800, padding: '1px 8px',
            }}>{openRfiCount}</span>
          )}
        </button>
      </div>

      {/* ── Table ───────────────────────────────────────────────────────── */}
      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}>
          <div style={{ width: 36, height: 36, border: '3px solid var(--surface-200)', borderTopColor: 'var(--brand-teal)', borderRadius: '50%', animation: 'casesSpin 0.8s linear infinite' }} />
        </div>
      ) : sortedCases.length === 0 ? (
        <div className="cases-in" style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          padding: '80px 0', gap: 14, color: 'var(--text-muted)',
          background: 'var(--surface-0)', border: '1px solid var(--glass-border)',
          borderRadius: 'var(--radius-lg)', boxShadow: 'var(--glass-shadow)',
        }}>
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" style={{ opacity: 0.4 }}><path d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /></svg>
          <div style={{ fontWeight: 700, fontSize: '1rem', color: 'var(--text-secondary)' }}>{searchTerm.trim() ? 'No cases match your search' : 'No cases yet'}</div>
          <div style={{ fontSize: '0.85rem' }}>{searchTerm.trim() ? 'Try a different search term.' : 'Process a PRF document to generate a case.'}</div>
        </div>
      ) : (
        <div className="cases-in" style={{
          background: 'var(--surface-0)', border: '1px solid var(--glass-border)',
          borderRadius: 'var(--radius-lg)', overflow: 'hidden',
          boxShadow: 'var(--glass-shadow)',
        }}>
          {isMobile ? (
            /* Cards on a phone. The desktop layout is a two-column table whose
               PRF name is nowrap + ellipsis — at 375px that truncated almost
               every name to a few characters, and renaming was reachable only
               by DOUBLE-CLICK, which mobile browsers do not reliably deliver.
               Each card wraps the full name and carries explicit buttons. */
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {sortedCases.map(c => (
                <div key={c.id} style={{
                  padding: '14px 14px 12px',
                  borderBottom: '1px solid var(--surface-100)',
                  background: SHOW_SCHEME_CONFIG_WARNINGS && c.auth_flag ? 'rgba(245,124,0,0.04)' : undefined,
                }}>
                  <div style={{
                    fontWeight: 700, fontSize: '0.98rem', color: 'var(--text-primary)',
                    lineHeight: 1.35, wordBreak: 'break-word', marginBottom: 10,
                  }}>
                    {getPrfDisplayName(c)}
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={() => navigate(`/cases/${c.id}/prf`)}
                      style={{
                        flex: 1, minHeight: 44, borderRadius: 9, cursor: 'pointer',
                        border: '1px solid rgba(8,131,149,0.35)', background: 'rgba(8,131,149,0.06)',
                        color: 'var(--brand-teal)', fontSize: '0.88rem', fontWeight: 800,
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                      }}>
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>
                      View PRF
                    </button>
                    <button onClick={() => setRenameCase(c)}
                      style={{
                        minHeight: 44, padding: '0 16px', borderRadius: 9, cursor: 'pointer',
                        border: '1px solid var(--surface-200)', background: 'var(--surface-0)',
                        color: 'var(--text-secondary)', fontSize: '0.88rem', fontWeight: 700,
                      }}>
                      Rename
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
          <table className="cases-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th className="cases-th" style={{ paddingLeft: 16 }}>Patient / PRF</th>
                <th style={{ textAlign: 'right', paddingRight: 16 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sortedCases.map(c => (
                <tr key={c.id}
                  style={{ background: SHOW_SCHEME_CONFIG_WARNINGS && c.auth_flag ? 'rgba(245,124,0,0.04)' : undefined }}
                >

                  {/* Patient / PRF */}
                  <td style={{ maxWidth: 340 }}>
                    <div style={{ fontWeight: 600, fontSize: '1.02rem', color: 'var(--text-primary)', cursor: 'text', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', userSelect: 'none' }}
                      title="Double-click to rename"
                      onDoubleClick={() => setRenameCase(c)}>
                      {getPrfDisplayName(c)}
                    </div>
                  </td>

                  {/* Actions */}
                  <td style={{ paddingRight: 16 }}>
                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                      <button onClick={() => navigate(`/cases/${c.id}/prf`)}
                        title="View PRF (branded for scheme submission)"
                        style={{
                          padding: '7px 12px', borderRadius: 7, border: 'none', cursor: 'pointer',
                          fontSize: '0.92rem', fontWeight: 700, color: 'var(--brand-teal)',
                          background: 'transparent',
                          transition: 'background 0.15s',
                          display: 'inline-flex', alignItems: 'center', gap: 5,
                        }}
                        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(8,131,149,0.08)'; }}
                        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}>
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>
                        View PRF
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          )}
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '12px 20px', borderTop: '1px solid var(--surface-100)',
            background: 'var(--surface-50)',
          }}>
            <span style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
              {total === 0 ? 'No cases' : (
                <>
                  Showing <strong style={{ color: 'var(--text-primary)' }}>{page * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE + sortedCases.length, total)}</strong>
                  {' '}of <strong style={{ color: 'var(--text-primary)' }}>{total}</strong> cases
                </>
              )}
            </span>

            {/* Pager. Rendered whenever there is more than one page — at ~1500
                PRFs a day that is every day, so it is not an edge case. */}
            {total > PAGE_SIZE && (() => {
              const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
              const btn = (disabled: boolean): React.CSSProperties => ({
                padding: '5px 12px', fontSize: '0.8rem', fontWeight: 700,
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--surface-200)',
                background: disabled ? 'var(--surface-100)' : 'var(--surface-0)',
                color: disabled ? 'var(--text-muted)' : 'var(--text-primary)',
                cursor: disabled ? 'default' : 'pointer',
              });
              return (
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button type="button" style={btn(page === 0)} disabled={page === 0}
                          onClick={() => setPage(0)} title="First page">« First</button>
                  <button type="button" style={btn(page === 0)} disabled={page === 0}
                          onClick={() => setPage(p => Math.max(0, p - 1))}>‹ Prev</button>
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', minWidth: 96, textAlign: 'center' }}>
                    Page <strong style={{ color: 'var(--text-primary)' }}>{page + 1}</strong> of {pageCount}
                  </span>
                  <button type="button" style={btn(page >= pageCount - 1)} disabled={page >= pageCount - 1}
                          onClick={() => setPage(p => p + 1)}>Next ›</button>
                  <button type="button" style={btn(page >= pageCount - 1)} disabled={page >= pageCount - 1}
                          onClick={() => setPage(pageCount - 1)} title="Last page">Last »</button>
                </span>
              );
            })()}
            {flaggedCount > 0 && (
              <span style={{
                fontSize: '0.76rem', color: 'var(--brand-orange)', fontWeight: 700,
                background: 'rgba(245,124,0,0.08)', padding: '4px 12px',
                borderRadius: 'var(--radius-full)', border: '1px solid rgba(245,124,0,0.22)',
              }}>
                {flaggedCount} case{flaggedCount > 1 ? 's' : ''} need scheme configuration
              </span>
            )}
          </div>
        </div>
      )}

      {renameCase && (
        <RenameModal
          key={renameCase.id}
          initialName={getPrfDisplayName(renameCase)}
          onCancel={() => setRenameCase(null)}
          onSave={(name) => saveRename(renameCase.id, name)}
        />
      )}

      {showRfiQueue && (
        <RfiQueueModal rfis={activeRfis} loading={rfiLoading} onClose={() => setShowRfiQueue(false)} onReload={loadRFIs} />
      )}

      {showFailedAlert && (
        <FailedPrfModal
          onClose={() => setShowFailedAlert(false)}
          onResolved={() => { fetchFailedStats(); fetchCases(); }}
        />
      )}
    </div>
  );
}

/* ── Failed-PRF popup tile ─────────────────────────────────────────────────
   Opened by the amber triangle. For every failed/stuck PRF it states WHAT is
   wrong (the processing error, in plain terms) and provides THE SOLUTION
   (Retry — plus what happens automatically). Replaces the old Failed Forms
   page entirely. */
interface FailedPrfRow {
  id: string;
  prf_number: number;
  patient_name: string;
  status?: string;               // "failed" | "submitted" (= stuck)
  processing_error: string;
  submitted_at?: string | null;
  last_processing_at?: string | null;
}

function FailedPrfModal({ onClose, onResolved }: { onClose: () => void; onResolved: () => void }) {
  const [rows, setRows] = useState<FailedPrfRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [doneIds, setDoneIds] = useState<string[]>([]);
  useScrollLock(true);

  const fetchRows = async () => {
    setLoading(true);
    try {
      // cb param busts the 30s response cache so the tile always shows the
      // live truth (watchdog escalations are invisible to cache invalidation).
      const res = await api.get(`/api/failed-prfs?cb=${Date.now()}`);
      setRows(res.data);
      setLoadError(false);
    } catch { setLoadError(true); }
    setLoading(false);
  };
  useEffect(() => { fetchRows(); }, []);

  const problemOf = (r: FailedPrfRow) =>
    r.status === 'submitted'
      ? 'Submitted by the crew, but processing has not picked it up yet.'
      : (r.processing_error || 'Processing failed with an unknown error.');

  const solutionOf = (r: FailedPrfRow) =>
    r.status === 'submitted'
      ? 'The system retries automatically every 5 minutes — no action is required. Press Retry to process it immediately.'
      : 'Press Retry to send it through processing again. If it fails repeatedly, note the PRF number and the error above, and contact support.';

  const retry = async (r: FailedPrfRow) => {
    setBusyId(r.id);
    try {
      await api.post(`/api/failed-prfs/${r.id}/reprocess`);
      setDoneIds(prev => [...prev, r.id]);
      setTimeout(onResolved, 4000); // let the pipeline finish, then refresh page data
    } catch (e: any) {
      const detail = e?.response?.data?.detail || '';
      if (e?.response?.status === 409 && detail.includes('already been processed')) {
        // Self-healed before the click — that's a success, not an error.
        setDoneIds(prev => [...prev, r.id]);
        onResolved();
      } else {
        alert(detail || 'Retry failed — please try again.');
      }
    }
    setBusyId(null);
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(15,23,42,0.45)', padding: 20,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 640, maxWidth: '94vw', maxHeight: '82vh', overflowY: 'auto',
          background: 'white', borderRadius: 16,
          boxShadow: '0 24px 60px rgba(0,0,0,0.22)',
        }}
      >
        <div style={{
          padding: '18px 22px 14px', borderBottom: '1px solid var(--surface-100)',
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="rgba(245,124,0,0.2)"
            stroke="#E65100" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <div style={{ flex: 1 }}>
            <h3 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 800, color: 'var(--text-primary)' }}>
              PRFs needing attention
            </h3>
            <p style={{ margin: '3px 0 0', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
              What went wrong with each PRF, and how to fix it.
            </p>
          </div>
          <button onClick={onClose} style={{
            border: 'none', background: 'var(--surface-50)', borderRadius: 8,
            padding: '7px 14px', fontWeight: 700, fontSize: '0.8rem',
            color: 'var(--text-secondary)', cursor: 'pointer', fontFamily: 'inherit',
          }}>
            Close
          </button>
        </div>

        <div style={{ padding: '14px 22px 20px' }}>
          {loading ? (
            <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem' }}>Loading…</div>
          ) : loadError ? (
            <div style={{ padding: 20, textAlign: 'center', color: '#dc2626', fontSize: '0.85rem', fontWeight: 600 }}>
              Couldn&apos;t load the list — the server didn&apos;t respond.
              <div><button onClick={fetchRows} style={{ marginTop: 10, padding: '8px 20px', borderRadius: 8, border: 'none', background: '#dc2626', color: '#fff', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>Retry</button></div>
            </div>
          ) : rows.length === 0 ? (
            <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.9rem' }}>
              All clear — every PRF has processed successfully.
            </div>
          ) : rows.map(r => (
            <div key={r.id} style={{
              border: `1px solid ${doneIds.includes(r.id) ? 'rgba(16,185,129,0.4)' : 'rgba(245,124,0,0.35)'}`,
              background: doneIds.includes(r.id) ? 'rgba(16,185,129,0.05)' : 'rgba(245,124,0,0.05)',
              borderRadius: 12, padding: '14px 16px', marginBottom: 12,
            }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8 }}>
                <span style={{ fontWeight: 800, fontFamily: 'ui-monospace, monospace', fontSize: '0.9rem', color: 'var(--text-primary)' }}>
                  PRF #{r.prf_number}
                </span>
                <span style={{ fontSize: '0.84rem', color: 'var(--text-secondary)', fontWeight: 600 }}>
                  {r.patient_name || 'Unknown patient'}
                </span>
                {doneIds.includes(r.id) && (
                  <span style={{ marginLeft: 'auto', fontSize: '0.74rem', fontWeight: 800, color: '#059669' }}>
                    ✓ Sent for processing
                  </span>
                )}
              </div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-primary)', marginBottom: 6 }}>
                <strong style={{ color: '#E65100' }}>Problem:</strong> {problemOf(r)}
              </div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: doneIds.includes(r.id) ? 0 : 10 }}>
                <strong style={{ color: 'var(--brand-teal)' }}>Solution:</strong> {solutionOf(r)}
              </div>
              {!doneIds.includes(r.id) && (
                <button
                  onClick={() => retry(r)}
                  disabled={busyId === r.id}
                  style={{
                    padding: '8px 22px', borderRadius: 8, border: 'none',
                    background: '#E65100', color: '#fff', fontWeight: 700,
                    fontSize: '0.8rem', cursor: busyId === r.id ? 'wait' : 'pointer',
                    opacity: busyId === r.id ? 0.6 : 1, fontFamily: 'inherit',
                  }}
                >
                  {busyId === r.id ? 'Retrying…' : 'Retry'}
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function RenameModal({ initialName, onSave, onCancel }: {
  initialName: string;
  onSave: (name: string) => Promise<void> | void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useScrollLock(true);

  useEffect(() => {
    // Focus + select the whole name so the user can retype immediately.
    const t = setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select(); }, 30);
    return () => clearTimeout(t);
  }, []);

  const submit = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await onSave(name);
    } catch {
      setSaving(false);
      alert('Failed to rename. Please try again.');
    }
  };

  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(15,23,42,0.45)', padding: 20,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 460, maxWidth: '94vw', background: 'white', borderRadius: 16,
          boxShadow: '0 24px 60px rgba(0,0,0,0.22)', overflow: 'hidden',
        }}
      >
        <div style={{ padding: '20px 22px 8px' }}>
          <h3 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 700, color: 'var(--text-primary)' }}>
            Rename PRF
          </h3>
          <p style={{ margin: '6px 0 0', fontSize: '0.82rem', color: 'var(--text-muted)' }}>
            Edit the name shown in the list. Leave blank to reset to the default name.
          </p>
        </div>
        <div style={{ padding: '10px 22px 4px' }}>
          <input
            ref={inputRef}
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); submit(); }
              if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
            }}
            placeholder="PRF name"
            style={{
              width: '100%', boxSizing: 'border-box', padding: '11px 13px',
              fontSize: '1rem', borderRadius: 9, border: '1px solid var(--surface-200, #d1d5db)',
              outline: 'none',
            }}
            onFocus={e => (e.currentTarget.style.borderColor = 'var(--brand-teal)')}
            onBlur={e => (e.currentTarget.style.borderColor = 'var(--surface-200, #d1d5db)')}
          />
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '16px 22px 20px' }}>
          <button
            onClick={onCancel}
            disabled={saving}
            style={{
              padding: '9px 16px', borderRadius: 9, border: '1px solid var(--surface-200, #d1d5db)',
              background: 'white', color: 'var(--text-primary)', fontWeight: 600, cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={saving}
            style={{
              padding: '9px 18px', borderRadius: 9, border: 'none',
              background: 'var(--brand-teal)', color: 'white', fontWeight: 700,
              cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.7 : 1,
            }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function RfiQueueModal({ rfis, loading, onClose, onReload }: { rfis: RFI[], loading: boolean, onClose: () => void, onReload: () => void }) {
  const PRIORITY_META: Record<string, { color: string; bg: string; label: string; order: number }> = {
    critical: { color: '#dc2626', bg: 'rgba(220,38,38,0.08)',  label: 'CRITICAL', order: 0 },
    high:     { color: '#f97316', bg: 'rgba(249,115,22,0.08)', label: 'HIGH',     order: 1 },
    medium:   { color: '#eab308', bg: 'rgba(234,179,8,0.08)',  label: 'MEDIUM',   order: 2 },
    low:      { color: '#6b7280', bg: 'rgba(107,114,128,0.08)',label: 'LOW',      order: 3 },
  };

  const REASON_META: Record<string, { label: string; color: string }> = {
    MISSING_PREAUTH:   { label: 'Missing Pre-Auth',    color: 'var(--brand-orange)' },
    INVALID_CPT:       { label: 'Invalid CPT Code',    color: 'var(--brand-orange)' },
    INVALID_ICD10:     { label: 'Invalid ICD-10',      color: '#dc2626' },
    MISSING_HPCSA:     { label: 'Missing HPCSA',       color: 'var(--brand-teal)' },
    MISSING_SIGNATURE: { label: 'Missing Signature',   color: '#6b7280' },
    INCOMPLETE_VITALS: { label: 'Incomplete Vitals',   color: 'var(--brand-teal)' },
  };

  const requestAuthEmail = (claimId: string) => {
    const subject = encodeURIComponent(`URGENT: Missing Preauth Number for Claim [${claimId}]`);
    const savedTemplate = localStorage.getItem('auth_email_template') ||
      `Hi Team,\n\nWe are preparing to submit the medical aid claim for claim ID {claim_id}.\n\nHowever, the assigned pre-authorization number is missing. Please reply with the auth number so we can securely process this dispatch for payout.\n\nThank you,\nEMS Clearinghouse Team`;
    const body = savedTemplate.replace(/{claim_id}/g, claimId);
    window.location.href = `mailto:?subject=${subject}&body=${encodeURIComponent(body)}`;
  };

  const resolveRFI = async (rfi: RFI) => {
    let responseData: any = { resolved_manually: true };
    if (rfi.reason_code === 'MISSING_PREAUTH') {
      const authNum = window.prompt('Enter the Pre-Authorization Number to resolve this RFI:');
      if (authNum === null) return;
      if (!authNum.trim()) { alert('Pre-auth number cannot be blank.'); return; }
      responseData.preauth_number = authNum.trim();
    } else {
      if (!window.confirm(`Mark this RFI as resolved? (${rfi.reason_code})`)) return;
    }
    try {
      await api.post(`/api/adjudication/rfis/${rfi.id}/resolve`, { response_data: responseData });
      onReload();
    } catch (err: any) {
      alert('Failed to resolve RFI: ' + (err.response?.data?.detail || 'Unknown error'));
    }
  };

  const openRfis = rfis.filter(r => r.rfi_status !== 'resolved');
  const resolvedCount = rfis.length - openRfis.length;

  // Sort by priority order then creation date
  const sorted = [...openRfis].sort((a, b) => {
    const pa = PRIORITY_META[a.priority?.toLowerCase()]?.order ?? 99;
    const pb = PRIORITY_META[b.priority?.toLowerCase()]?.order ?? 99;
    if (pa !== pb) return pa - pb;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  return (
    <div className="modal-overlay" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
      <div style={{
        width: 860, maxWidth: '92vw', maxHeight: '88vh',
        background: 'white', borderRadius: 18, overflow: 'hidden',
        display: 'flex', flexDirection: 'column',
        boxShadow: '0 24px 60px rgba(0,0,0,0.18)',
      }}>

        {/* ── Header ── */}
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '20px 28px', borderBottom: '1px solid var(--surface-200)',
          background: 'var(--surface-50)',
        }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{
                width: 36, height: 36, borderRadius: 10,
                background: 'rgba(245,124,0,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--brand-orange)" strokeWidth="2" strokeLinecap="round">
                  <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>
                </svg>
              </div>
              <div>
                <div style={{ fontSize: '1.1rem', fontWeight: 900, color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
                  RFI Action Queue
                </div>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: 1 }}>
                  Request for Information — adjudication flags requiring resolution
                </div>
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {/* Summary chips */}
            <div style={{ display: 'flex', gap: 8 }}>
              <span style={{ padding: '4px 12px', borderRadius: 99, fontSize: '0.75rem', fontWeight: 700, background: 'rgba(245,124,0,0.08)', color: 'var(--brand-orange)', border: '1px solid rgba(245,124,0,0.22)' }}>
                {openRfis.length} Open
              </span>
              {resolvedCount > 0 && (
                <span style={{ padding: '4px 12px', borderRadius: 99, fontSize: '0.75rem', fontWeight: 700, background: 'rgba(56,142,60,0.08)', color: 'var(--brand-green)', border: '1px solid rgba(56,142,60,0.22)' }}>
                  {resolvedCount} Resolved
                </span>
              )}
            </div>
            <button onClick={onClose} style={{
              padding: '7px 16px', borderRadius: 8, border: '1px solid var(--surface-200)',
              background: 'white', color: 'var(--text-secondary)', fontWeight: 700,
              fontSize: '0.82rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
            }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
              Close
            </button>
          </div>
        </div>

        {/* ── Body ── */}
        <div style={{ overflowY: 'auto', flex: 1, padding: '20px 28px', display: 'flex', flexDirection: 'column', gap: 8, background: 'var(--surface-50)' }}>
          {loading ? (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: 200, gap: 14 }}>
              <div style={{ width: 28, height: 28, border: '3px solid var(--surface-200)', borderTopColor: 'var(--brand-teal)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
              <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>Loading RFI queue…</span>
            </div>
          ) : sorted.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 220, gap: 16 }}>
              <div style={{ width: 56, height: 56, borderRadius: '50%', background: 'rgba(16,185,129,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#059669" strokeWidth="2" strokeLinecap="round">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
                </svg>
              </div>
              <div style={{ fontWeight: 700, fontSize: '1rem', color: 'var(--text-primary)' }}>All Clear</div>
              <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>No open RFIs — all claims are clean.</div>
            </div>
          ) : (
            sorted.map((r, idx) => {
              const pm = PRIORITY_META[r.priority?.toLowerCase()] || PRIORITY_META.low;
              const rm = REASON_META[r.reason_code] || { label: r.reason_code, color: '#6b7280' };
              return (
                <div key={r.id} style={{
                  background: 'white',
                  border: '1px solid var(--surface-200)',
                  borderLeft: `3px solid ${pm.color}`,
                  borderRadius: 10,
                  padding: '14px 18px',
                  display: 'grid',
                  gridTemplateColumns: '80px 160px 1fr auto',
                  gap: 16,
                  alignItems: 'center',
                  transition: 'box-shadow 0.15s',
                }}>

                  {/* Priority */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
                    <span style={{
                      fontSize: '0.65rem', fontWeight: 800, textTransform: 'uppercase',
                      letterSpacing: '0.08em', padding: '3px 8px', borderRadius: 6,
                      background: pm.bg, color: pm.color, border: `1px solid ${pm.color}30`,
                    }}>
                      {pm.label}
                    </span>
                    <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: 500 }}>
                      #{String(idx + 1).padStart(2, '0')}
                    </span>
                  </div>

                  {/* Reason code */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span style={{
                      fontSize: '0.72rem', fontWeight: 700, color: rm.color,
                      background: `${rm.color}12`, padding: '3px 8px', borderRadius: 6,
                      border: `1px solid ${rm.color}25`, display: 'inline-block',
                      letterSpacing: '0.04em', fontFamily: 'monospace',
                    }}>
                      {r.reason_code}
                    </span>
                    <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)', fontWeight: 600 }}>
                      {rm.label}
                    </span>
                  </div>

                  {/* Description */}
                  <div>
                    <div style={{ fontSize: '0.83rem', color: 'var(--text-primary)', fontWeight: 500, lineHeight: 1.45 }}>
                      {r.reason_description}
                    </div>
                    {r.created_at && (
                      <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: 4 }}>
                        Raised {new Date(r.created_at).toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </div>
                    )}
                  </div>

                  {/* Actions */}
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
                    {r.rfi_status === 'open' && r.reason_code === 'MISSING_PREAUTH' && (
                      <button
                        onClick={() => requestAuthEmail(r.claim_id)}
                        title="Generate pre-auth request email"
                        style={{
                          padding: '6px 12px', borderRadius: 7, border: '1px solid var(--surface-200)',
                          background: 'white', color: 'var(--text-secondary)', fontWeight: 700,
                          fontSize: '0.75rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5,
                          transition: 'all 0.15s',
                        }}
                        onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--surface-100)'}
                        onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'white'}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                          <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>
                        </svg>
                        Email
                      </button>
                    )}
                    {r.rfi_status === 'open' && (
                      <button
                        onClick={() => resolveRFI(r)}
                        style={{
                          padding: '6px 14px', borderRadius: 7, border: 'none',
                          background: 'white', color: 'var(--brand-teal)', fontWeight: 800,
                          fontSize: '0.75rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5,
                          boxShadow: '0 2px 8px rgba(0,0,0,0.1)', transition: 'all 0.15s',
                        }}
                        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.transform = 'translateY(-1px)'; (e.currentTarget as HTMLElement).style.boxShadow = '0 4px 14px rgba(0,0,0,0.15)'; }}
                        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.transform = ''; (e.currentTarget as HTMLElement).style.boxShadow = '0 2px 8px rgba(0,0,0,0.1)'; }}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                          <polyline points="20 6 9 17 4 12"/>
                        </svg>
                        Resolve
                      </button>
                    )}
                    {r.rfi_status === 'open' && (
                      <button
                        onClick={() => {
                          const field = r.missing_fields && Object.keys(r.missing_fields).length > 0 ? Object.keys(r.missing_fields)[0] : '';
                          window.location.href = `/review/${r.document_id}?highlight=${field || r.reason_code}`;
                        }}
                        title="Navigate to Problem Field"
                        style={{
                          width: 32, height: 32, borderRadius: 7,
                          border: '1px solid var(--surface-200)', background: 'var(--surface-50)',
                          color: 'var(--text-secondary)', cursor: 'pointer',
                          display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.15s',
                        }}
                        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--surface-100)'; (e.currentTarget as HTMLElement).style.color = 'var(--brand-teal)'; }}
                        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'var(--surface-50)'; (e.currentTarget as HTMLElement).style.color = 'var(--text-secondary)'; }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                        </svg>
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* ── Footer ── */}
        {sorted.length > 0 && (
          <div style={{
            padding: '14px 28px', borderTop: '1px solid var(--surface-200)',
            background: 'white', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
              Showing <strong style={{ color: 'var(--text-primary)' }}>{sorted.length}</strong> open RFI{sorted.length !== 1 ? 's' : ''} requiring action
            </span>
            <button onClick={onReload} style={{
              padding: '6px 14px', borderRadius: 7, border: '1px solid var(--surface-200)',
              background: 'white', color: 'var(--text-secondary)', fontWeight: 700, fontSize: '0.78rem',
              cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
            }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
                <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
              </svg>
              Refresh
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
