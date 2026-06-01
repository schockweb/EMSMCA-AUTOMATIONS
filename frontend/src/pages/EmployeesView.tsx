/**
 * EmployeesView — Crew member cards with rounded profile icons,
 * HPCSA qualification badges (raw codes), shift status, and statistics.
 *
 * Mock data modelled on the backend CrewMember schema:
 *   full_name, initials, qualification, hpcsa_number, phone, is_active
 */
import { EmployeeLargeIcon } from '../components/AnimatedIcons';

// ── HPCSA Category Metadata (raw codes — full labels) ───────────────────────
const QUAL_META: Record<string, { label: string; color: string; bgAlpha: string }> = {
  BAA: { label: 'Basic Ambulance Assistant',     color: '#6366f1', bgAlpha: 'rgba(99, 102, 241, 0.1)' },
  AEA: { label: 'Ambulance Emergency Assistant', color: '#088395', bgAlpha: 'rgba(8, 131, 149, 0.1)' },
  ECT: { label: 'Emergency Care Technician',     color: '#0891b2', bgAlpha: 'rgba(8, 145, 178, 0.1)' },
  ECA: { label: 'Emergency Care Assistant',      color: '#059669', bgAlpha: 'rgba(5, 150, 105, 0.1)' },
  ANT: { label: 'Critical Care Assistant',       color: '#d97706', bgAlpha: 'rgba(217, 119, 6, 0.1)' },
  ECP: { label: 'Emergency Care Practitioner',   color: '#dc2626', bgAlpha: 'rgba(220, 38, 38, 0.1)' },
};

// ── Mock crew data ──────────────────────────────────────────────────────────
interface MockCrew {
  id: string;
  full_name: string;
  initials: string;
  qualification: string;
  hpcsa_number: string;
  phone: string;
  email: string;
  is_active: boolean;
  on_shift: boolean;
  prfs_this_month: number;
  hours_this_week: number;
}

const MOCK_CREW: MockCrew[] = [
  {
    id: '1', full_name: 'A. Ishwar', initials: 'AI', qualification: 'AEA',
    hpcsa_number: '0049530', phone: '082 345 6789', email: 'a.ishwar@jems.co.za',
    is_active: true, on_shift: true, prfs_this_month: 38, hours_this_week: 42,
  },
  {
    id: '2', full_name: 'T. Naidoo', initials: 'TN', qualification: 'ECT',
    hpcsa_number: '0051234', phone: '083 456 7890', email: 't.naidoo@jems.co.za',
    is_active: true, on_shift: true, prfs_this_month: 31, hours_this_week: 36,
  },
  {
    id: '3', full_name: 'S. van der Merwe', initials: 'SV', qualification: 'BAA',
    hpcsa_number: '0048765', phone: '084 567 8901', email: 's.vdmerwe@jems.co.za',
    is_active: true, on_shift: false, prfs_this_month: 22, hours_this_week: 0,
  },
  {
    id: '4', full_name: 'M. Pillay', initials: 'MP', qualification: 'ECP',
    hpcsa_number: '0052100', phone: '072 678 9012', email: 'm.pillay@jems.co.za',
    is_active: true, on_shift: true, prfs_this_month: 45, hours_this_week: 48,
  },
  {
    id: '5', full_name: 'J. Botha', initials: 'JB', qualification: 'AEA',
    hpcsa_number: '0047890', phone: '061 789 0123', email: 'j.botha@jems.co.za',
    is_active: true, on_shift: false, prfs_this_month: 19, hours_this_week: 0,
  },
  {
    id: '6', full_name: 'R. Mahlangu', initials: 'RM', qualification: 'ANT',
    hpcsa_number: '0053456', phone: '073 890 1234', email: 'r.mahlangu@jems.co.za',
    is_active: true, on_shift: true, prfs_this_month: 41, hours_this_week: 44,
  },
];

// ── Summary stat ────────────────────────────────────────────────────────────
function SummaryStat({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div style={{
      textAlign: 'center', padding: '14px 20px',
      background: 'var(--gradient-card)', border: '1px solid var(--glass-border)',
      borderRadius: 'var(--radius-md)', minWidth: 120,
    }}>
      <div style={{
        fontSize: '1.6rem', fontWeight: 800, color: accent,
        lineHeight: 1, fontVariantNumeric: 'tabular-nums',
      }}>
        {value}
      </div>
      <div style={{
        fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-muted)',
        textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 4,
      }}>
        {label}
      </div>
    </div>
  );
}

