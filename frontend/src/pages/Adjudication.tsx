/**
 * Adjudication Page — Clinical scrubbing controls, check details, PMB badges, RFI management.
 */
import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
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
  rfis_generated: { reason_code: string; description: string; priority: string }[];
  modifiers_applied: string[];
}

export default function Adjudication() {
  const [claimId, setClaimId] = useState('');
  const [result, setResult] = useState<ScrubResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [searchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState<'scrub' | 'verify' | 'pmb'>('scrub');

  // Authorization request state
  const [authLoading, setAuthLoading] = useState(false);
  const [authResult, setAuthResult] = useState<{
    status: string;
    auth_number?: string;
    approved_amount?: number;
    decline_reason?: string;
  } | null>(null);

  useEffect(() => {
    // Check search params if needed
  }, [searchParams]);

  // BHF verifier state
  const [pcns, setPcns] = useState('');
  const [bhfResult, setBhfResult] = useState<Record<string, unknown> | null>(null);

  // PMB checker state
  const [pmbIcd, setPmbIcd] = useState('');
  const [pmbNotes, setPmbNotes] = useState('');
  const [pmbResult, setPmbResult] = useState<Record<string, unknown> | null>(null);

  const handleScrub = async () => {
    if (!claimId.trim()) return;
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const res = await api.post('/api/adjudication/scrub', { claim_id: claimId.trim() });
      setResult(res.data);
    } catch (err: any) {
      setError(err.response?.data?.detail || 'Scrub failed');
    } finally {
      setLoading(false);
    }
  };

  const handleRequestAuth = async (caseId: string) => {
    setAuthLoading(true);
    setAuthResult(null);
    try {
      const res = await api.post(`/api/authorization/request/${caseId}`);
      setAuthResult(res.data);
    } catch (err: any) {
      setAuthResult({
        status: 'error',
        decline_reason: err.response?.data?.detail || 'Authorization request failed',
      });
    } finally {
      setAuthLoading(false);
    }
  };

  const handleBHF = async () => {
    if (!pcns.trim()) return;
    setLoading(true);
    setBhfResult(null);
    try {
      const res = await api.post('/api/adjudication/verify-provider', { pcns: pcns.trim() });
      setBhfResult(res.data);
    } catch (err: any) {
      setBhfResult({ error: err.response?.data?.detail || 'Verification failed' });
    } finally {
      setLoading(false);
    }
  };

  const handlePMB = async () => {
    if (!pmbIcd.trim()) return;
    setLoading(true);
    setPmbResult(null);
    try {
      const res = await api.post('/api/adjudication/check-pmb', {
        primary_icd10: pmbIcd.trim(),
        clinical_notes: pmbNotes || undefined,
      });
      setPmbResult(res.data);
    } catch (err: any) {
      setPmbResult({ error: err.response?.data?.detail || 'PMB check failed' });
    } finally {
      setLoading(false);
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
    <div className="page-content">
      <div className="page-header">
        <h1 className="page-title">Clinical Adjudication</h1>
        <p className="page-subtitle">Scrub claims, verify providers, detect PMB conditions, and manage RFIs.</p>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 40, justifyContent: 'center' }}>
        {(['scrub', 'verify', 'pmb'] as const).map(tab => (
          <button
            key={tab}
            className={`btn ${activeTab === tab ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => { setActiveTab(tab); }}
            style={{ textTransform: 'capitalize' }}
          >
            {tab === 'scrub' ? 'Claim Scrub' : tab === 'verify' ? 'BHF Verify' : 'PMB Check'}
          </button>
        ))}
      </div>

      {/* ── TAB: SCRUB ── */}
      {activeTab === 'scrub' && (
        <>
          <div className="card" style={{ marginBottom: 24 }}>
            <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: 16, color: 'var(--text-primary)' }}>
              Run Adjudication Matrix
            </h3>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
              <div style={{ flex: 1 }}>
                <label className="input-label">Claim ID (UUID)</label>
                <input className="input" placeholder="e.g. 550e8400-e29b-41d4-a716-446655440000"
                  value={claimId} onChange={e => setClaimId(e.target.value)} />
              </div>
              <button className="btn btn-primary" onClick={handleScrub} disabled={loading} style={{ height: 42 }}>
                {loading ? <span className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} /> : 'Scrub'}
              </button>
            </div>
            {error && <div style={{ color: 'var(--error-400)', marginTop: 12, fontSize: '0.85rem' }}>{error}</div>}
          </div>

          {result && (
            <>
              {/* Summary Card */}
              <div className="card" style={{ marginBottom: 24, borderLeft: `4px solid ${result.is_clean ? 'var(--accent-400)' : 'var(--error-400)'}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 16 }}>
                  <div>
                    <h3 style={{ fontSize: '1.1rem', fontWeight: 700, color: result.is_clean ? 'var(--accent-400)' : 'var(--error-400)' }}>
                      {result.is_clean ? 'CLEAN CLAIM' : 'ACTION REQUIRED'}
                    </h3>
                    <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: '4px 0 0' }}>
                      {result.passed_checks}/{result.total_checks} checks passed • {result.warning_count} warnings • Pass rate: {(result.pass_rate * 100).toFixed(0)}%
                    </p>
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {result.is_pmb && (
                      <span style={{ padding: '4px 12px', borderRadius: 9999, fontSize: '0.75rem', fontWeight: 700, background: 'rgba(59, 130, 246, 0.15)', color: '#3b82f6' }}>
                        PMB
                      </span>
                    )}
                    {result.modifiers_applied.map((m, i) => (
                      <span key={i} style={{ padding: '4px 10px', borderRadius: 9999, fontSize: '0.72rem', fontWeight: 600, background: 'rgba(139, 92, 246, 0.15)', color: '#8b5cf6' }}>
                        {m}
                      </span>
                    ))}
                  </div>
                </div>

                {result.pmb_details && (
                  <div style={{ marginTop: 16, padding: 12, borderRadius: 8, background: 'rgba(59, 130, 246, 0.08)', fontSize: '0.82rem' }}>
                    <strong style={{ color: '#3b82f6' }}>PMB Coverage:</strong> {result.pmb_details.condition}
                    <br />
                    <span style={{ color: 'var(--text-muted)' }}>{result.pmb_details.legal_mandate}</span>
                  </div>
                )}
              </div>

              {/* Authorization Request Button */}
              <div style={{ marginTop: 16, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <button
                  className="btn btn-primary"
                  onClick={async () => {
                    // Get the case_id from the claim
                    try {
                      const claimRes = await api.get(`/api/claims/${result.claim_id}`);
                      const caseId = claimRes.data.case_id;
                      handleRequestAuth(caseId);
                    } catch {
                      setAuthResult({ status: 'error', decline_reason: 'Could not load claim details' });
                    }
                  }}
                  disabled={authLoading}
                  style={{ minWidth: 200 }}
                >
                  {authLoading ? (
                    <>
                      <span className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} />
                      Contacting Scheme...
                    </>
                  ) : '🔐 Request Authorization'}
                </button>

                {authResult && authResult.status === 'approved' && (
                  <div style={{
                    padding: '8px 16px',
                    borderRadius: 'var(--radius-md)',
                    background: 'rgba(16, 185, 129, 0.12)',
                    border: '1px solid rgba(16, 185, 129, 0.3)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    animation: 'fadeIn 0.3s ease',
                  }}>
                    <span style={{ fontSize: '1.1rem' }}>✅</span>
                    <div>
                      <div style={{ fontSize: '0.85rem', fontWeight: 700, color: '#10b981' }}>
                        Authorized: {authResult.auth_number}
                      </div>
                      {authResult.approved_amount && (
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                          Limit: R{Number(authResult.approved_amount).toLocaleString('en-ZA', { minimumFractionDigits: 2 })}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {authResult && authResult.status === 'declined' && (
                  <div style={{
                    padding: '8px 16px',
                    borderRadius: 'var(--radius-md)',
                    background: 'rgba(239, 68, 68, 0.1)',
                    border: '1px solid rgba(239, 68, 68, 0.3)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                  }}>
                    <span style={{ fontSize: '1.1rem' }}>❌</span>
                    <div>
                      <div style={{ fontSize: '0.85rem', fontWeight: 700, color: '#ef4444' }}>Declined</div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{authResult.decline_reason}</div>
                    </div>
                  </div>
                )}

                {authResult && authResult.status === 'error' && (
                  <div style={{
                    padding: '8px 16px',
                    borderRadius: 'var(--radius-md)',
                    background: 'rgba(251, 191, 36, 0.1)',
                    border: '1px solid rgba(251, 191, 36, 0.3)',
                    fontSize: '0.82rem',
                    color: '#d97706',
                  }}>
                    ⚠️ {authResult.decline_reason}
                  </div>
                )}
              </div>


              {/* Progress Bar */}
              <div style={{ marginBottom: 24 }}>
                <div style={{ height: 8, borderRadius: 4, background: 'var(--surface-200)', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${result.pass_rate * 100}%`, borderRadius: 4, background: result.is_clean ? 'var(--accent-400)' : 'var(--warning-400)', transition: 'width 0.6s ease' }} />
                </div>
              </div>

              {/* Check Details */}
              <div className="card" style={{ marginBottom: 24 }}>
                <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: 16, color: 'var(--text-primary)' }}>Validation Checks</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {result.checks.map((c, i) => (
                    <div key={i} style={{
                      padding: '10px 14px', borderRadius: 8,
                      background: c.passed ? 'rgba(16, 185, 129, 0.05)' : 'rgba(239, 68, 68, 0.05)',
                      border: `1px solid ${c.passed ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)'}`,
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span style={{ fontSize: '1rem' }}>{c.passed ? '✓' : c.severity === 'error' ? '✗' : '!'}</span>
                        <div>
                          <div style={{ fontSize: '0.82rem', fontWeight: 500, color: 'var(--text-primary)' }}>{c.check_name}</div>
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{c.message}</div>
                        </div>
                      </div>
                      <span style={{ fontSize: '0.68rem', fontWeight: 600, padding: '2px 8px', borderRadius: 4, color: severityColor(c.severity), background: `${severityColor(c.severity)}15` }}>
                        {c.severity}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Generated RFIs */}
              {result.rfis_generated.length > 0 && (
                <div className="card">
                  <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: 16, color: 'var(--error-400)' }}>
                    Generated RFIs ({result.rfis_generated.length})
                  </h3>
                  {result.rfis_generated.map((rfi, i) => (
                    <div key={i} style={{ padding: '10px 14px', borderRadius: 8, marginBottom: 8, background: 'rgba(239, 68, 68, 0.05)', border: '1px solid rgba(239, 68, 68, 0.12)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-primary)' }}>{rfi.reason_code}</span>
                        {priorityBadge(rfi.priority)}
                      </div>
                      <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '4px 0 0' }}>{rfi.description}</p>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* ── TAB: BHF VERIFY ── */}
      {activeTab === 'verify' && (
        <div className="card">
          <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: 16, color: 'var(--text-primary)' }}>BHF Provider Verification</h3>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', marginBottom: 20 }}>
            <div style={{ flex: 1 }}>
              <label className="input-label">PCNS Number</label>
              <input className="input" placeholder="e.g. 1812345" value={pcns} onChange={e => setPcns(e.target.value)} />
            </div>
            <button className="btn btn-primary" onClick={handleBHF} disabled={loading} style={{ height: 42 }}>Verify</button>
          </div>
          {bhfResult && (
            <div style={{ padding: 16, borderRadius: 8, background: (bhfResult as any).is_valid ? 'rgba(16, 185, 129, 0.06)' : 'rgba(239, 68, 68, 0.06)', border: `1px solid ${(bhfResult as any).is_valid ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)'}` }}>
              <div style={{ fontSize: '1rem', fontWeight: 700, marginBottom: 8, color: (bhfResult as any).is_valid ? 'var(--accent-400)' : 'var(--error-400)' }}>
                {(bhfResult as any).is_valid ? '✅ Valid Provider' : '❌ Invalid Provider'}
              </div>
              {(bhfResult as any).discipline && <p style={{ fontSize: '0.85rem', margin: '4px 0' }}>Discipline: <strong>{(bhfResult as any).discipline}</strong></p>}
              {(bhfResult as any).checks_passed?.map((c: string, i: number) => (
                <div key={i} style={{ fontSize: '0.78rem', color: 'var(--accent-400)', marginTop: 4 }}>✓ {c}</div>
              ))}
              {(bhfResult as any).checks_failed?.map((c: string, i: number) => (
                <div key={i} style={{ fontSize: '0.78rem', color: 'var(--error-400)', marginTop: 4 }}>✗ {c}</div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── TAB: PMB CHECK ── */}
      {activeTab === 'pmb' && (
        <div className="card">
          <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: 16, color: 'var(--text-primary)' }}>PMB Condition Check</h3>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
            <div style={{ flex: '1 1 200px' }}>
              <label className="input-label">Primary ICD-10 Code</label>
              <input className="input" placeholder="e.g. I21" value={pmbIcd} onChange={e => setPmbIcd(e.target.value)} />
            </div>
            <div style={{ flex: '2 1 300px' }}>
              <label className="input-label">Clinical Notes (optional)</label>
              <input className="input" placeholder="e.g. cardiac arrest, chest pain..." value={pmbNotes} onChange={e => setPmbNotes(e.target.value)} />
            </div>
            <button className="btn btn-primary" onClick={handlePMB} disabled={loading} style={{ height: 42, alignSelf: 'flex-end' }}>Check PMB</button>
          </div>
          {pmbResult && (
            <div style={{ padding: 16, borderRadius: 8, background: (pmbResult as any).icd10_check?.is_pmb ? 'rgba(59, 130, 246, 0.06)' : 'rgba(100, 116, 139, 0.06)', border: `1px solid ${(pmbResult as any).icd10_check?.is_pmb ? 'rgba(59, 130, 246, 0.15)' : 'rgba(100, 116, 139, 0.15)'}` }}>
              <div style={{ fontSize: '1rem', fontWeight: 700, marginBottom: 8, color: (pmbResult as any).icd10_check?.is_pmb ? '#3b82f6' : 'var(--text-muted)' }}>
                {(pmbResult as any).icd10_check?.is_pmb ? `🏥 PMB COVERAGE CONFIRMED` : '○ Not a PMB Condition'}
              </div>
              {(pmbResult as any).icd10_check?.condition && <p style={{ fontSize: '0.85rem', margin: '4px 0' }}>Condition: <strong>{(pmbResult as any).icd10_check.condition}</strong></p>}
              {(pmbResult as any).icd10_check?.modifier && <p style={{ fontSize: '0.85rem', margin: '4px 0' }}>Modifier: <code style={{ background: 'var(--surface-200)', padding: '2px 6px', borderRadius: 4 }}>{(pmbResult as any).icd10_check.modifier}</code></p>}
              {(pmbResult as any).icd10_check?.legal_mandate && <p style={{ fontSize: '0.78rem', margin: '8px 0 0', color: 'var(--text-muted)' }}>{(pmbResult as any).icd10_check.legal_mandate}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
