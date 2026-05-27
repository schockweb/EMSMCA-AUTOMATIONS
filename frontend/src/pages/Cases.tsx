import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';

interface AdjCheck {
  check_name: string;
  passed: boolean;
  severity: string;
  message: string;
}

interface ScrubResult {
  claim_id: string;
  status: string;
  is_clean: boolean;
  is_pmb: boolean;
  pmb_details: Record<string, string> | null;
  total_checks: number;
  passed_checks: number;
  failed_checks: number;
  warning_count: number;
  pass_rate: number;
  checks: AdjCheck[];
  rfis_generated: { reason_code: string; description: string; priority: string; document_id?: string }[];
  modifiers_applied: string[];
}

interface Case {
  id: string;
  file_name?: string;
  original_filename?: string;
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
  const [cases, setCases] = useState<Case[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const handleNavigationToReview = async (e: React.MouseEvent, docId?: string, claimId?: string) => {
    if (e) e.stopPropagation();
    if (!docId) {
      alert("Associated document not found.");
      return;
    }
    
    // Find matching RFIs for this claim to determine which fields to highlight
    let flaggedFields: string[] = [];
    if (claimId && rfis) {
      const claimRfis = rfis.filter(r => r.claim_id === claimId && r.rfi_status === 'open');
      claimRfis.forEach(r => {
        let fieldsToAdd = r.missing_fields ? Object.keys(r.missing_fields) : [];

        // Fallback map based on reason code if missing_fields isn't set
        if (fieldsToAdd.length === 0) {
          if (r.reason_code === 'MISSING_PREAUTH') fieldsToAdd.push('authorization_number');
          if (r.reason_code === 'INVALID_ICD10') fieldsToAdd.push('primary_icd10');
          if (r.reason_code === 'INVALID_CPT') fieldsToAdd.push('tariff_codes');
          if (r.reason_code === 'MISSING_PATIENT_ID') fieldsToAdd.push('patient_id_number');
        }

        // Map backend keys to frontend DocumentReview keys
        fieldsToAdd = fieldsToAdd.map(f => {
          if (f === 'preauth_number') return 'authorization_number';
          if (f === 'provider_practice_number') return 'bhf_practice_number';
          if (f === 'icd10_primary') return 'primary_icd10';
          if (f === 'cpt_code' || f === 'nappi_code') return 'tariff_codes';
          return f;
        });

        flaggedFields = [...flaggedFields, ...fieldsToAdd];
      });
    }

    navigate("/review/" + docId, { state: { flaggedFields } });
  };

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [savingId, setSavingId] = useState<string | null>(null);

  const [adjudicatingCaseId, setAdjudicatingCaseId] = useState<string | null>(null);

  // Auth status per case (fetched in background)
  const [authStatuses, setAuthStatuses] = useState<Record<string, any>>({});

  // RFI Queue State
  const [showRfiQueue, setShowRfiQueue] = useState(false);
  const [rfis, setRfis] = useState<RFI[]>([]);
  const [rfiLoading, setRfiLoading] = useState(false);
  const [emailSendingId, setEmailSendingId] = useState<string | null>(null);

  // Formatting state matching Admin Queue
  const [prfNameTemplate, setPrfNameTemplate] = useState<string[]>(['provider_practice_number', 'prf_number', 'medical_scheme']);
  const nameSeparator = localStorage.getItem('prf_name_separator') || ' . ';


  useEffect(() => {
    fetchCases();
    loadRFIs();
    // Load PRF name template from settings
    api.get('/api/knowledge-base/extraction-settings')
       .then(res => {
         if (res.data.prf_name_template) setPrfNameTemplate(res.data.prf_name_template);
       })
       .catch(() => {});
  }, []);

  // Load auth status for pending cases (fire in background after cases load)
  const loadAuthStatuses = async (caseList: Case[]) => {
    const pending = caseList.filter(c => !c.preauth_number && c.medical_scheme_name);
    const results: Record<string, any> = {};
    await Promise.allSettled(
      pending.map(async c => {
        try {
          const res = await api.get(`/api/authorization/status/${c.id}`);
          results[c.id] = res.data;
        } catch {
          // 404 means no auth request yet — leave undefined
        }
      })
    );
    setAuthStatuses(prev => ({ ...prev, ...results }));
  };

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
      const res = await api.get('/api/cases/?queue=management');
      setCases(res.data);
      // Load auth statuses in background
      loadAuthStatuses(res.data);
    } catch (err: any) {
      setError(err.message || 'Failed to fetch cases');
    } finally {
      setLoading(false);
    }
  };

  const handleEmailToScheme = async (caseId: string) => {
    if (emailSendingId) return;
    setEmailSendingId(caseId);
    try {
      const res = await api.get(`/api/authorization/email-draft/${caseId}`);
      const { to, subject, body } = res.data;
      // URL-encode for mailto:
      const mailto = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      window.open(mailto, '_blank');
    } catch {
      alert('Could not load email draft. Please check the case details.');
    } finally {
      setEmailSendingId(null);
    }
  };



  const filteredCases = cases.filter(c => 
    getPrfDisplayName(c).toLowerCase().includes(searchTerm.toLowerCase()) ||
    c.original_filename?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    c.medical_scheme_name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    c.preauth_number?.toLowerCase().includes(searchTerm.toLowerCase())
  );

  // Pinned flagged cases to the top
  const sortedCases = [...filteredCases].sort((a, b) => {
    if (a.auth_flag && !b.auth_flag) return -1;
    if (!a.auth_flag && b.auth_flag) return 1;
    return new Date(b.created_at || '').getTime() - new Date(a.created_at || '').getTime();
  });

  const flaggedCount = cases.filter(c => c.auth_flag).length;
  const activeRfis = rfis.filter(r => cases.some(c => c.claim_id === r.claim_id));
  const openRfiCount = activeRfis.filter(r => r.rfi_status === 'open').length;
  const pendingCount = cases.filter(c => c.preauth_status === 'pending' || c.adjudication_status === 'rfi').length;

  const handleEditInit = (caseId: string, currentVal: string) => {
    setEditingId(caseId);
    setEditValue(currentVal || '');
  };

  const handleSaveAuth = async (caseId: string) => {
    if (savingId) return;
    setSavingId(caseId);
    try {
      const response = await api.patch(`/api/cases/${caseId}`, {
        preauth_number: editValue.trim() || null,
        preauth_status: editValue.trim() ? 'approved' : 'pending'
      });
      setCases(prev => prev.map(c => c.id === caseId ? response.data : c));
      setEditingId(null);
    } catch (err: any) {
      alert(err.response?.data?.detail || 'Failed to update authorization number');
    } finally {
      setSavingId(null);
    }
  };

  const handleDeleteCase = async (caseId: string) => {
    if (!window.confirm('Are you sure you want to delete this case and its associated documents?')) return;
    try {
      await api.delete(`/api/cases/${caseId}`);
      setCases(prev => prev.filter(c => c.id !== caseId));
    } catch (err: any) {
      alert(err.response?.data?.detail || 'Failed to delete case');
    }
  };

  const handleDeleteAll = async () => {
    if (!window.confirm('⚠️ DANGER: Are you sure you want to delete ALL reviewed cases? (This will NOT affect unreviewed documents in the Verify queue). This action CANNOT BE UNDONE.')) return;
    try {
      await api.delete('/api/cases/all?queue=management');
      setCases([]);
      fetchCases();
    } catch (err: any) {
      alert(err.response?.data?.detail || 'Failed to delete all cases');
    }
  };


  return (
    <div className="page-content" style={{ padding: '28px 36px 48px', maxWidth: 1320, margin: '0 auto', fontFamily: 'var(--font-sans)' }}>
      <style>{`
        @keyframes casesSpin { to { transform: rotate(360deg); } }
        @keyframes casesFadeUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes casesRowPulse  { 0%,100%{opacity:1} 50%{opacity:0.78} }
        .cases-in { animation: casesFadeUp 0.4s ease-out forwards; }
        .cases-th { cursor:pointer; user-select:none; white-space:nowrap; }
        .cases-th:hover { color: var(--brand-teal); }
        .cases-table tbody tr:hover td { background: rgba(8,131,149,0.025); }
        .cases-table td, .cases-table th { padding: 12px 14px; }
        .cases-table th { font-size:0.72rem; font-weight:700; text-transform:uppercase; letter-spacing:0.07em; color:var(--text-muted); background:var(--surface-50); border-bottom:1px solid var(--glass-border); }
        .cases-table td { border-bottom:1px solid var(--surface-100); vertical-align:middle; }
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
          <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', margin: '4px 0 0 0' }}>
            {cases.length} case{cases.length !== 1 ? 's' : ''}
            {flaggedCount > 0 && <> &nbsp;·&nbsp; <span style={{ color: 'var(--brand-orange)', fontWeight: 700 }}>{flaggedCount} need attention</span></>}
            {openRfiCount > 0 && <> &nbsp;·&nbsp; <span style={{ color: 'var(--brand-orange)', fontWeight: 700 }}>{openRfiCount} open RFI{openRfiCount !== 1 ? 's' : ''}</span></>}
            {pendingCount > 0 && <> &nbsp;·&nbsp; {pendingCount} pending</>}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={fetchCases}
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
          <button onClick={handleDeleteAll}
            style={{
              padding: '9px 16px', borderRadius: 'var(--radius-md)',
              border: '1px solid var(--glass-border)', background: 'var(--surface-0)',
              color: 'var(--text-muted)', fontWeight: 600, fontSize: '0.85rem',
              cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 7,
              fontFamily: 'inherit', transition: 'all var(--transition-fast)',
            }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = 'rgba(220,38,38,0.3)'; e.currentTarget.style.color = '#dc2626'; e.currentTarget.style.background = 'rgba(220,38,38,0.04)'; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--glass-border)'; e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.background = 'var(--surface-0)'; }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line>
            </svg>
            Delete All
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
            border: `1px solid ${openRfiCount > 0 ? 'rgba(245,124,0,0.35)' : 'var(--glass-border)'}`,
            background: openRfiCount > 0 ? 'rgba(245,124,0,0.06)' : 'var(--surface-0)',
            color: openRfiCount > 0 ? 'var(--brand-orange)' : 'var(--text-secondary)',
            fontWeight: 700, fontSize: '0.85rem', cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 8,
            fontFamily: 'inherit', transition: 'all var(--transition-fast)',
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" /><line x1="4" y1="22" x2="4" y2="15" /></svg>
          RFI Queue
          {openRfiCount > 0 && (
            <span style={{
              background: 'var(--brand-orange)', color: 'white', borderRadius: 99,
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
          <div style={{ fontWeight: 700, fontSize: '1rem', color: 'var(--text-secondary)' }}>{cases.length === 0 ? 'No cases yet' : 'No cases match your search'}</div>
          <div style={{ fontSize: '0.85rem' }}>{cases.length === 0 ? 'Process a PRF document to generate a case.' : 'Try a different search term.'}</div>
        </div>
      ) : (
        <div className="cases-in" style={{
          background: 'var(--surface-0)', border: '1px solid var(--glass-border)',
          borderRadius: 'var(--radius-lg)', overflow: 'hidden',
          boxShadow: 'var(--glass-shadow)',
        }}>
          <table className="cases-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ width: 48, paddingLeft: 16 }}></th>
                <th className="cases-th" style={{ maxWidth: 340 }}>Patient / PRF</th>
                <th>Pre-Auth</th>
                <th>Adjudication</th>
                <th style={{ textAlign: 'right', paddingRight: 16 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sortedCases.map(c => (
                <tr key={c.id}
                  style={{
                    background: c.auth_flag ? 'rgba(245,124,0,0.03)' : undefined,
                    animation: c.auth_flag ? 'casesRowPulse 3s ease-in-out infinite' : 'none',
                  }}
                >
                  {/* Status icon */}
                  <td style={{ width: 48, paddingLeft: 16, textAlign: 'center' }}>
                    {c.auth_flag ? (
                      <span title={c.auth_flag_reason || 'Scheme not configured'}
                        style={{ width: 28, height: 28, borderRadius: '50%', background: 'rgba(245,124,0,0.12)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'help' }}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#F57C00" strokeWidth="2.5" strokeLinecap="round"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
                      </span>
                    ) : c.adjudication_status === 'rfi' ? (
                      <span title="Action Required" onClick={(e) => handleNavigationToReview(e, c.document_id, c.claim_id)}
                        style={{ width: 28, height: 28, borderRadius: '50%', background: 'rgba(220,38,38,0.1)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2.5" strokeLinecap="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" /><line x1="4" y1="22" x2="4" y2="15" /></svg>
                      </span>
                    ) : c.adjudication_status === 'clean' ? (
                      <span title="Clean claim" style={{ width: 28, height: 28, borderRadius: '50%', background: 'rgba(22,163,74,0.1)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2.5" strokeLinecap="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></svg>
                      </span>
                    ) : (
                      <span style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--surface-100)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
                      </span>
                    )}
                  </td>

                  {/* Patient / PRF */}
                  <td style={{ maxWidth: 340 }}>
                    <div style={{ fontWeight: 600, fontSize: '0.88rem', color: 'var(--text-primary)', cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                      onClick={() => { if (c.document_id) window.location.href = `/review/${c.document_id}`; else alert("Associated document not found."); }}
                      onMouseEnter={e => (e.currentTarget as HTMLElement).style.textDecoration = 'underline'}
                      onMouseLeave={e => (e.currentTarget as HTMLElement).style.textDecoration = 'none'}>
                      {getPrfDisplayName(c)}
                    </div>
                  </td>

                  {/* Pre-Auth */}
                  <td style={{ position: 'relative' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, alignItems: 'flex-start' }}>
                      {/* Rich auth status badge */}
                      {(() => {
                        const authSt = authStatuses[c.id];
                        const hasAuth = !!c.preauth_number;

                        if (hasAuth) {
                          return (
                            <button onClick={() => { if (editingId === c.id) setEditingId(null); else handleEditInit(c.id, c.preauth_number || ''); }}
                              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 8, fontSize: '0.75rem', fontWeight: 700, color: '#059669', background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.2)', cursor: 'pointer', outline: 'none' }}>
                              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                              <span style={{ fontFamily: 'monospace', fontSize: '0.8rem', letterSpacing: '0.02em' }}>{c.preauth_number}</span>
                            </button>
                          );
                        }

                        if (!authSt) {
                          // No auth request sent yet
                          return (
                            <button onClick={() => { if (editingId === c.id) setEditingId(null); else handleEditInit(c.id, ''); }}
                              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 8, fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)', background: 'white', border: '1px solid var(--surface-200)', cursor: 'pointer', outline: 'none', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
                              <span style={{ textTransform: 'uppercase', letterSpacing: '0.04em', fontSize: '0.68rem' }}>No auth sent</span>
                              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="6 9 12 15 18 9"/></svg>
                            </button>
                          );
                        }

                        const st = authSt.status;
                        if (st === 'pending') return (
                          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 8, fontSize: '0.73rem', fontWeight: 700, color: '#6d28d9', background: 'rgba(109,40,217,0.06)', border: '1px solid rgba(109,40,217,0.18)' }}>
                            <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#6d28d9', animation: 'casesOrbRipple 1.5s ease-in-out infinite' }} />
                            Pending Auth
                          </div>
                        );

                        if (st === 'approved') return (
                          <button onClick={() => { if (editingId === c.id) setEditingId(null); else handleEditInit(c.id, authSt.auth_number || ''); }}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 8, fontSize: '0.75rem', fontWeight: 700, color: '#059669', background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.2)', cursor: 'pointer', outline: 'none' }}>
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                            <span style={{ fontFamily: 'monospace' }}>{authSt.auth_number}</span>
                          </button>
                        );

                        if (st === 'declined') return (
                          <div title={authSt.decline_reason || 'Declined by scheme'}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 8, fontSize: '0.73rem', fontWeight: 700, color: '#dc2626', background: 'rgba(220,38,38,0.06)', border: '1px solid rgba(220,38,38,0.18)', cursor: 'help', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                            Declined
                          </div>
                        );

                        // error / timeout — show email button for non-API schemes OR retry
                        return (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 8, fontSize: '0.72rem', fontWeight: 700, color: '#b45309', background: 'rgba(245,124,0,0.07)', border: '1px solid rgba(245,124,0,0.22)' }}>
                              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                              Auth Error
                            </div>
                            {/* Email fallback button */}
                            {c.auth_flag && (
                              <button
                                onClick={() => handleEmailToScheme(c.id)}
                                disabled={emailSendingId === c.id}
                                title="Send pre-authorization request to scheme by email"
                                style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 8, fontSize: '0.72rem', fontWeight: 700, color: '#1d4ed8', background: 'rgba(29,78,216,0.07)', border: '1px solid rgba(29,78,216,0.2)', cursor: 'pointer', outline: 'none' }}
                                onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'rgba(29,78,216,0.12)'}
                                onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'rgba(29,78,216,0.07)'}>
                                {emailSendingId === c.id
                                  ? <span style={{ width: 10, height: 10, border: '2px solid rgba(29,78,216,0.3)', borderTopColor: '#1d4ed8', borderRadius: '50%', animation: 'casesOrbRipple 0.7s linear infinite' }} />
                                  : <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
                                }
                                📧 Email to Scheme
                              </button>
                            )}
                          </div>
                        );
                      })()}

                      {/* Manual override dropdown */}
                      {editingId === c.id && (
                        <div style={{ position: 'absolute', top: '100%', left: 16, zIndex: 50, padding: 12, width: 220, background: 'white', border: '1px solid var(--surface-200)', borderRadius: 12, boxShadow: '0 10px 30px rgba(0,0,0,0.1)' }}>
                          <div style={{ fontSize: '0.75rem', fontWeight: 600, marginBottom: 8, color: 'var(--text-secondary)' }}>Override Authorization</div>
                          <input autoFocus type="text" value={editValue} onChange={e => setEditValue(e.target.value)} placeholder="Enter Auth #"
                            style={{ width: '100%', marginBottom: 10, fontSize: '0.82rem', padding: '6px 10px', boxSizing: 'border-box', border: '1px solid var(--surface-200)', borderRadius: 8, outline: 'none' }} />
                          <div style={{ display: 'flex', gap: 8 }}>
                            <button onClick={() => handleSaveAuth(c.id)} disabled={savingId === c.id}
                              style={{ flex: 1, padding: '6px 0', borderRadius: 8, background: 'var(--brand-teal)', color: 'white', border: 'none', fontWeight: 700, fontSize: '0.82rem', cursor: 'pointer' }}>
                              {savingId === c.id ? '…' : 'Save'}
                            </button>
                            <button onClick={() => setEditingId(null)}
                              style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid var(--surface-200)', background: 'var(--surface-50)', cursor: 'pointer', fontWeight: 600 }}>✕</button>
                          </div>
                        </div>
                      )}
                    </div>
                  </td>

                  {/* Adjudication */}
                  <td>
                    {c.adjudication_status ? (
                      <span onClick={(e) => handleNavigationToReview(e, c.document_id, c.claim_id)} style={{ cursor: "pointer", fontSize: "0.72rem", fontWeight: 700, padding: "4px 10px", borderRadius: 99,
                        color: c.adjudication_status === 'clean' ? '#16a34a' : c.adjudication_status === 'rfi' ? '#dc2626' : '#6b7280',
                        background: c.adjudication_status === 'clean' ? '#dcfce7' : c.adjudication_status === 'rfi' ? '#fee2e2' : '#f3f4f6',
                      }}>
                        {c.adjudication_status === 'clean' ? '✓ Clean' : c.adjudication_status === 'rfi' ? '⚑ RFI' : c.adjudication_status}
                      </span>
                    ) : <span style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>—</span>}
                  </td>

                  {/* Actions */}
                  <td style={{ paddingRight: 16 }}>
                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                      <button onClick={() => navigate(`/cases/${c.id}/prf`)}
                        title="View PRF (branded for scheme submission)"
                        style={{
                          padding: '6px 14px', borderRadius: 8, border: '1px solid rgba(16,185,129,0.35)', cursor: 'pointer',
                          fontSize: '0.78rem', fontWeight: 800, color: '#059669',
                          background: 'white',
                          transition: 'all 0.15s',
                          display: 'flex', alignItems: 'center', gap: 6,
                        }}
                        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(16,185,129,0.08)'; }}
                        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'white'; }}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>
                        View PRF
                      </button>
                      <button onClick={() => setAdjudicatingCaseId(c.id)}
                        title={'Review Invoice & Submit'}
                        style={{
                          padding: '6px 14px', borderRadius: 8, border: 'none', cursor: 'pointer',
                          fontSize: '0.78rem', fontWeight: 800, color: 'var(--brand-teal)',
                          background: 'white',
                          transition: 'all 0.2s',
                          display: 'flex', alignItems: 'center', gap: 6,
                          boxShadow: '0 4px 14px rgba(0,0,0,0.1)',
                        }}
                        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.transform = 'translateY(-1px)'; (e.currentTarget as HTMLElement).style.boxShadow = '0 6px 20px rgba(0,0,0,0.15)'; }}
                        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.transform = ''; (e.currentTarget as HTMLElement).style.boxShadow = '0 4px 14px rgba(0,0,0,0.1)'; }}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /></svg>
                        Invoice
                      </button>
                      <button onClick={() => handleDeleteCase(c.id)} title="Delete case"
                        style={{ width: 32, height: 32, borderRadius: 8, border: '1px solid rgba(220,38,38,0.2)', color: '#dc2626', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.15s' }}
                        onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'rgba(220,38,38,0.08)'}
                        onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'transparent'}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" /></svg>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '12px 20px', borderTop: '1px solid var(--surface-100)',
            background: 'var(--surface-50)',
          }}>
            <span style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
              Showing <strong style={{ color: 'var(--text-primary)' }}>{sortedCases.length}</strong> of <strong style={{ color: 'var(--text-primary)' }}>{cases.length}</strong> cases
            </span>
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

      {showRfiQueue && (
        <RfiQueueModal rfis={activeRfis} loading={rfiLoading} onClose={() => setShowRfiQueue(false)} onReload={loadRFIs} />
      )}
      {adjudicatingCaseId && (
        <ProFormaInvoiceModal caseId={adjudicatingCaseId} onClose={() => { setAdjudicatingCaseId(null); loadRFIs(); }} onReload={fetchCases} />
      )}
    </div>
  );
}


function ProFormaInvoiceModal({ caseId, onClose, onReload }: { caseId: string, onClose: () => void, onReload: () => void }) {
  const [result, setResult] = useState<ScrubResult | null>(null);
  const [claim, setClaim] = useState<any>(null); // The claim info with lines
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Authorization request state
  const [authLoading, setAuthLoading] = useState(false);
  const [manualAuth, setManualAuth] = useState('');
  const [authResult, setAuthResult] = useState<{
    status: string;
    auth_number?: string;
    approved_amount?: number;
    decline_reason?: string;
  } | null>(null);

  // EDI Submission state
  const [submitting, setSubmitting] = useState(false);
  const [submitSuccess, setSubmitSuccess] = useState('');

  // ── Payer type routing state ────────────────────────────────────────────
  const [payerType, setPayerType] = useState<'SCHEME' | 'AGGREGATOR'>('SCHEME');
  const [dispatchRef, setDispatchRef] = useState('');
  const [payerResolved, setPayerResolved] = useState(false);

  useEffect(() => {
    handleScrubAndLoad();
  }, [caseId]);

  const handleScrubAndLoad = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.post('/api/adjudication/scrub', { case_id: caseId });
      setResult(res.data);
      
      if (res.data.claim_id) {
        const claimRes = await api.get(`/api/claims/${res.data.claim_id}`);
        setClaim(claimRes.data);

        // Pre-fill dispatch ref if already stored on the claim
        if (claimRes.data.dispatch_reference_number) {
          setDispatchRef(claimRes.data.dispatch_reference_number);
        }
      }

      // ── Resolve payer type from scheme config ──
      try {
        const caseRes = await api.get(`/api/cases/${caseId}`);
        const schemeName = caseRes.data?.medical_scheme_name;
        if (schemeName) {
          const cfgRes = await api.get('/api/scheme-configs/');
          const configs: any[] = cfgRes.data || [];
          const match = configs.find((c: any) =>
            c.scheme_name?.toLowerCase() === schemeName.trim().toLowerCase()
          );
          if (match?.payer_type === 'AGGREGATOR') {
            setPayerType('AGGREGATOR');
          } else {
            setPayerType('SCHEME');
          }
        }
      } catch {
        /* fallback to SCHEME */
      }
      setPayerResolved(true);
    } catch (err: any) {
      setError(err.response?.data?.detail || 'Failed to load invoice and scrub claim');
    } finally {
      setLoading(false);
    }
  };

  const handleRecalculate = async () => {
    setLoading(true);
    setError('');
    try {
      // Re-runs tariff engine → rewrites claim lines → re-adjudicates
      const res = await api.post('/api/adjudication/recalculate', { case_id: caseId });
      setResult(res.data);
      if (res.data.claim_id) {
        const claimRes = await api.get(`/api/claims/${res.data.claim_id}`);
        setClaim(claimRes.data);
      }
    } catch (err: any) {
      setError(err.response?.data?.detail || 'Recalculation failed — check that a tariff schedule is loaded for this scheme');
    } finally {
      setLoading(false);
    }
  };

  const handleLineChange = (index: number, field: string, value: string | number) => {
    if (!claim) return;
    const updatedClaim = { ...claim };
    const lines = [...updatedClaim.claim_lines];
    const next = { ...lines[index], [field]: value };

    // When the user changes quantity, recompute total from the engine-derived
    // unit_price so the line stays faithful to the tariff. The user can still
    // override total_price directly to force a different value.
    if (field === 'quantity') {
      const qty = Number(value) || 0;
      const unit = Number(next.unit_price) || 0;
      if (unit > 0) next.total_price = +(qty * unit).toFixed(2);
    }

    lines[index] = next;

    // Roll up claim total from the new line totals
    updatedClaim.claim_lines = lines;
    updatedClaim.total_amount = lines.reduce(
      (sum: number, l: any) => sum + (Number(l.total_price) || 0), 0
    );
    setClaim(updatedClaim);
  };

  const handleSaveManualAuth = async () => {
    if (!manualAuth.trim()) return;
    setAuthLoading(true);
    try {
      await api.patch(`/api/cases/${caseId}`, { preauth_number: manualAuth.trim(), preauth_status: 'approved' });
      setAuthResult({
        status: 'APPROVED',
        auth_number: manualAuth.trim()
      });
      // Re-scrub to clear warnings
      await handleScrubAndLoad();
      onReload();
    } catch (err: any) {
      setAuthResult({
        status: 'error',
        decline_reason: err.response?.data?.detail || 'Failed to save manual auth',
      });
    } finally {
      setAuthLoading(false);
    }
  };

  const handleRequestAuth = async () => {
    setAuthLoading(true);
    setAuthResult(null);
    try {
      const res = await api.post(`/api/authorization/request/${caseId}`);
      setAuthResult(res.data);
      if (res.data.status === 'APPROVED') {
         await handleScrubAndLoad();
      }
      onReload();
    } catch (err: any) {
      setAuthResult({
        status: 'error',
        decline_reason: err.response?.data?.detail || 'Authorization request failed',
      });
    } finally {
      setAuthLoading(false);
    }
  };

  const handleSubmitClaim = async () => {
    if (!claim) return;

    // ── Aggregator: validate dispatch ref is present ──
    if (payerType === 'AGGREGATOR' && !dispatchRef.trim()) {
      setError('CAD/Dispatch Reference Number is mandatory for aggregator billing.');
      return;
    }

    // ── Pre-flight: only persist lines that have a server-side id (no unsaved
    // rows), and ensure every quantity is at least 1. ──
    const persistable = (claim.claim_lines || []).filter((l: any) => !!l.id);
    const badQty = persistable.find((l: any) => Number(l.quantity) < 1);
    if (badQty) {
      setError(`Line ${badQty.line_number ?? ''}: quantity must be at least 1.`);
      return;
    }
    const badPrice = persistable.find((l: any) => Number(l.total_price) < 0);
    if (badPrice) {
      setError(`Line ${badPrice.line_number ?? ''}: total price cannot be negative.`);
      return;
    }

    setSubmitting(true);
    setError('');
    setSubmitSuccess('');
    try {
      // Single save round-trip: line overrides + dispatch_reference_number
      // (when the payer is an aggregator). The backend persists both atomically.
      await api.patch(`/api/claims/${claim.id}/lines`, {
        lines: persistable.map((l: any) => ({
          id: l.id,
          quantity: Number(l.quantity),
          total_price: Number(l.total_price),
        })),
        dispatch_reference_number:
          payerType === 'AGGREGATOR' ? dispatchRef.trim() : null,
      });

      // Trigger automated payer-aware background routing
      await api.post(`/api/invoices/${claim.id}/submit`);
      setSubmitSuccess(`Claim successfully queued for automated submission!`);

      onReload();

      // Auto-close after 4 seconds
      setTimeout(() => {
         onClose();
      }, 4000);
    } catch (err: any) {
      setError(err.response?.data?.detail || 'Failed to submit EDI to switch');
    } finally {
      setSubmitting(false);
    }
  };

  const severityColor = (s: string) => {
    if (s === 'error') return 'var(--error-400)';
    if (s === 'warning') return 'var(--warning-400)';
    return 'var(--accent-400)';
  };

  const priorityBadge = (p: string) => {
    const colors: Record<string, string> = {
      critical: '#ef4444', high: '#f97316', medium: '#eab308', low: '#6b7280',
    };
    return (
      <span style={{
        padding: '2px 8px', borderRadius: 9999, fontSize: '0.7rem', fontWeight: 600,
        background: `${colors[p] || '#6b7280'}20`, color: colors[p] || '#6b7280',
        textTransform: 'uppercase',
      }}>
        {p}
      </span>
    );
  };

  return (
    <div className="modal-overlay" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
      <div className="modal-content" style={{ width: 1100, maxWidth: '95vw', maxHeight: '90vh', display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden' }}>
        
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 24px', borderBottom: '1px solid var(--surface-200)', background: 'var(--surface-50)' }}>
          <div>
            <h2 style={{ fontSize: '1.25rem', margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--brand-teal)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
              Pro-Forma Invoice & Sign-Off
            </h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', margin: 0 }}>Verify financials and clinical rules before EDI switch submission.</p>
              {payerResolved && (
                <span style={{
                  padding: '2px 10px', borderRadius: 9999, fontSize: '0.7rem', fontWeight: 700,
                  background: payerType === 'AGGREGATOR' ? 'rgba(245,124,0,0.12)' : 'rgba(8,131,149,0.12)',
                  color: payerType === 'AGGREGATOR' ? 'var(--brand-orange)' : 'var(--brand-teal)',
                  textTransform: 'uppercase', letterSpacing: '0.05em',
                }}>
                  {payerType === 'AGGREGATOR' ? 'Aggregator' : 'Scheme'}
                </span>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              className="btn btn-secondary btn-sm"
              onClick={handleRecalculate}
              disabled={loading}
              title="Re-run tariff engine and recalculate invoice lines"
              style={{ padding: '4px 12px', display: 'flex', alignItems: 'center', gap: 6 }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }}>
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
                <path d="M3 3v5h5"/>
              </svg>
              {loading ? 'Calculating…' : 'Recalculate'}
            </button>
            <button className="btn btn-secondary btn-sm" onClick={onClose} style={{ padding: '4px 12px' }}>Close ✕</button>
          </div>
        </div>

        <div style={{ padding: '24px', overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 24, background: 'var(--surface-50)' }}>
          {loading ? (
             <div style={{ textAlign: 'center', padding: 60 }}>
               <div className="spinner" style={{ width: 32, height: 32, borderWidth: 3 }}></div>
               <p style={{ marginTop: 16, color: 'var(--text-muted)' }}>Calculating tariffs and clinical rules...</p>
             </div>
          ) : error && !claim ? (
             <div style={{ padding: '16px', borderRadius: 8, background: 'rgba(239,68,68,0.1)', color: 'var(--error-400)', border: '1px solid rgba(239,68,68,0.2)' }}>
                {error}
             </div>
          ) : result && claim ? (
             <>
               {submitSuccess && (
                 <div style={{ padding: '16px', borderRadius: 8, background: 'rgba(16,185,129,0.12)', border: '1px solid rgba(16,185,129,0.3)', display: 'flex', alignItems: 'center', gap: 12 }}>
                   <span style={{ fontSize: '1.5rem' }}>✅</span>
                   <div style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--accent-500)' }}>{submitSuccess}</div>
                 </div>
               )}
               {error && (
                 <div style={{ padding: '12px', borderRadius: 8, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', fontSize: '0.85rem', color: 'var(--error-500)' }}>
                   {error}
                 </div>
               )}

               <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 1fr)', gap: 24, alignItems: 'start' }}>
                 
                 {/* LEFT COLUMN: THE INVOICE */}
                 <div className="card" style={{ padding: 0, overflow: 'hidden', border: '1px solid var(--glass-border)' }}>
                   <div style={{ padding: '20px 24px', background: 'var(--surface-100)', borderBottom: '1px solid var(--surface-200)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                     <div>
                       <div style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-primary)' }}>Pro-Forma Invoice</div>
                       <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 4 }}>
                         {payerType === 'AGGREGATOR' ? 'Aggregator' : 'Scheme'}: {claim.target_scheme}
                       </div>
                     </div>
                     <div style={{ textAlign: 'right' }}>
                       <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>TOTAL RAND AMOUNT</div>
                       <div style={{ fontSize: '1.6rem', fontWeight: 800, color: 'var(--brand-teal)' }}>R{claim.total_amount.toFixed(2)}</div>
                     </div>
                   </div>
                   <div style={{ padding: 0 }}>
                     <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
                       <thead style={{ background: 'var(--surface-50)' }}>
                         <tr>
                           <th style={{ padding: '12px 20px', fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Code</th>
                           <th style={{ padding: '12px 20px', fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Description</th>
                           <th style={{ padding: '12px 20px', fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600, textAlign: 'center', width: '80px' }}>Qty</th>
                           <th style={{ padding: '12px 20px', fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600, textAlign: 'right', width: '120px' }}>Total ZAR (R)</th>
                         </tr>
                       </thead>
                       <tbody>
                         {claim.claim_lines && claim.claim_lines.map((l: any, i: number) => {
                           const unit = Number(l.unit_price) || 0;
                           const qty = Number(l.quantity) || 0;
                           const total = Number(l.total_price) || 0;
                           const expected = +(unit * qty).toFixed(2);
                           const overridden = unit > 0 && Math.abs(expected - total) > 0.01;
                           return (
                           <tr key={l.id || i} style={{ borderTop: i > 0 ? '1px solid var(--surface-200)' : 'none', background: overridden ? 'rgba(245,158,11,0.04)' : undefined }}>
                             <td style={{ padding: '12px 20px', fontSize: '0.85rem' }}>
                               <div style={{ fontWeight: 600, color: 'var(--text-main)' }}>{l.cpt_code || '—'}</div>
                               {unit > 0 && (
                                 <div
                                   title="Per-unit rate from the tariff schedule. Changing quantity multiplies this; editing the total below overrides it."
                                   style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 2, fontFamily: 'ui-monospace, monospace' }}>
                                   Unit R{unit.toFixed(2)}
                                 </div>
                               )}
                               {l.modifier && <div style={{ fontSize: '0.7rem', color: 'var(--brand-teal)', marginTop: 2, background: 'rgba(8,131,149,0.1)', display: 'inline-block', padding: '2px 6px', borderRadius: 4 }}>Mod: {l.modifier}</div>}
                               {l.nappi_code && <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 2 }}>NAPPI: {l.nappi_code}</div>}
                               {overridden && (
                                 <div
                                   title={`Tariff rate × quantity = R${expected.toFixed(2)}, but total has been manually set to R${total.toFixed(2)}.`}
                                   style={{ fontSize: '0.65rem', color: '#b45309', marginTop: 4, fontWeight: 700 }}>
                                   ⚠ Manual override
                                 </div>
                               )}
                             </td>
                             <td style={{ padding: '12px 20px', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                               {l.description || 'Service/Tariff Description'}
                               {(l.icd10_primary || l.icd10_secondary) && (
                                 <div style={{ marginTop: 4, display: 'flex', gap: 4 }}>
                                   {l.icd10_primary && <span style={{ fontSize: '0.65rem', background: 'var(--surface-200)', padding: '2px 6px', borderRadius: 4 }}>{l.icd10_primary}</span>}
                                   {l.icd10_secondary && <span style={{ fontSize: '0.65rem', background: 'var(--surface-200)', padding: '2px 6px', borderRadius: 4 }}>{l.icd10_secondary}</span>}
                                 </div>
                               )}
                             </td>
                             <td style={{ padding: '10px 20px', textAlign: 'center' }}>
                               <input 
                                  className="input" 
                                  type="number" 
                                  value={l.quantity} 
                                  onChange={e => handleLineChange(i, 'quantity', e.target.value)} 
                                  style={{ width: '60px', padding: '6px', textAlign: 'center', fontSize: '0.85rem' }} 
                               />
                             </td>
                             <td style={{ padding: '10px 20px', textAlign: 'right' }}>
                               <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4 }}>
                                 <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-main)' }}>R</span>
                                 <input 
                                    className="input" 
                                    type="number" 
                                    step="0.01"
                                    value={l.total_price} 
                                    onChange={e => handleLineChange(i, 'total_price', e.target.value)} 
                                    style={{ width: '80px', padding: '6px', textAlign: 'right', fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-main)' }} 
                                 />
                               </div>
                             </td>
                           </tr>
                         );
                         })}
                         {claim.claim_lines.length === 0 && (
                           <tr><td colSpan={4} style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem' }}>No tariffs calculated. Proceed with caution.</td></tr>
                         )}
                       </tbody>
                     </table>
                   </div>
                 </div>

                 {/* RIGHT COLUMN: RULES ENGINE & SUBMISSION */}
                 <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                   <div className="card" style={{ padding: 16, borderLeft: `4px solid ${result.is_clean ? 'var(--accent-400)' : 'var(--error-400)'}` }}>
                     <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
                       <div>
                         <h3 style={{ fontSize: '1rem', fontWeight: 700, margin: 0, color: result.is_clean ? 'var(--accent-400)' : 'var(--error-400)' }}>
                           {result.is_clean ? 'CLEAN CLAIM (RULES PASSED)' : 'ACTION REQUIRED'}
                         </h3>
                         <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', margin: '4px 0 0' }}>
                           {result.passed_checks}/{result.total_checks} checks passed • {result.warning_count} warnings
                         </p>
                       </div>
                       <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                         {result.is_pmb && (
                           <span style={{ padding: '4px 12px', borderRadius: 9999, fontSize: '0.75rem', fontWeight: 700, background: 'rgba(59, 130, 246, 0.15)', color: '#3b82f6' }}>PMB</span>
                         )}
                       </div>
                     </div>
                   </div>

                   {/* Generated RFIs */}
                   {result.rfis_generated.length > 0 && (
                     <div className="card" style={{ padding: 16 }}>
                       <h3 style={{ fontSize: '0.9rem', fontWeight: 600, margin: '0 0 12px 0', color: 'var(--error-400)' }}>
                         Blocking RFIs ({result.rfis_generated.length})
                       </h3>
                       <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                         {result.rfis_generated.map((rfi: any, i: number) => (
                           <div key={i} style={{ padding: '10px', borderRadius: 8, background: 'rgba(239, 68, 68, 0.05)', border: '1px solid rgba(239, 68, 68, 0.12)' }}>
                             <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                               <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-primary)' }}>{rfi.reason_code}</span>
                               {priorityBadge(rfi.priority)}
                             </div>
                             <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: 0, lineHeight: 1.4 }}>{rfi.description}</p>
                           </div>
                         ))}
                       </div>
                       <button className="btn btn-secondary btn-sm" style={{ marginTop: 12, width: '100%' }} onClick={() => { window.location.href = `/review/${result.rfis_generated[0]?.document_id || ''}`; }}>Update Claim Data</button>
                     </div>
                   )}

                   {/* Check Details */}
                   {result.rfis_generated.length === 0 && (
                     <div className="card" style={{ padding: 16 }}>
                       <h3 style={{ fontSize: '0.9rem', fontWeight: 600, margin: '0 0 12px 0', color: 'var(--text-primary)' }}>Matrix Details</h3>
                       <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 200, overflowY: 'auto' }}>
                         {result.checks.map((c: any, i: number) => (
                           <div key={i} style={{
                             padding: '6px 10px', borderRadius: 6,
                             background: c.passed ? 'rgba(16, 185, 129, 0.04)' : 'rgba(239, 68, 68, 0.04)',
                             border: `1px solid ${c.passed ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)'}`,
                             display: 'flex', alignItems: 'flex-start', gap: 8,
                           }}>
                             <span style={{ fontSize: '0.8rem', marginTop: 1, color: c.passed ? '#10b981' : severityColor(c.severity) }}>{c.passed ? '✓' : c.severity === 'error' ? '✗' : '!'}</span>
                             <div style={{ minWidth: 0 }}>
                               <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-primary)' }}>{c.check_name}</div>
                             </div>
                           </div>
                         ))}
                       </div>
                     </div>
                   )}

                   {/* ═══ CONDITIONAL: Pre-Auth (SCHEME) or Dispatch Ref (AGGREGATOR) ═══ */}
                   {payerType === 'AGGREGATOR' ? (
                     /* ── AGGREGATOR: CAD/Dispatch Reference Number ── */
                     <div className="card" style={{ padding: 16, borderLeft: '4px solid var(--brand-orange)' }}>
                       <h3 style={{ fontSize: '0.9rem', fontWeight: 600, margin: '0 0 4px 0', color: 'var(--brand-orange)', display: 'flex', alignItems: 'center', gap: 6 }}>
                         <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                           <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
                           <polyline points="3.27 6.96 12 12.01 20.73 6.96"/>
                           <line x1="12" y1="22.08" x2="12" y2="12"/>
                         </svg>
                         CAD / Dispatch Reference Number
                       </h3>
                       <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: '0 0 12px 0' }}>
                         Required for aggregator billing. Enter the dispatch reference from the CAD system.
                       </p>
                       <input
                         id="dispatch-ref-input"
                         className="input"
                         placeholder="Enter CAD/Dispatch Reference #…"
                         value={dispatchRef}
                         onChange={e => setDispatchRef(e.target.value)}
                         style={{
                           width: '100%', height: 42, fontSize: '0.9rem', fontWeight: 600,
                           borderColor: !dispatchRef.trim() ? '#ef4444' : 'var(--brand-orange)',
                           boxSizing: 'border-box',
                         }}
                       />
                       {!dispatchRef.trim() && (
                         <div style={{ marginTop: 8, fontSize: '0.75rem', color: '#ef4444', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
                           <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                           Dispatch reference is mandatory for aggregator submission
                         </div>
                       )}
                     </div>
                   ) : (
                     /* ── SCHEME: Pre-Authorization ── */
                     <div className="card" style={{ padding: 16 }}>
                       <h3 style={{ fontSize: '0.9rem', fontWeight: 600, margin: '0 0 12px 0', color: 'var(--text-primary)' }}>Pre-Authorization</h3>
                       <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                         <button
                           className="btn btn-secondary"
                           onClick={handleRequestAuth}
                           disabled={authLoading}
                           style={{ flex: 1, height: 38 }}
                         >
                           {authLoading ? <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> : '🔐 Fetch from Switch'}
                         </button>
                       </div>
                       
                       {/* Manual Override Option */}
                       <div style={{ display: 'flex', gap: 8 }}>
                         <input
                            className="input"
                            placeholder="Type manual Auth #..."
                            value={manualAuth}
                            onChange={e => setManualAuth(e.target.value)}
                            style={{ flex: 1, height: 38, fontSize: '0.85rem' }}
                         />
                         <button 
                            className="btn btn-primary"
                            onClick={handleSaveManualAuth}
                            disabled={!manualAuth.trim()}
                            style={{ height: 38, padding: '0 16px', fontSize: '0.85rem' }}
                         >
                           Save
                         </button>
                       </div>

                       {authResult && authResult.status === 'APPROVED' && (
                         <div style={{ padding: '8px', borderRadius: 6, background: 'rgba(16, 185, 129, 0.12)', fontSize: '0.8rem', color: '#10b981', fontWeight: 600, textAlign: 'center', marginTop: 12 }}>
                           Approved: {authResult.auth_number}
                         </div>
                       )}
                       {authResult && (authResult.status === 'DECLINED' || authResult.status === 'error') && (
                         <div style={{ padding: '8px', borderRadius: 6, background: 'rgba(239, 68, 68, 0.1)', fontSize: '0.8rem', color: '#ef4444', fontWeight: 600, textAlign: 'center', marginTop: 12 }}>
                           {authResult.decline_reason}
                         </div>
                       )}
                     </div>
                   )}

                   {/* THE BIG BUTTON */}
                   <button
                      className="btn btn-primary"
                      onClick={handleSubmitClaim}
                      disabled={submitting || result.rfis_generated.length > 0 || (payerType === 'AGGREGATOR' && !dispatchRef.trim())}
                      style={{ 
                        width: '100%', height: 50, fontSize: '1.05rem', fontWeight: 700,
                        background: (result.rfis_generated.length > 0 || (payerType === 'AGGREGATOR' && !dispatchRef.trim())) ? 'var(--surface-300)' : 'var(--gradient-primary)',
                        color: (result.rfis_generated.length > 0 || (payerType === 'AGGREGATOR' && !dispatchRef.trim())) ? 'var(--text-muted)' : 'white',
                        boxShadow: (result.rfis_generated.length > 0 || (payerType === 'AGGREGATOR' && !dispatchRef.trim())) ? 'none' : '0 10px 20px rgba(8, 131, 149, 0.3)',
                        transition: 'transform 0.15s ease, box-shadow 0.15s ease',
                      }}
                      onMouseEnter={e => { if (result.rfis_generated.length === 0) e.currentTarget.style.transform = 'translateY(-2px)' }}
                      onMouseLeave={e => { if (result.rfis_generated.length === 0) e.currentTarget.style.transform = 'none' }}
                   >
                     {submitting ? (
                        <>
                          <span className="spinner" style={{ width: 18, height: 18, borderWidth: 3 }} />
                          Transmitting to {payerType === 'AGGREGATOR' ? 'Aggregator' : 'Switch'}...
                        </>
                     ) : result.rfis_generated.length > 0 ? 'Fix Errors Before Submit'
                       : payerType === 'AGGREGATOR' && !dispatchRef.trim() ? 'Enter Dispatch Ref to Submit'
                       : `🚀 Submit ${payerType === 'AGGREGATOR' ? 'to Aggregator' : 'Claim'}`}
                   </button>
                 </div>
               </div>
             </>
          ) : null}
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