// ── Main view ───────────────────────────────────────────────────────────────
export default function EmployeesView() {
  const totalCrew = MOCK_CREW.length;
  const onShift = MOCK_CREW.filter(c => c.on_shift).length;
  const offDuty = MOCK_CREW.filter(c => !c.on_shift).length;
  const totalPrfs = MOCK_CREW.reduce((sum, c) => sum + c.prfs_this_month, 0);

  return (
    <div style={{
      padding: '28px 36px 48px', maxWidth: 1320,
      margin: '0 auto', fontFamily: 'var(--font-sans)',
    }}>
      <style>{`
        @keyframes emp-fade-in {
          from { opacity: 0; transform: translateY(12px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .emp-in { animation: emp-fade-in 0.45s ease-out both; }
        .emp-card {
          position: relative;
          background: var(--gradient-card);
          border: 1px solid var(--glass-border);
          border-radius: var(--radius-lg);
          padding: 28px 24px;
          transition: all 250ms cubic-bezier(0.4, 0, 0.2, 1);
          display: flex;
          flex-direction: column;
          align-items: center;
          text-align: center;
        }
        .emp-card:hover {
          transform: translateY(-4px);
          box-shadow: 0 16px 40px -12px rgba(8, 131, 149, 0.16);
          border-color: rgba(8, 131, 149, 0.2);
        }
      `}</style>

      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="emp-in" style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h1 style={{
              fontSize: '1.7rem', fontWeight: 800, color: 'var(--text-primary)',
              margin: 0, letterSpacing: '-0.025em',
            }}>
              Crew Members 👤
            </h1>
            <p style={{
              fontSize: '0.85rem', color: 'var(--text-muted)',
              margin: '4px 0 0', lineHeight: 1.5,
            }}>
              Field EMS personnel — qualifications, shift status, and performance.
            </p>
          </div>
          <a
            href="/employees"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 8,
              padding: '10px 20px', borderRadius: 'var(--radius-md)',
              background: 'var(--surface-100)', border: '1px solid var(--glass-border)',
              color: 'var(--text-secondary)', fontSize: '0.82rem', fontWeight: 600,
              textDecoration: 'none', transition: 'all 150ms',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
            Manage Accounts
          </a>
        </div>
      </div>

      {/* ── Summary Stats ──────────────────────────────────────── */}
      <div className="emp-in" style={{
        display: 'flex', gap: 12, marginBottom: 28, flexWrap: 'wrap',
      }}>
        <SummaryStat label="Total Crew" value={totalCrew} accent="var(--brand-teal)" />
        <SummaryStat label="On Shift" value={onShift} accent="var(--brand-green)" />
        <SummaryStat label="Off Duty" value={offDuty} accent="var(--brand-orange)" />
        <SummaryStat label="PRFs this month" value={totalPrfs} accent="var(--brand-teal)" />
      </div>

      {/* ── Crew Card Grid ─────────────────────────────────────── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
        gap: 20,
      }}>
        {MOCK_CREW.map((member, i) => {
          const qMeta = QUAL_META[member.qualification] || {
            label: member.qualification, color: '#888', bgAlpha: 'rgba(136,136,136,0.1)',
          };

          return (
            <div
              key={member.id}
              className="emp-card emp-in"
              style={{ animationDelay: `${i * 0.06}s` }}
            >
              {/* Shift status accent bar */}
              <div style={{
                position: 'absolute', top: 0, left: 0, right: 0, height: 3,
                borderRadius: 'var(--radius-lg) var(--radius-lg) 0 0',
                background: member.on_shift
                  ? 'linear-gradient(90deg, #088395, #388E3C)'
                  : 'var(--surface-200)',
              }} />

              {/* Large profile icon */}
              <div style={{ marginBottom: 14 }}>
                <EmployeeLargeIcon
                  size={100}
                  initials={member.initials}
                  onShift={member.on_shift}
                />
              </div>

              {/* Name */}
              <h3 style={{
                fontSize: '1.05rem', fontWeight: 700, color: 'var(--text-primary)',
                margin: '0 0 6px', letterSpacing: '-0.01em',
              }}>
                {member.full_name}
              </h3>

              {/* Qualification badge */}
              <div style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '4px 12px', borderRadius: 'var(--radius-full)',
                background: qMeta.bgAlpha, border: `1px solid ${qMeta.color}20`,
                marginBottom: 6,
              }}>
                <span style={{
                  fontSize: '0.72rem', fontWeight: 800, color: qMeta.color,
                  letterSpacing: '0.04em',
                }}>
                  {member.qualification}
                </span>
                <span style={{
                  fontSize: '0.65rem', color: 'var(--text-muted)',
                  fontWeight: 500,
                }}>
                  {qMeta.label}
                </span>
              </div>

              {/* Shift status */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6,
                marginBottom: 12,
              }}>
                <div style={{
                  width: 7, height: 7, borderRadius: '50%',
                  background: member.on_shift ? '#388E3C' : '#a8afc2',
                  boxShadow: member.on_shift ? '0 0 6px rgba(56, 142, 60, 0.5)' : 'none',
                }} />
                <span style={{
                  fontSize: '0.74rem', fontWeight: 600,
                  color: member.on_shift ? '#388E3C' : 'var(--text-muted)',
                }}>
                  {member.on_shift ? 'On Shift' : 'Off Duty'}
                </span>
              </div>

              {/* Divider */}
              <div style={{
                width: '80%', height: 1,
                background: 'var(--glass-border)', marginBottom: 12,
              }} />

              {/* Details */}
              <div style={{
                width: '100%', display: 'flex', flexDirection: 'column', gap: 6,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center' }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  </svg>
                  <span style={{ fontSize: '0.76rem', color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
                    HPCSA: {member.hpcsa_number}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center' }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round">
                    <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6A19.79 19.79 0 012.12 4.11 2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z" />
                  </svg>
                  <span style={{ fontSize: '0.76rem', color: 'var(--text-secondary)' }}>
                    {member.phone}
                  </span>
                </div>
              </div>

              {/* Stats row */}
              <div style={{
                display: 'flex', gap: 12, marginTop: 14,
                padding: '10px 14px', borderRadius: 'var(--radius-sm)',
                background: 'var(--surface-50)', width: '100%',
                justifyContent: 'center',
              }}>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: '1rem', fontWeight: 800, color: 'var(--brand-teal)' }}>
                    {member.prfs_this_month}
                  </div>
                  <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase' }}>
                    PRFs / mo
                  </div>
                </div>
                <div style={{ width: 1, background: 'var(--glass-border)' }} />
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: '1rem', fontWeight: 800, color: 'var(--brand-green)' }}>
                    {member.hours_this_week}h
                  </div>
                  <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase' }}>
                    Hrs / wk
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
