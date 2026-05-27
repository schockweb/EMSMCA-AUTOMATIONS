/**
 * SystemHealth — Platform-wide crash monitoring dashboard.
 * Admin-only real-time view of crashes across Backend, Celery, and Frontend.
 */
import { useState, useEffect, useCallback } from 'react';
import api from '../api/client';

interface CrashEvent {
  id: string;
  source: string;
  severity: string;
  error_type: string;
  message: string;
  stacktrace?: string;
  endpoint?: string;
  user_id?: string;
  metadata_blob?: Record<string, unknown>;
  resolved: boolean;
  resolved_at?: string;
  created_at: string;
}

interface CrashStats {
  health_status: string;
  by_source: Record<string, { critical: number; error: number; warning: number; total: number }>;
  buckets: { '24h': number; '7d': number; '30d': number };
  unresolved: number;
  daily_trend: Array<{ date: string; critical: number; error: number; warning: number; total: number }>;
  top_endpoints: Array<{ endpoint: string; count: number }>;
}

export default function SystemHealth() {
  const [stats, setStats] = useState<CrashStats | null>(null);
  const [crashes, setCrashes] = useState<CrashEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [totalCrashes, setTotalCrashes] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filterSource, setFilterSource] = useState('');
  const [filterSeverity, setFilterSeverity] = useState('');
  const [filterResolved, setFilterResolved] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [purging, setPurging] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const [statsRes, crashesRes] = await Promise.all([
        api.get('/api/crashes/stats'),
        api.get('/api/crashes', {
          params: {
            page,
            page_size: 25,
            days: 30,
            ...(filterSource && { source: filterSource }),
            ...(filterSeverity && { severity: filterSeverity }),
            ...(filterResolved !== '' && { resolved: filterResolved === 'true' }),
            ...(searchQuery && { search: searchQuery }),
          },
        }),
      ]);
      setStats(statsRes.data);
      setCrashes(crashesRes.data.items);
      setTotalCrashes(crashesRes.data.total);
      setTotalPages(crashesRes.data.pages);
    } catch (err) {
      console.error('Failed to fetch crash data:', err);
    } finally {
      setLoading(false);
    }
  }, [page, filterSource, filterSeverity, filterResolved, searchQuery]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 10000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const handleResolve = async (id: string) => {
    try {
      await api.patch(`/api/crashes/${id}/resolve`);
      fetchData();
    } catch (err) {
      console.error('Failed to resolve crash:', err);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.delete(`/api/crashes/${id}`);
      fetchData();
    } catch (err) {
      console.error('Failed to delete crash:', err);
    }
  };

  const handlePurge = async () => {
    setPurging(true);
    try {
      const res = await api.post('/api/crashes/purge');
      alert(`Purged ${res.data.purged} old crash records.`);
      fetchData();
    } catch (err) {
      console.error('Purge failed:', err);
    } finally {
      setPurging(false);
    }
  };

  const timeAgo = (iso: string) => {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  };

  if (loading && !stats) {
    return (
      <div className="page-content" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '80vh', flexDirection: 'column', gap: 20 }}>
        <div className="spinner" style={{ width: 50, height: 50, borderWidth: 4, borderColor: 'var(--primary-400) transparent' }} />
        <p style={{ color: 'var(--primary-400)', fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase', animation: 'pulse 1.5s infinite' }}>Loading System Health...</p>
      </div>
    );
  }

  const healthColors: Record<string, { bg: string; border: string; text: string; glow: string }> = {
    healthy: { bg: 'rgba(16, 185, 129, 0.1)', border: '#10b981', text: '#10b981', glow: '0 0 30px rgba(16, 185, 129, 0.2)' },
    stable: { bg: 'rgba(59, 130, 246, 0.1)', border: '#3b82f6', text: '#3b82f6', glow: '0 0 30px rgba(59, 130, 246, 0.2)' },
    degraded: { bg: 'rgba(245, 158, 11, 0.1)', border: '#f59e0b', text: '#f59e0b', glow: '0 0 30px rgba(245, 158, 11, 0.2)' },
    critical: { bg: 'rgba(239, 68, 68, 0.1)', border: '#ef4444', text: '#ef4444', glow: '0 0 30px rgba(239, 68, 68, 0.3)' },
  };

  const healthStyle = healthColors[stats?.health_status || 'healthy'];

  const severityColors: Record<string, string> = {
    critical: '#ef4444',
    error: '#f59e0b',
    warning: '#3b82f6',
  };

  const sourceIcons: Record<string, React.ReactNode> = {
    backend: <path d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" />,
    celery: <><rect x="4" y="4" width="16" height="16" rx="2" ry="2" /><rect x="9" y="9" width="6" height="6" /><line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" /><line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" /></>,
    frontend: <><rect x="2" y="3" width="20" height="14" rx="2" ry="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" /></>,
  };

  const sourceLabels: Record<string, string> = {
    backend: 'FastAPI Backend',
    celery: 'Celery Workers',
    frontend: 'React Frontend',
  };

  const maxTrendValue = Math.max(...(stats?.daily_trend || []).map(d => d.total), 1);

  return (
    <div className="page-content" style={{ padding: '32px 40px', maxWidth: 1400, margin: '0 auto' }}>

      {/* ── Health Status Banner ── */}
      <div style={{
        background: healthStyle.bg,
        border: `1px solid ${healthStyle.border}`,
        borderRadius: 24,
        padding: '36px 48px',
        marginBottom: 32,
        boxShadow: healthStyle.glow,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 24,
        position: 'relative', overflow: 'hidden',
      }}>
        {/* Background pulse for critical */}
        {stats?.health_status === 'critical' && (
          <div style={{
            position: 'absolute', inset: 0,
            background: `radial-gradient(circle at 50% 50%, ${healthStyle.border}15 0%, transparent 70%)`,
            animation: 'pulse 2s infinite',
          }} />
        )}

        <div style={{ zIndex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 12 }}>
            <div style={{
              width: 14, height: 14, borderRadius: '50%', background: healthStyle.text,
              boxShadow: `0 0 12px ${healthStyle.text}`,
              animation: stats?.health_status !== 'healthy' ? 'pulse 2s infinite' : 'none',
            }} />
            <h1 style={{ fontSize: '2rem', fontWeight: 800, color: 'var(--text-primary)', margin: 0, letterSpacing: '-0.02em' }}>
              System Health
            </h1>
          </div>
          <p style={{ fontSize: '1.05rem', color: 'var(--text-secondary)', margin: 0 }}>
            Platform status: <span style={{ color: healthStyle.text, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1 }}>{stats?.health_status || 'unknown'}</span>
            {' '} — {stats?.unresolved || 0} unresolved {(stats?.unresolved || 0) === 1 ? 'issue' : 'issues'}
          </p>
        </div>

        <div style={{ display: 'flex', gap: 16, zIndex: 1 }}>
          <TimeBucket label="24h" value={stats?.buckets['24h'] || 0} />
          <TimeBucket label="7 Days" value={stats?.buckets['7d'] || 0} />
          <TimeBucket label="30 Days" value={stats?.buckets['30d'] || 0} />
        </div>
      </div>

      {/* ── Source Breakdown Cards ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20, marginBottom: 32 }}>
        {['backend', 'celery', 'frontend'].map(src => {
          const data = stats?.by_source[src] || { critical: 0, error: 0, warning: 0, total: 0 };
          return (
            <div key={src} style={{
              background: 'var(--surface-50)', border: '1px solid var(--surface-200)',
              borderRadius: 20, padding: '28px', position: 'relative', overflow: 'hidden',
              transition: 'all 0.3s',
            }}
            onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-4px)'; e.currentTarget.style.boxShadow = '0 12px 30px rgba(0,0,0,0.08)'; }}
            onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = 'none'; }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
                <div>
                  <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>
                    {sourceLabels[src]}
                  </div>
                  <div style={{ fontSize: '2.5rem', fontWeight: 800, color: 'var(--text-primary)', lineHeight: 1 }}>
                    {data.total}
                  </div>
                </div>
                <div style={{
                  width: 48, height: 48, borderRadius: 14,
                  background: data.total > 0 ? (data.critical > 0 ? 'rgba(239,68,68,0.12)' : 'rgba(245,158,11,0.12)') : 'rgba(16,185,129,0.12)',
                  color: data.total > 0 ? (data.critical > 0 ? '#ef4444' : '#f59e0b') : '#10b981',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">{sourceIcons[src]}</svg>
                </div>
              </div>

              {/* Severity sparkline */}
              <div style={{ display: 'flex', gap: 12 }}>
                {(['critical', 'error', 'warning'] as const).map(sev => (
                  <div key={sev} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: severityColors[sev], display: 'inline-block' }} />
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontWeight: 500 }}>
                      {data[sev]} {sev}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* ── 7-Day Trend Chart + Top Endpoints ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 360px', gap: 24, marginBottom: 32 }}>
        {/* Trend bars */}
        <div style={{ background: 'var(--surface-50)', border: '1px solid var(--surface-200)', borderRadius: 20, padding: '28px' }}>
          <h3 style={{ fontSize: '1rem', fontWeight: 700, margin: '0 0 24px', color: 'var(--text-primary)' }}>7-Day Crash Trend</h3>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 160 }}>
            {stats?.daily_trend.map((day, i) => {
              const total = day.total;
              const height = maxTrendValue > 0 ? Math.max((total / maxTrendValue) * 140, total > 0 ? 8 : 2) : 2;
              const dayLabel = new Date(day.date + 'T00:00:00').toLocaleDateString('en', { weekday: 'short' });
              const barColor = day.critical > 0 ? '#ef4444' : day.error > 0 ? '#f59e0b' : day.warning > 0 ? '#3b82f6' : 'var(--surface-300)';
              return (
                <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: '0.75rem', fontWeight: 700, color: total > 0 ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                    {total > 0 ? total : ''}
                  </span>
                  <div style={{
                    width: '100%', maxWidth: 48, height, borderRadius: 8,
                    background: `linear-gradient(180deg, ${barColor} 0%, ${barColor}99 100%)`,
                    transition: 'height 0.5s cubic-bezier(0.16, 1, 0.3, 1)',
                    boxShadow: total > 0 ? `0 4px 12px ${barColor}30` : 'none',
                  }} />
                  <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontWeight: 600 }}>{dayLabel}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Top crashing endpoints */}
        <div style={{ background: 'var(--surface-50)', border: '1px solid var(--surface-200)', borderRadius: 20, padding: '28px' }}>
          <h3 style={{ fontSize: '1rem', fontWeight: 700, margin: '0 0 20px', color: 'var(--text-primary)' }}>Top Crashing Endpoints</h3>
          {(stats?.top_endpoints || []).length === 0 ? (
            <div style={{ color: 'var(--text-muted)', fontSize: '0.9rem', textAlign: 'center', padding: '40px 0' }}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" style={{ opacity: 0.4, margin: '0 auto 12px', display: 'block' }}>
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
              </svg>
              No crashes — all clear!
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {stats?.top_endpoints.map((ep, i) => (
                <div key={i} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '10px 14px', borderRadius: 12,
                  background: 'var(--surface-100)', fontSize: '0.85rem',
                }}>
                  <span style={{ color: 'var(--text-secondary)', fontFamily: 'monospace', fontWeight: 500, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {ep.endpoint}
                  </span>
                  <span style={{
                    fontWeight: 700, color: '#ef4444', minWidth: 32, textAlign: 'right',
                    background: 'rgba(239,68,68,0.1)', padding: '2px 10px', borderRadius: 8,
                  }}>
                    {ep.count}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Filters & Actions Bar ── */}
      <div style={{
        display: 'flex', gap: 12, marginBottom: 20, alignItems: 'center', flexWrap: 'wrap',
      }}>
        <input
          id="crash-search"
          type="text"
          placeholder="Search errors..."
          value={searchQuery}
          onChange={e => { setSearchQuery(e.target.value); setPage(1); }}
          style={{
            background: 'var(--surface-50)', border: '1px solid var(--surface-200)',
            borderRadius: 12, padding: '10px 16px', fontSize: '0.9rem', flex: '1 1 200px',
            color: 'var(--text-primary)', outline: 'none', minWidth: 180,
          }}
        />
        <select
          id="filter-source"
          value={filterSource}
          onChange={e => { setFilterSource(e.target.value); setPage(1); }}
          style={selectStyle}
        >
          <option value="">All Sources</option>
          <option value="backend">Backend</option>
          <option value="celery">Celery</option>
          <option value="frontend">Frontend</option>
        </select>
        <select
          id="filter-severity"
          value={filterSeverity}
          onChange={e => { setFilterSeverity(e.target.value); setPage(1); }}
          style={selectStyle}
        >
          <option value="">All Severities</option>
          <option value="critical">Critical</option>
          <option value="error">Error</option>
          <option value="warning">Warning</option>
        </select>
        <select
          id="filter-resolved"
          value={filterResolved}
          onChange={e => { setFilterResolved(e.target.value); setPage(1); }}
          style={selectStyle}
        >
          <option value="">All Status</option>
          <option value="false">Unresolved</option>
          <option value="true">Resolved</option>
        </select>

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button
            onClick={fetchData}
            style={{
              background: 'var(--surface-100)', border: '1px solid var(--surface-200)',
              borderRadius: 12, padding: '10px 18px', fontSize: '0.85rem', fontWeight: 600,
              color: 'var(--text-secondary)', cursor: 'pointer', transition: 'all 0.2s',
              display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
            Refresh
          </button>
          <button
            onClick={handlePurge}
            disabled={purging}
            style={{
              background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)',
              borderRadius: 12, padding: '10px 18px', fontSize: '0.85rem', fontWeight: 600,
              color: '#ef4444', cursor: 'pointer', transition: 'all 0.2s',
              opacity: purging ? 0.5 : 1,
            }}
          >
            {purging ? 'Purging...' : 'Purge Old (90d+)'}
          </button>
        </div>
      </div>

      {/* ── Crash Count Summary ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h3 style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
          Crash Events <span style={{ fontWeight: 500, color: 'var(--text-muted)' }}>({totalCrashes})</span>
        </h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.75rem', fontWeight: 600, color: 'var(--accent-400)' }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor', animation: 'pulse 1.5s infinite' }} />
          Auto-refreshing every 10s
        </div>
      </div>

      {/* ── Live Crash Feed Table ── */}
      <div style={{ background: 'var(--surface-50)', border: '1px solid var(--surface-200)', borderRadius: 20, overflow: 'hidden' }}>
        {crashes.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px 24px', color: 'var(--text-muted)' }}>
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" style={{ opacity: 0.3, margin: '0 auto 16px', display: 'block' }}>
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              <path d="M9 12l2 2 4-4" />
            </svg>
            <p style={{ fontWeight: 600, fontSize: '1.1rem', margin: '0 0 4px' }}>All systems clean</p>
            <p style={{ fontSize: '0.85rem' }}>No crash events match your current filters.</p>
          </div>
        ) : (
          <table id="crash-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--surface-200)' }}>
                {['Severity', 'Source', 'Error', 'Endpoint', 'Time', 'Actions'].map(h => (
                  <th key={h} style={{
                    padding: '14px 16px', textAlign: 'left', fontSize: '0.75rem', fontWeight: 700,
                    color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5,
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {crashes.map(crash => (
                <>
                  <tr
                    key={crash.id}
                    onClick={() => setExpandedId(expandedId === crash.id ? null : crash.id)}
                    style={{
                      borderBottom: '1px solid var(--surface-100)',
                      cursor: 'pointer', transition: 'background 0.15s',
                      background: crash.resolved ? 'transparent' : (crash.severity === 'critical' ? 'rgba(239,68,68,0.03)' : 'transparent'),
                      opacity: crash.resolved ? 0.6 : 1,
                    }}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-100)'}
                    onMouseLeave={e => e.currentTarget.style.background = crash.resolved ? 'transparent' : (crash.severity === 'critical' ? 'rgba(239,68,68,0.03)' : 'transparent')}
                  >
                    {/* Severity dot */}
                    <td style={{ padding: '14px 16px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{
                          width: 10, height: 10, borderRadius: '50%',
                          background: severityColors[crash.severity] || '#94a3b8',
                          boxShadow: crash.severity === 'critical' ? `0 0 8px ${severityColors.critical}` : 'none',
                          animation: crash.severity === 'critical' && !crash.resolved ? 'pulse 2s infinite' : 'none',
                        }} />
                        <span style={{
                          fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase',
                          color: severityColors[crash.severity] || 'var(--text-muted)',
                          letterSpacing: 0.5,
                        }}>
                          {crash.severity}
                        </span>
                      </div>
                    </td>

                    {/* Source badge */}
                    <td style={{ padding: '14px 8px' }}>
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', gap: 4,
                        padding: '4px 10px', borderRadius: 8,
                        background: crash.source === 'backend' ? 'rgba(99,102,241,0.1)' :
                                   crash.source === 'celery' ? 'rgba(245,158,11,0.1)' : 'rgba(16,185,129,0.1)',
                        color: crash.source === 'backend' ? '#6366f1' :
                               crash.source === 'celery' ? '#f59e0b' : '#10b981',
                        fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5,
                      }}>
                        {crash.source}
                      </span>
                    </td>

                    {/* Error type + message */}
                    <td style={{ padding: '14px 8px', maxWidth: 400 }}>
                      <div style={{ fontWeight: 700, fontSize: '0.85rem', color: 'var(--text-primary)', marginBottom: 2 }}>
                        {crash.error_type}
                        {crash.resolved && <span style={{ marginLeft: 8, fontSize: '0.7rem', color: '#10b981', fontWeight: 600 }}>✓ RESOLVED</span>}
                      </div>
                      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 380 }}>
                        {crash.message}
                      </div>
                    </td>

                    {/* Endpoint */}
                    <td style={{ padding: '14px 8px' }}>
                      <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontFamily: 'monospace', fontWeight: 500 }}>
                        {crash.endpoint ? (crash.endpoint.length > 40 ? crash.endpoint.slice(0, 40) + '…' : crash.endpoint) : '—'}
                      </span>
                    </td>

                    {/* Time */}
                    <td style={{ padding: '14px 8px' }}>
                      <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontWeight: 500, whiteSpace: 'nowrap' }}>
                        {timeAgo(crash.created_at)}
                      </span>
                    </td>

                    {/* Actions */}
                    <td style={{ padding: '14px 16px' }}>
                      <div style={{ display: 'flex', gap: 6 }} onClick={e => e.stopPropagation()}>
                        {!crash.resolved && (
                          <button
                            onClick={() => handleResolve(crash.id)}
                            title="Mark as resolved"
                            style={{
                              background: 'rgba(16,185,129,0.1)', color: '#10b981', border: 'none',
                              borderRadius: 8, width: 32, height: 32, cursor: 'pointer',
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              transition: 'all 0.2s',
                            }}
                            onMouseEnter={e => e.currentTarget.style.background = 'rgba(16,185,129,0.2)'}
                            onMouseLeave={e => e.currentTarget.style.background = 'rgba(16,185,129,0.1)'}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12" /></svg>
                          </button>
                        )}
                        <button
                          onClick={() => handleDelete(crash.id)}
                          title="Delete"
                          style={{
                            background: 'rgba(239,68,68,0.08)', color: '#ef4444', border: 'none',
                            borderRadius: 8, width: 32, height: 32, cursor: 'pointer',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            transition: 'all 0.2s',
                          }}
                          onMouseEnter={e => e.currentTarget.style.background = 'rgba(239,68,68,0.15)'}
                          onMouseLeave={e => e.currentTarget.style.background = 'rgba(239,68,68,0.08)'}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-2 14H7L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /></svg>
                        </button>
                      </div>
                    </td>
                  </tr>

                  {/* Expanded stacktrace */}
                  {expandedId === crash.id && (
                    <tr key={`${crash.id}-detail`}>
                      <td colSpan={6} style={{ padding: 0 }}>
                        <div style={{
                          background: 'var(--surface-100)', padding: '20px 24px', borderBottom: '1px solid var(--surface-200)',
                        }}>
                          <div style={{ fontWeight: 700, fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: 12, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                            Stack Trace
                          </div>
                          <pre style={{
                            background: '#0f172a', color: '#e2e8f0', padding: 20, borderRadius: 14, fontSize: '0.78rem',
                            lineHeight: 1.5, overflow: 'auto', maxHeight: 300, margin: 0,
                            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                            border: '1px solid rgba(255,255,255,0.06)',
                          }}>
                            {crash.stacktrace || 'No stacktrace available.'}
                          </pre>
                          {crash.metadata_blob && Object.keys(crash.metadata_blob).length > 0 && (
                            <div style={{ marginTop: 16 }}>
                              <div style={{ fontWeight: 700, fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                                Metadata
                              </div>
                              <pre style={{
                                background: '#0f172a', color: '#94a3b8', padding: 16, borderRadius: 12, fontSize: '0.75rem',
                                overflow: 'auto', maxHeight: 200, margin: 0, fontFamily: 'monospace',
                                border: '1px solid rgba(255,255,255,0.06)',
                              }}>
                                {JSON.stringify(crash.metadata_blob, null, 2)}
                              </pre>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Pagination ── */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 24 }}>
          <button
            disabled={page <= 1}
            onClick={() => setPage(p => p - 1)}
            style={paginationBtnStyle(page <= 1)}
          >
            ← Previous
          </button>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.85rem', color: 'var(--text-muted)', fontWeight: 600, padding: '0 12px' }}>
            Page {page} of {totalPages}
          </span>
          <button
            disabled={page >= totalPages}
            onClick={() => setPage(p => p + 1)}
            style={paginationBtnStyle(page >= totalPages)}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}


// ── Sub-components ──────────────────────────────────────

function TimeBucket({ label, value }: { label: string; value: number }) {
  return (
    <div style={{
      background: 'var(--surface-50)', border: '1px solid var(--surface-200)',
      borderRadius: 16, padding: '16px 24px', minWidth: 100, textAlign: 'center',
    }}>
      <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ fontSize: '1.75rem', fontWeight: 800, color: value > 0 ? '#ef4444' : 'var(--text-primary)' }}>
        {value}
      </div>
    </div>
  );
}


// ── Shared styles ───────────────────────────────────────

const selectStyle: React.CSSProperties = {
  background: 'var(--surface-50)', border: '1px solid var(--surface-200)',
  borderRadius: 12, padding: '10px 14px', fontSize: '0.85rem',
  color: 'var(--text-primary)', outline: 'none', cursor: 'pointer',
  minWidth: 130,
};

function paginationBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    background: disabled ? 'var(--surface-100)' : 'var(--surface-50)',
    border: '1px solid var(--surface-200)',
    borderRadius: 12, padding: '10px 20px', fontSize: '0.85rem', fontWeight: 600,
    color: disabled ? 'var(--text-muted)' : 'var(--text-primary)',
    cursor: disabled ? 'not-allowed' : 'pointer', transition: 'all 0.2s',
    opacity: disabled ? 0.5 : 1,
  };
}
