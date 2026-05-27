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

// ── Health bar row (icon + label + count + progress) ──────────────────────
function HealthRow({
  label, sub, value, total, accent, accentRgb, icon,
}: {
  label: string; sub: string; value: number; total: number;
  accent: string; accentRgb: string; icon: React.ReactNode;
}) {
  const pct = total > 0 ? Math.min((value / total) * 100, 100) : 0;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14,
      padding: '14px 16px',
      background: `rgba(${accentRgb}, 0.04)`,
      border: `1px solid rgba(${accentRgb}, 0.15)`,
      borderRadius: 'var(--radius-md)',
    }}>
      <div style={{
        width: 38, height: 38, borderRadius: 'var(--radius-md)',
        background: `rgba(${accentRgb}, 0.12)`, color: accent,
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          {icon}
        </svg>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, alignItems: 'baseline' }}>
          <div>
            <div style={{ fontSize: '0.84rem', fontWeight: 600, color: 'var(--text-primary)' }}>{label}</div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{sub}</div>
          </div>
          <span style={{
            fontSize: '0.95rem', fontWeight: 800, color: accent,
            fontVariantNumeric: 'tabular-nums',
          }}>
            <AnimatedNumber value={value} />
          </span>
        </div>
        <div style={{
          height: 5, background: 'var(--surface-200)',
          borderRadius: 'var(--radius-full)', overflow: 'hidden',
        }}>
          <div style={{
            height: '100%', width: `${pct}%`, background: accent,
            borderRadius: 'var(--radius-full)',
            transition: 'width 0.9s cubic-bezier(0.16,1,0.3,1)',
          }} />
        </div>
      </div>
    </div>
  );
}

// ── Navigation card — soft hover, accent slide ────────────────────────────
function NavCard({
  title, desc, icon, path, accent, accentRgb,
}: {
  title: string; desc: string; icon: React.ReactNode;
  path: string; accent: string; accentRgb: string;
}) {
  const navigate = useNavigate();
  return (
    <div
      onClick={() => navigate(path)}
      style={{
        background: 'var(--surface-0)', border: '1px solid var(--glass-border)',
        borderRadius: 'var(--radius-md)', padding: '14px 18px',
        display: 'flex', alignItems: 'center', gap: 14, cursor: 'pointer',
        transition: 'all var(--transition-fast)',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.borderColor = `rgba(${accentRgb}, 0.4)`;
        e.currentTarget.style.background = `rgba(${accentRgb}, 0.04)`;
        e.currentTarget.style.transform = 'translateX(3px)';
      }}
      onMouseLeave={e => {
        e.currentTarget.style.borderColor = 'var(--glass-border)';
        e.currentTarget.style.background = 'var(--surface-0)';
        e.currentTarget.style.transform = 'translateX(0)';
      }}
    >
      <div style={{
        width: 38, height: 38, borderRadius: 'var(--radius-md)',
        background: `rgba(${accentRgb}, 0.12)`, color: accent,
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          {icon}
        </svg>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: '0.88rem' }}>{title}</div>
        <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', marginTop: 2 }}>{desc}</div>
      </div>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round">
        <path d="M9 18l6-6-6-6" />
      </svg>
    </div>
  );
}

// ── Main Dashboard ─────────────────────────────────────────────────────────
export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState(new Date());
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
    } catch (err) {
      console.error('Failed to fetch stats:', err);
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
        <StatCard
          title="Clean Claims" value={c?.clean || 0} subtitle="Ready for EDI submission"
          accent={GREEN} accentRgb={GREEN_RGB}
          icon={<><rect x="2" y="5" width="20" height="14" rx="2" /><line x1="2" y1="10" x2="22" y2="10" /></>}
        />
        <StatCard
          title="Needs Review" value={needsReview} subtitle="Awaiting human verification"
          accent={ORANGE} accentRgb={ORANGE_RGB}
          icon={<><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></>}
        />
      </div>

      {/* ── Main grid: Health + Navigation ──────────────────────────── */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 340px',
        gap: 20, alignItems: 'start',
      }}>
        {/* Document Health */}
        <div className="dash-in" style={{
          background: 'var(--surface-0)', border: '1px solid var(--glass-border)',
          borderRadius: 'var(--radius-lg)', padding: '24px 26px',
          boxShadow: 'var(--glass-shadow)',
        }}>
          <div style={{ marginBottom: 18 }}>
            <h2 style={{
              fontSize: '1rem', fontWeight: 800, color: 'var(--text-primary)',
              margin: '0 0 4px 0',
            }}>Document Health</h2>
            <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: 0 }}>
              Status across all ingested documents
            </p>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <HealthRow
              label="Extracted" sub="AI structured & verified"
              value={d?.completed || 0} total={docTotal}
              accent={GREEN} accentRgb={GREEN_RGB}
              icon={<><polyline points="20 6 9 17 4 12" /></>}
            />
            <HealthRow
              label="Pending" sub="Awaiting AI processing"
              value={d?.pending || 0} total={docTotal}
              accent={ORANGE} accentRgb={ORANGE_RGB}
              icon={<><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></>}
            />
            <HealthRow
              label="Needs Review" sub="Low confidence or flagged"
              value={needsReview} total={docTotal}
              accent={ORANGE} accentRgb={ORANGE_RGB}
              icon={<><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></>}
            />
            <HealthRow
              label="Adjudicated" sub="Business rule validated"
              value={p?.adjudicated || 0} total={claimTotal}
              accent={TEAL} accentRgb={TEAL_RGB}
              icon={<><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="M9 12l2 2 4-4" /></>}
            />
            <HealthRow
              label="EDI Submitted" sub="Claims sent to schemes"
              value={p?.edi_submitted || 0} total={claimTotal}
              accent={TEAL} accentRgb={TEAL_RGB}
              icon={<><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></>}
            />
          </div>
        </div>

        {/* Quick Navigation */}
        <div className="dash-in" style={{
          background: 'var(--surface-0)', border: '1px solid var(--glass-border)',
          borderRadius: 'var(--radius-lg)', padding: 20,
          boxShadow: 'var(--glass-shadow)',
        }}>
          <h2 style={{
            fontSize: '0.9rem', fontWeight: 800, color: 'var(--text-primary)',
            margin: '0 0 14px 0', textTransform: 'uppercase', letterSpacing: '0.06em',
          }}>
            Quick Navigation
          </h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <NavCard
              title="Case Management" desc="Browse patient encounters & claims"
              path="/cases" accent={TEAL} accentRgb={TEAL_RGB}
              icon={<><path d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /></>}
            />
            <NavCard
              title="ERA / Payment Tracking" desc="Remittance advice & payment status"
              path="/era-tracking" accent={GREEN} accentRgb={GREEN_RGB}
              icon={<><line x1="12" y1="1" x2="12" y2="23" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></>}
            />
            <NavCard
              title="Analytics & Insights" desc="Operational reporting & trends"
              path="/analytics" accent={ORANGE} accentRgb={ORANGE_RGB}
              icon={<><line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" /></>}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
