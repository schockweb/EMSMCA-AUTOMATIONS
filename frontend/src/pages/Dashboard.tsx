/**
 * Dashboard — Operations console.
 * Follows the established system theme: soft rounded cards, Inter typography,
 * brand tokens from index.css. Palette is restricted to white, teal, green,
 * orange (no magenta / purple) per the latest brief.
 */
import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { LoadErrorPanel, LoadErrorBar } from '../components/LoadError';

// ── Palette (locked to white / teal / green / orange) ──────────────────────
const TEAL = 'var(--brand-teal)';     // #088395
const GREEN = 'var(--brand-green)';   // #388E3C
const ORANGE = 'var(--brand-orange)'; // #F57C00
const TEAL_RGB = '8, 131, 149';
const GREEN_RGB = '56, 142, 60';
const ORANGE_RGB = '245, 124, 0';

interface Stats {
  documents: { total: number; pending: number; completed: number; needs_review: number };
  claims: { total: number; clean: number };
  cases: { total: number };
  pipeline: { ingested: number; preprocessed: number; ocr_completed: number; adjudicated: number; edi_submitted: number };
}

// ── Animated counter ───────────────────────────────────────────────────────
function AnimatedNumber({ value, suffix = '' }: { value: number; suffix?: string }) {
  const [display, setDisplay] = useState(0);
  const ref = useRef(0);
  useEffect(() => {
    const startVal = ref.current;
    const startTime = performance.now();
    const tick = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / 700, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = Math.round(startVal + (value - startVal) * eased);
      setDisplay(current);
      ref.current = current;
      if (progress < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, [value]);
  return <>{display.toLocaleString()}{suffix}</>;
}

// ── KPI stat card — matches .stat-card in index.css visually ───────────────
function StatCard({
  title, value, subtitle, accent, accentRgb, icon, onClick,
}: {
  title: string; value: number; subtitle: string;
  accent: string; accentRgb: string;
  icon: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        background: 'var(--gradient-card)',
        border: '1px solid var(--glass-border)',
        borderRadius: 'var(--radius-lg)',
        padding: '22px 24px',
        position: 'relative',
        overflow: 'hidden',
        cursor: onClick ? 'pointer' : 'default',
        transition: 'all var(--transition-normal)',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.transform = 'translateY(-2px)';
        e.currentTarget.style.boxShadow = `0 10px 28px -10px rgba(${accentRgb}, 0.28)`;
        e.currentTarget.style.borderColor = `rgba(${accentRgb}, 0.35)`;
      }}
      onMouseLeave={e => {
        e.currentTarget.style.transform = 'translateY(0)';
        e.currentTarget.style.boxShadow = 'none';
        e.currentTarget.style.borderColor = 'var(--glass-border)';
      }}
    >
      {/* Top accent bar, same trick as .stat-card::before */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 3,
        background: accent,
        borderTopLeftRadius: 'var(--radius-lg)', borderTopRightRadius: 'var(--radius-lg)',
      }} />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-muted)',
            textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 10,
          }}>
            {title}
          </div>
          <div style={{
            fontSize: '2.2rem', fontWeight: 800, color: 'var(--text-primary)',
            lineHeight: 1.05, fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.02em',
          }}>
            <AnimatedNumber value={value} />
          </div>
          <div style={{
            fontSize: '0.78rem', color: 'var(--text-muted)',
            marginTop: 8, lineHeight: 1.4,
          }}>{subtitle}</div>
        </div>
        <div style={{
          width: 44, height: 44, borderRadius: 'var(--radius-md)',
          background: `rgba(${accentRgb}, 0.1)`, color: accent,
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            {icon}
          </svg>
        </div>
      </div>
    </div>
  );
}


