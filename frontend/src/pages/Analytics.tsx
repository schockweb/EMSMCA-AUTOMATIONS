/**
 * Analytics Page — DSO, revenue, OCR confidence, rejection rates, pipeline health, 7-day trends.
 * Centralized dashboard for system performance.
 */
import { useState, useEffect } from 'react';
import api from '../api/client';

interface Analytics {
  pipeline: { total_documents: number; completed: number; failed: number; needs_review: number; completion_rate: number; automation_rate: number; pending: number; preprocessing: number; extracting: number };
  financial: { total_claimed: number; total_approved: number; total_paid: number; patient_liability: number; revenue_leakage: number; collection_rate: number; dso: number };
  ocr_performance: { avg_confidence: number; high_confidence_count: number; medium_confidence_count: number; low_confidence_count: number; touchless_rate: number };
  claims: { total: number; clean: number; rfi: number; submitted: number; paid: number; rejected: number; clean_rate: number; rejection_rate: number; first_pass_rate: number };
  submissions: { total: number; submitted: number; accepted: number; rejected: number; acceptance_rate: number };
  rfi: { total: number; open: number; resolved: number; resolution_rate: number };
  trends: { documents_per_day: { date: string; count: number }[]; claims_per_day: { date: string; count: number }[] };
}

export default function AnalyticsDashboard() {
  const [data, setData] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(true);
  
  useEffect(() => { 
    loadAnalytics(); 
  }, []);

  const loadAnalytics = async () => {
    setLoading(true);
    try {
      const res = await api.get('/api/analytics/dashboard');
      setData(res.data);
    } catch (err) { console.error(err); } finally { setLoading(false); }
  };

  const formatZAR = (n: number) => `R ${n.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  if (loading) return <div className="page-content" style={{ display: 'flex', justifyContent: 'center', paddingTop: 100 }}><div className="spinner" style={{ width: 40, height: 40 }} /></div>;
  if (!data) return <div className="page-content"><p style={{ color: 'var(--text-muted)' }}>Failed to load analytics.</p></div>;

  return (
    <div className="page-content" style={{ animation: 'fadeInUp 0.6s ease-out' }}>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 24 }}>
        <div>
          <h1 className="page-title">Analytics Dashboard</h1>
          <p className="page-subtitle">Real-time claims lifecycle, system performance, and financial oversight.</p>
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <button className="btn btn-secondary btn-sm" onClick={() => { loadAnalytics(); }}>
            Refresh Data
          </button>
        </div>
      </div>

      {/* ── Financial KPIs ── */}
      <div className="stat-grid" style={{ marginBottom: 28 }}>
        <div className="stat-card">
          <div className="stat-label">Total Claimed</div>
          <div className="stat-value" style={{ fontSize: '1.5rem' }}>{formatZAR(data.financial.total_claimed)}</div>
          <div className="stat-change">Lifetime submitted value</div>
        </div>
        <div className="stat-card" style={{ background: 'rgba(16, 185, 129, 0.04)', borderColor: 'rgba(16, 185, 129, 0.2)' }}>
          <div className="stat-label" style={{ color: '#059669' }}>Total Paid</div>
          <div className="stat-value" style={{ fontSize: '1.5rem', color: '#10b981' }}>{formatZAR(data.financial.total_paid)}</div>
          <div className="stat-change" style={{ color: '#059669' }}>Collection rate: {data.financial.collection_rate}%</div>
        </div>
        <div className="stat-card" style={{ background: 'rgba(239, 68, 68, 0.04)', borderColor: 'rgba(239, 68, 68, 0.2)' }}>
          <div className="stat-label" style={{ color: '#dc2626' }}>Revenue Leakage</div>
          <div className="stat-value" style={{ fontSize: '1.5rem', color: '#ef4444' }}>{formatZAR(data.financial.revenue_leakage)}</div>
          <div className="stat-change" style={{ color: '#ef4444' }}>Claimed − Paid</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">DSO</div>
          <div className="stat-value" style={{ fontSize: '1.8rem' }}>{data.financial.dso}</div>
          <div className="stat-change">Days Sales Outstanding</div>
        </div>
      </div>

      {/* ── Claims Breakdown ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 20, marginBottom: 28 }}>
        <div className="card">
          <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: 20, color: 'var(--text-primary)' }}>Claims Status</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <MetricBar label="Clean" value={data.claims.clean} total={data.claims.total} color="#10b981" />
            <MetricBar label="RFI / Suspended" value={data.claims.rfi} total={data.claims.total} color="#eab308" />
            <MetricBar label="Submitted" value={data.claims.submitted} total={data.claims.total} color="#3b82f6" />
            <MetricBar label="Paid" value={data.claims.paid} total={data.claims.total} color="#059669" />
            <MetricBar label="Rejected" value={data.claims.rejected} total={data.claims.total} color="#ef4444" />
          </div>
          <div style={{ marginTop: 16, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <KPI label="First-pass rate" value={`${data.claims.first_pass_rate}%`} />
            <KPI label="Clean rate" value={`${data.claims.clean_rate}%`} />
            <KPI label="Rejection rate" value={`${data.claims.rejection_rate}%`} />
          </div>
        </div>

        <div className="card">
          <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: 20, color: 'var(--text-primary)' }}>OCR Performance</h3>
          {/* Confidence donut */}
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}>
            <div style={{ position: 'relative', width: 140, height: 140 }}>
              <svg viewBox="0 0 36 36" style={{ width: '100%', height: '100%', transform: 'rotate(-90deg)' }}>
                <circle cx="18" cy="18" r="15.91" fill="none" stroke="var(--surface-200)" strokeWidth="3" />
                <circle cx="18" cy="18" r="15.91" fill="none" stroke="#10b981" strokeWidth="3"
                  strokeDasharray={`${data.ocr_performance.avg_confidence} ${100 - data.ocr_performance.avg_confidence}`} strokeLinecap="round" />
              </svg>
              <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                <span style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--text-primary)' }}>{data.ocr_performance.avg_confidence}%</span>
                <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>Avg Confidence</span>
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 24 }}>
            <ConfBadge label="High (>85%)" count={data.ocr_performance.high_confidence_count} color="#10b981" />
            <ConfBadge label="Med (70-85%)" count={data.ocr_performance.medium_confidence_count} color="#eab308" />
            <ConfBadge label="Low (<70%)" count={data.ocr_performance.low_confidence_count} color="#ef4444" />
          </div>
          <div style={{ marginTop: 16, textAlign: 'center' }}>
            <KPI label="Touchless rate" value={`${data.ocr_performance.touchless_rate}%`} />
          </div>
        </div>
      </div>

      {/* ── Pipeline + RFI + EDI Row ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 20, marginBottom: 28 }}>
        <div className="card">
          <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: 16, color: 'var(--text-primary)' }}>Document Pipeline</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <MetricBar label="Completed" value={data.pipeline.completed} total={data.pipeline.total_documents} color="#10b981" />
            <MetricBar label="Processing" value={data.pipeline.preprocessing + data.pipeline.extracting} total={data.pipeline.total_documents} color="#3b82f6" />
            <MetricBar label="Pending" value={data.pipeline.pending} total={data.pipeline.total_documents} color="#94a3b8" />
            <MetricBar label="Failed" value={data.pipeline.failed} total={data.pipeline.total_documents} color="#ef4444" />
          </div>
          <div style={{ marginTop: 12 }}>
            <KPI label="Automation rate" value={`${data.pipeline.automation_rate}%`} />
          </div>
        </div>

        <div className="card">
          <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: 16, color: 'var(--text-primary)' }}>RFI Queue</h3>
          <div style={{ display: 'flex', gap: 20, justifyContent: 'center', marginBottom: 16 }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '2rem', fontWeight: 700, color: 'var(--warning-400)' }}>{data.rfi.open}</div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Open</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '2rem', fontWeight: 700, color: 'var(--accent-400)' }}>{data.rfi.resolved}</div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Resolved</div>
            </div>
          </div>
          <KPI label="Resolution rate" value={`${data.rfi.resolution_rate}%`} />
        </div>

        <div className="card">
          <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: 16, color: 'var(--text-primary)' }}>EDI Submissions</h3>
          <div style={{ display: 'flex', gap: 20, justifyContent: 'center', marginBottom: 16 }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '2rem', fontWeight: 700, color: 'var(--primary-400)' }}>{data.submissions.total}</div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Total</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '2rem', fontWeight: 700, color: 'var(--accent-400)' }}>{data.submissions.accepted}</div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Accepted</div>
            </div>
          </div>
          <KPI label="Acceptance rate" value={`${data.submissions.acceptance_rate}%`} />
        </div>
      </div>

      {/* ── 7-Day Trends ── */}
      <div className="card">
        <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: 20, color: 'var(--text-primary)' }}>7-Day Activity</h3>
        <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}>
          <TrendChart data={data.trends.documents_per_day} label="Documents" color="#3b82f6" />
          <TrendChart data={data.trends.claims_per_day} label="Claims" color="#10b981" />
        </div>
      </div>
    </div>
  );
}

/* ── Shared Sub-components ── */
function MetricBar({ label, value, total, color }: { label: string; value: number; total: number; color: string }) {
  const pct = total > 0 ? (value / total) * 100 : 0;
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem', marginBottom: 4 }}>
        <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
        <span style={{ fontWeight: 600, color }}>{value}</span>
      </div>
      <div style={{ height: 6, borderRadius: 3, background: 'var(--surface-200)', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, borderRadius: 3, background: color, transition: 'width 0.5s ease' }} />
      </div>
    </div>
  );
}

function KPI({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ textAlign: 'center', padding: '6px 12px', borderRadius: 8, background: 'var(--surface-100)' }}>
      <div style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-primary)' }}>{value}</div>
      <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>{label}</div>
    </div>
  );
}

function ConfBadge({ label, count, color }: { label: string; count: number; color: string }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ width: 10, height: 10, borderRadius: '50%', background: color, margin: '0 auto 4px' }} />
      <div style={{ fontSize: '0.85rem', fontWeight: 700, color }}>{count}</div>
      <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>{label}</div>
    </div>
  );
}

function TrendChart({ data, label, color }: { data: { date: string; count: number }[]; label: string; color: string }) {
  const max = Math.max(...data.map(d => d.count), 1);
  return (
    <div style={{ flex: '1 1 280px' }}>
      <div style={{ fontSize: '0.82rem', fontWeight: 600, marginBottom: 12, color: 'var(--text-secondary)' }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 80 }}>
        {data.map((d, i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
            <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>{d.count}</span>
            <div style={{
              width: '100%', maxWidth: 32, borderRadius: '4px 4px 0 0',
              height: `${Math.max((d.count / max) * 60, 4)}px`,
              background: `${color}${d.count > 0 ? '' : '30'}`, transition: 'height 0.4s ease',
            }} />
            <span style={{ fontSize: '0.58rem', color: 'var(--text-muted)' }}>
              {new Date(d.date).toLocaleDateString('en', { weekday: 'short' })}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
