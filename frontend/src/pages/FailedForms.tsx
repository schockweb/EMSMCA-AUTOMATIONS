/**
 * FailedForms — Admin page to view and manage PRF forms that failed processing.
 * Provides stats overview, searchable table, detail slide-over, and correction modal.
 */
import { useState, useEffect, useCallback } from 'react';
import api from '../api/client';

/* ────────────────── Types ────────────────── */

interface FailedFormStats {
  total_failed: number;
  failed_today: number;
  avg_attempts: number;
  oldest_unresolved_days: number;
}

interface FailedForm {
  id: number;
  prf_number: string;
  patient_name: string;
  error_message: string;
  attempts: number;
  failed_at: string;
  status: string;
  form_data?: Record<string, any>;
  last_error_detail?: string;
  created_at?: string;
}

/* ────────────────── Colours ────────────────── */

const teal = '#088395';
const rose = '#C2185B';
const amber = '#E65100';
const purple = '#7C3AED';

/* ────────────────── Component ────────────────── */

export default function FailedForms() {
  const [stats, setStats] = useState<FailedFormStats | null>(null);
  const [forms, setForms] = useState<FailedForm[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  // Detail slide-over
  const [selectedForm, setSelectedForm] = useState<FailedForm | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Correction modal
  const [correctingForm, setCorrectingForm] = useState<FailedForm | null>(null);
  const [correctionData, setCorrectionData] = useState('');
  const [correcting, setCorrecting] = useState(false);

  // Reprocess loading per row
  const [reprocessingId, setReprocessingId] = useState<number | null>(null);

  /* ── Data Fetching ── */

  const fetchStats = useCallback(async () => {
    try {
      const res = await api.get('/api/failed-prfs/stats');
      setStats(res.data);
    } catch { /* ignore */ }
  }, []);

  const fetchForms = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = {};
      if (search.trim()) params.search = search.trim();
      const res = await api.get('/api/failed-prfs', { params });
      setForms(res.data);
    } catch { /* ignore */ }
    setLoading(false);
  }, [search]);

  useEffect(() => { fetchStats(); }, [fetchStats]);
  useEffect(() => { fetchForms(); }, [fetchForms]);

  /* ── Detail Slide-over ── */

  const openDetail = async (form: FailedForm) => {
    setSelectedForm(form);
    setDetailLoading(true);
    try {
      const res = await api.get(`/api/failed-prfs/${form.id}`);
      setSelectedForm(res.data);
    } catch { /* use the list data we already have */ }
    setDetailLoading(false);
  };

  const closeDetail = () => setSelectedForm(null);

  /* ── Reprocess ── */

  const handleReprocess = async (id: number) => {
    setReprocessingId(id);
    try {
      await api.post(`/api/failed-prfs/${id}/reprocess`);
      fetchForms();
      fetchStats();
    } catch (e: any) {
      alert(e.response?.data?.detail || 'Reprocess failed');
    }
    setReprocessingId(null);
  };

  /* ── Correction Modal ── */

  const openCorrect = (form: FailedForm) => {
    setCorrectingForm(form);
    setCorrectionData(JSON.stringify(form.form_data || {}, null, 2));
  };

  const closeCorrect = () => {
    setCorrectingForm(null);
    setCorrectionData('');
  };

  const handleCorrect = async () => {
    if (!correctingForm) return;
    setCorrecting(true);
    try {
      const parsed = JSON.parse(correctionData);
      await api.put(`/api/failed-prfs/${correctingForm.id}/correct`, {
        form_data: parsed,
      });
      closeCorrect();
      closeDetail();
      fetchForms();
      fetchStats();
    } catch (e: any) {
      if (e instanceof SyntaxError) {
        alert('Invalid JSON — please fix the form data and try again.');
      } else {
        alert(e.response?.data?.detail || 'Correction failed');
      }
    }
    setCorrecting(false);
  };

  /* ── Helpers ── */

  const timeAgo = (dateStr: string) => {
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  };

  const attemptColor = (attempts: number) => {
    if (attempts >= 5) return rose;
    if (attempts >= 3) return amber;
    return 'var(--text-muted)';
  };

  /* ────────────────── Styles (matching RateSchemas patterns) ────────────────── */

  const cardStyle: React.CSSProperties = {
    background: 'var(--surface-50)',
    borderRadius: 12,
    border: '1px solid var(--surface-100)',
    padding: 20,
    marginBottom: 16,
  };

  const glassCard: React.CSSProperties = {
    background: 'linear-gradient(135deg, rgba(255,255,255,0.05), rgba(255,255,255,0.02))',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
    borderRadius: 14,
    border: '1px solid var(--surface-100)',
    padding: '18px 20px',
    position: 'relative',
    overflow: 'hidden',
    transition: 'transform 0.2s ease, box-shadow 0.2s ease',
    cursor: 'default',
  };

  const btnPrimary: React.CSSProperties = {
    background: `linear-gradient(135deg, ${teal}, #0a9396)`,
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    padding: '8px 18px',
    fontSize: '0.82rem',
    fontWeight: 700,
    cursor: 'pointer',
    letterSpacing: '0.03em',
    transition: 'opacity 0.2s ease',
  };

  const btnDanger: React.CSSProperties = {
    ...btnPrimary,
    background: `linear-gradient(135deg, ${rose}, #E91E63)`,
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    fontSize: '0.84rem',
    padding: '8px 12px',
    borderRadius: 8,
    border: '1px solid var(--surface-200)',
    background: 'var(--bg)',
    color: 'var(--text)',
    marginBottom: 8,
    boxSizing: 'border-box',
  };

  const labelStyle: React.CSSProperties = {
    fontSize: '0.68rem',
    fontWeight: 700,
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    marginBottom: 3,
    display: 'block',
  };

  const thStyle: React.CSSProperties = {
    padding: '10px 14px',
    fontWeight: 700,
    fontSize: '0.7rem',
    textTransform: 'uppercase',
    color: 'var(--text-muted)',
    whiteSpace: 'nowrap',
  };

  const overlayStyle: React.CSSProperties = {
    position: 'fixed',
    inset: 0,
    zIndex: 200,
    background: 'rgba(15,23,42,0.55)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  };

  const modalStyle: React.CSSProperties = {
    background: 'var(--bg)',
    borderRadius: 16,
    padding: 24,
    width: '100%',
    maxWidth: 640,
    maxHeight: '90vh',
    overflowY: 'auto',
    boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
  };

  /* ────────────────── Render ────────────────── */

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto' }}>
      {/* ── Header ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 800, margin: 0, color: 'var(--text)' }}>
            ⚠️ Failed Forms
          </h1>
          <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', margin: '4px 0 0' }}>
            Monitor and resolve PRF submissions that failed during processing
          </p>
        </div>
        <button
          style={btnPrimary}
          onClick={() => { fetchForms(); fetchStats(); }}
        >
          🔄 Refresh
        </button>
      </div>

      {/* ── Stats Cards ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 20 }}>
        {[
          {
            label: 'Total Failed',
            value: stats?.total_failed ?? '—',
            icon: '⚠️',
            accent: rose,
            glow: 'rgba(194,24,91,0.08)',
          },
          {
            label: 'Failed Today',
            value: stats?.failed_today ?? '—',
            icon: '📅',
            accent: amber,
            glow: 'rgba(230,81,0,0.08)',
          },
          {
            label: 'Avg Attempts',
            value: stats?.avg_attempts != null ? stats.avg_attempts.toFixed(1) : '—',
            icon: '🔄',
            accent: purple,
            glow: 'rgba(124,58,237,0.08)',
          },
          {
            label: 'Oldest Unresolved',
            value: stats?.oldest_unresolved_days != null
              ? `${stats.oldest_unresolved_days}d`
              : '—',
            icon: '⏳',
            accent: teal,
            glow: 'rgba(8,131,149,0.08)',
          },
        ].map((card) => (
          <div
            key={card.label}
            style={{ ...glassCard, background: card.glow }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLDivElement).style.transform = 'translateY(-2px)';
              (e.currentTarget as HTMLDivElement).style.boxShadow = `0 8px 24px ${card.glow}`;
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLDivElement).style.transform = 'translateY(0)';
              (e.currentTarget as HTMLDivElement).style.boxShadow = 'none';
            }}
          >
            <div style={{
              position: 'absolute',
              top: -18,
              right: -18,
              width: 64,
              height: 64,
              borderRadius: '50%',
              background: `radial-gradient(circle, ${card.glow}, transparent 70%)`,
              opacity: 0.6,
            }} />
            <div style={{ fontSize: '0.68rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
              {card.icon} {card.label}
            </div>
            <div style={{ fontSize: '1.6rem', fontWeight: 800, color: card.accent, lineHeight: 1.1 }}>
              {card.value}
            </div>
          </div>
        ))}
      </div>

      {/* ── Search ── */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center' }}>
        <input
          type="text"
          placeholder="Search by PRF #, patient name, or error..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ ...inputStyle, marginBottom: 0, maxWidth: 400 }}
          id="failed-forms-search"
        />
        <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginLeft: 'auto' }}>
          {forms.length} record{forms.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* ── Data Table ── */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>
          Loading failed forms...
        </div>
      ) : forms.length === 0 ? (
        <div style={{ ...cardStyle, textAlign: 'center', padding: 40 }}>
          <p style={{ fontSize: '2rem', margin: '0 0 8px' }}>🎉</p>
          <p style={{ fontSize: '1rem', color: 'var(--text-muted)' }}>
            {search ? 'No failed forms match your search' : 'No failed forms — everything is processing smoothly!'}
          </p>
        </div>
      ) : (
        <div style={{ ...cardStyle, padding: 0, overflow: 'hidden', overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem', minWidth: 850 }}>
            <thead>
              <tr style={{ background: 'var(--surface-100)', textAlign: 'left' }}>
                <th style={thStyle}>PRF #</th>
                <th style={thStyle}>Patient</th>
                <th style={thStyle}>Error</th>
                <th style={{ ...thStyle, textAlign: 'center' }}>Attempts</th>
                <th style={thStyle}>Failed At</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {forms.map((f) => (
                <tr
                  key={f.id}
                  style={{
                    borderBottom: '1px solid var(--surface-100)',
                    transition: 'background 0.15s ease',
                    cursor: 'pointer',
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLTableRowElement).style.background = 'var(--surface-50)';
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLTableRowElement).style.background = 'transparent';
                  }}
                >
                  <td style={{ padding: '10px 14px', fontFamily: 'monospace', fontWeight: 600, fontSize: '0.78rem' }}>
                    {f.prf_number}
                  </td>
                  <td style={{ padding: '10px 14px', fontWeight: 600 }}>
                    {f.patient_name}
                  </td>
                  <td style={{ padding: '10px 14px', maxWidth: 240 }}>
                    <span style={{
                      display: 'inline-block',
                      padding: '2px 8px',
                      borderRadius: 99,
                      fontSize: '0.7rem',
                      fontWeight: 600,
                      background: 'rgba(194,24,91,0.08)',
                      color: rose,
                      maxWidth: '100%',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>
                      {f.error_message}
                    </span>
                  </td>
                  <td style={{ padding: '10px 14px', textAlign: 'center' }}>
                    <span style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: 28,
                      height: 28,
                      borderRadius: '50%',
                      fontSize: '0.78rem',
                      fontWeight: 800,
                      color: attemptColor(f.attempts),
                      background: f.attempts >= 5
                        ? 'rgba(194,24,91,0.08)'
                        : f.attempts >= 3
                          ? 'rgba(230,81,0,0.08)'
                          : 'var(--surface-50)',
                    }}>
                      {f.attempts}
                    </span>
                  </td>
                  <td style={{ padding: '10px 14px', fontSize: '0.75rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                    <span title={new Date(f.failed_at).toLocaleString()}>
                      {timeAgo(f.failed_at)}
                    </span>
                  </td>
                  <td style={{ padding: '10px 14px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button
                      onClick={(e) => { e.stopPropagation(); openDetail(f); }}
                      style={{
                        background: 'none', border: 'none', cursor: 'pointer',
                        color: teal, fontSize: '0.75rem', fontWeight: 700, marginRight: 6,
                        transition: 'opacity 0.15s ease',
                      }}
                      title="View details"
                      id={`btn-view-${f.id}`}
                    >
                      👁 View
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); openCorrect(f); }}
                      style={{
                        background: 'none', border: 'none', cursor: 'pointer',
                        color: amber, fontSize: '0.75rem', fontWeight: 700, marginRight: 6,
                        transition: 'opacity 0.15s ease',
                      }}
                      title="Correct form data"
                      id={`btn-correct-${f.id}`}
                    >
                      ✏️ Correct
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleReprocess(f.id); }}
                      disabled={reprocessingId === f.id}
                      style={{
                        background: 'none', border: 'none', cursor: 'pointer',
                        color: purple, fontSize: '0.75rem', fontWeight: 700,
                        opacity: reprocessingId === f.id ? 0.5 : 1,
                        transition: 'opacity 0.15s ease',
                      }}
                      title="Reprocess"
                      id={`btn-reprocess-${f.id}`}
                    >
                      🔄 {reprocessingId === f.id ? 'Processing...' : 'Retry'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Detail Slide-over ── */}
      {selectedForm && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 300,
            background: 'rgba(15,23,42,0.45)',
            display: 'flex', justifyContent: 'flex-end',
          }}
          onClick={closeDetail}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: '100%', maxWidth: 520, height: '100%',
              background: 'var(--bg)',
              boxShadow: '-8px 0 40px rgba(0,0,0,0.18)',
              overflowY: 'auto',
              padding: 28,
              animation: 'slideInRight 0.25s ease',
            }}
          >
            {/* Slide-over animation via inline keyframes */}
            <style>{`
              @keyframes slideInRight {
                from { transform: translateX(100%); opacity: 0; }
                to   { transform: translateX(0);    opacity: 1; }
              }
            `}</style>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h2 style={{ fontSize: '1.1rem', fontWeight: 800, color: teal, margin: 0 }}>
                PRF Detail
              </h2>
              <button
                onClick={closeDetail}
                style={{
                  background: 'var(--surface-100)', border: 'none', borderRadius: 8,
                  width: 32, height: 32, cursor: 'pointer', fontSize: '1rem',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: 'var(--text-muted)',
                }}
              >
                ✕
              </button>
            </div>

            {detailLoading ? (
              <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>
                Loading details...
              </div>
            ) : (
              <>
                {/* Key-value fields */}
                <div style={{
                  display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20,
                }}>
                  {[
                    { label: 'PRF Number', value: selectedForm.prf_number },
                    { label: 'Patient', value: selectedForm.patient_name },
                    { label: 'Status', value: selectedForm.status },
                    { label: 'Attempts', value: String(selectedForm.attempts) },
                    { label: 'Failed At', value: new Date(selectedForm.failed_at).toLocaleString() },
                    { label: 'Created', value: selectedForm.created_at ? new Date(selectedForm.created_at).toLocaleString() : '—' },
                  ].map((field) => (
                    <div key={field.label}>
                      <div style={labelStyle}>{field.label}</div>
                      <div style={{
                        fontSize: '0.84rem', fontWeight: 600, color: 'var(--text)',
                        padding: '6px 0',
                      }}>
                        {field.label === 'Status' ? (
                          <span style={{
                            display: 'inline-block', padding: '2px 10px', borderRadius: 99,
                            fontSize: '0.7rem', fontWeight: 700,
                            background: field.value === 'failed' ? 'rgba(194,24,91,0.1)' : 'rgba(8,131,149,0.1)',
                            color: field.value === 'failed' ? rose : teal,
                          }}>
                            {field.value?.toUpperCase()}
                          </span>
                        ) : (
                          field.value
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Error message */}
                <div style={{ marginBottom: 20 }}>
                  <div style={labelStyle}>Error Message</div>
                  <div style={{
                    background: 'rgba(194,24,91,0.04)',
                    border: `1px solid rgba(194,24,91,0.15)`,
                    borderRadius: 10, padding: 14,
                    fontSize: '0.82rem', color: rose, lineHeight: 1.6,
                    fontFamily: 'monospace',
                    wordBreak: 'break-word',
                  }}>
                    {selectedForm.error_message}
                  </div>
                </div>

                {/* Detailed error */}
                {selectedForm.last_error_detail && (
                  <div style={{ marginBottom: 20 }}>
                    <div style={labelStyle}>Error Detail</div>
                    <div style={{
                      background: 'var(--surface-50)',
                      border: '1px solid var(--surface-100)',
                      borderRadius: 10, padding: 14,
                      fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.6,
                      fontFamily: 'monospace',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      maxHeight: 200,
                      overflowY: 'auto',
                    }}>
                      {selectedForm.last_error_detail}
                    </div>
                  </div>
                )}

                {/* Form data preview */}
                {selectedForm.form_data && (
                  <div style={{ marginBottom: 20 }}>
                    <div style={labelStyle}>Form Data</div>
                    <div style={{
                      background: 'var(--surface-50)',
                      border: '1px solid var(--surface-100)',
                      borderRadius: 10, padding: 14,
                      fontSize: '0.72rem', color: 'var(--text-muted)', lineHeight: 1.5,
                      fontFamily: 'monospace',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      maxHeight: 300,
                      overflowY: 'auto',
                    }}>
                      {JSON.stringify(selectedForm.form_data, null, 2)}
                    </div>
                  </div>
                )}

                {/* Actions */}
                <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
                  <button
                    style={btnPrimary}
                    onClick={() => handleReprocess(selectedForm.id)}
                    disabled={reprocessingId === selectedForm.id}
                  >
                    🔄 {reprocessingId === selectedForm.id ? 'Processing...' : 'Reprocess'}
                  </button>
                  <button
                    style={{ ...btnPrimary, background: `linear-gradient(135deg, ${amber}, #F57C00)` }}
                    onClick={() => openCorrect(selectedForm)}
                  >
                    ✏️ Correct
                  </button>
                  <button
                    style={{ ...btnPrimary, background: 'var(--surface-200)', color: 'var(--text)' }}
                    onClick={closeDetail}
                  >
                    Close
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Correction Modal ── */}
      {correctingForm && (
        <div style={overlayStyle} onClick={closeCorrect}>
          <div onClick={(e) => e.stopPropagation()} style={modalStyle}>
            <h2 style={{ fontSize: '1.1rem', fontWeight: 800, color: amber, marginBottom: 4, marginTop: 0 }}>
              ✏️ Correct Form Data
            </h2>
            <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '0 0 16px' }}>
              PRF <strong>{correctingForm.prf_number}</strong> — {correctingForm.patient_name}
            </p>

            {/* Error context */}
            <div style={{
              background: 'rgba(194,24,91,0.04)',
              border: `1px solid rgba(194,24,91,0.12)`,
              borderRadius: 8, padding: 10, marginBottom: 16,
              fontSize: '0.75rem', color: rose,
            }}>
              <strong>Error:</strong> {correctingForm.error_message}
            </div>

            <div>
              <label style={labelStyle}>Form Data (JSON)</label>
              <textarea
                value={correctionData}
                onChange={(e) => setCorrectionData(e.target.value)}
                style={{
                  ...inputStyle,
                  minHeight: 260,
                  fontFamily: 'monospace',
                  fontSize: '0.78rem',
                  resize: 'vertical',
                  lineHeight: 1.5,
                }}
                spellCheck={false}
                id="correction-data-editor"
              />
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button
                style={{ ...btnPrimary, background: `linear-gradient(135deg, ${amber}, #F57C00)` }}
                onClick={handleCorrect}
                disabled={correcting}
              >
                {correcting ? 'Saving...' : 'Save & Reprocess'}
              </button>
              <button
                style={{ ...btnPrimary, background: 'var(--surface-200)', color: 'var(--text)' }}
                onClick={closeCorrect}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Info Card ── */}
      <div style={{
        ...cardStyle, marginTop: 8, padding: 14,
        background: 'rgba(8,131,149,0.04)', border: '1px solid rgba(8,131,149,0.15)',
      }}>
        <div style={{
          fontSize: '0.72rem', fontWeight: 700, color: teal,
          textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6,
        }}>
          How Failed Forms Work
        </div>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
          <li><strong>Reprocess</strong> re-sends the original form data through the processing pipeline without changes.</li>
          <li><strong>Correct</strong> lets you edit the raw form JSON before reprocessing — use this when the error is caused by invalid data.</li>
          <li>Forms that have failed <strong>5+ times</strong> are highlighted in red and may need manual investigation.</li>
          <li>The system automatically retries transient failures — only persistent errors appear here.</li>
        </ul>
      </div>
    </div>
  );
}