// ── Main Dashboard ─────────────────────────────────────────────────────────
export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState(new Date());
  // Distinguishes "server said zero" from "we never heard from the server" —
  // without it a dead backend rendered an all-zeros dashboard that looked
  // like a quiet day instead of an outage.
  const [loadError, setLoadError] = useState(false);
  const { user } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 15000);
    return () => clearInterval(interval);
  }, []);

  const fetchStats = async () => {
    try {
      const res = await api.get('/api/stats');
      setStats(res.data);
      setLastRefresh(new Date());
      setLoadError(false);
    } catch (_err) {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  };

  if (loading && !stats) {
    return (
      <div style={{
        display: 'flex', justifyContent: 'center', alignItems: 'center',
        height: '80vh', flexDirection: 'column', gap: 18,
      }}>
        <div style={{
          width: 44, height: 44, borderRadius: '50%',
          border: '3px solid var(--surface-200)', borderTopColor: TEAL,
          animation: 'dashSpin 0.8s linear infinite',
        }} />
        <p style={{
          color: TEAL, fontWeight: 700, letterSpacing: '0.1em',
          textTransform: 'uppercase', fontSize: '0.74rem', margin: 0,
        }}>
          Loading Dashboard…
        </p>
        <style>{`@keyframes dashSpin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  // First load failed → nothing to show. Render an explicit error instead of
  // falling through to a dashboard of zeros (which reads as "quiet day").
  if (!stats && loadError) {
    return (
      <div style={{ padding: '28px 36px', maxWidth: 720, margin: '0 auto', fontFamily: 'var(--font-sans)' }}>
        <LoadErrorPanel what="the dashboard" onRetry={() => { setLoading(true); fetchStats(); }} />
      </div>
    );
  }

  const d = stats?.documents;
  const c = stats?.claims;
  const p = stats?.pipeline;
  const needsReview = d?.needs_review || 0;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const firstName = user?.full_name?.split(' ')[0] || 'Admin';
  const docTotal = Math.max(d?.total || 0, 1);
  const claimTotal = Math.max(c?.total || 0, 1);

  return (
    <div style={{
      padding: '28px 36px 48px',
      maxWidth: 1320,
      margin: '0 auto',
      fontFamily: 'var(--font-sans)',
      minHeight: '100vh',
    }}>
      <style>{`
        @keyframes dashFadeUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        .dash-in { animation: dashFadeUp 0.4s ease-out forwards; }
      `}</style>

      {/* Background refresh failing — keep the stale numbers visible but say so */}
      {loadError && (
        <LoadErrorBar what="dashboard stats" onRetry={fetchStats} />
      )}

      {/* ── Header ───────────────────────────────────────────────────── */}
      <div className="dash-in" style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        gap: 16, marginBottom: 26, flexWrap: 'wrap',
      }}>
        <div>
          <h1 style={{
            fontSize: '1.7rem', fontWeight: 800, color: 'var(--text-primary)',
            margin: 0, letterSpacing: '-0.025em',
          }}>
            {greeting}, {firstName} 👋
          </h1>
          <p style={{
            fontSize: '0.85rem', color: 'var(--text-muted)',
            margin: '4px 0 0 0',
          }}>
            EMS Claims Command Centre &nbsp;·&nbsp; Refreshed {lastRefresh.toLocaleTimeString()}
          </p>
        </div>
        <button
          type="button"
          onClick={() => navigate('/cases')}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 8,
            padding: '11px 22px',
            background: 'var(--gradient-primary)',
            color: '#fff', border: 'none', borderRadius: 'var(--radius-md)',
            fontFamily: 'inherit', fontWeight: 700, fontSize: '0.88rem',
            cursor: 'pointer',
            boxShadow: `0 4px 14px rgba(${TEAL_RGB}, 0.35)`,
            transition: 'all var(--transition-fast)',
          }}
          onMouseEnter={e => {
            e.currentTarget.style.transform = 'translateY(-1px)';
            e.currentTarget.style.boxShadow = `0 8px 22px rgba(${TEAL_RGB}, 0.42)`;
          }}
          onMouseLeave={e => {
            e.currentTarget.style.transform = 'translateY(0)';
            e.currentTarget.style.boxShadow = `0 4px 14px rgba(${TEAL_RGB}, 0.35)`;
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
          </svg>
          Open Cases
        </button>
      </div>

      {/* ── KPIs ────────────────────────────────────────────────────── */}
      <div className="dash-in" style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(232px, 1fr))',
        gap: 16,
        marginBottom: 24,
      }}>
        <StatCard
          title="Total PRFs" value={d?.total || 0} subtitle="Lifetime documents ingested"
          accent={TEAL} accentRgb={TEAL_RGB}
          icon={<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></>}
        />
        <StatCard
          title="Active Cases" value={stats?.cases.total || 0} subtitle="Patient encounters managed"
          accent={TEAL} accentRgb={TEAL_RGB}
          onClick={() => navigate('/cases')}
          icon={<><path d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /></>}
        />
      </div>
    </div>
  );
}
