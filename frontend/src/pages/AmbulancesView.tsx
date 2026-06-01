/**
 * AmbulancesView — Grid of ambulance cards with realistic illustrations,
 * callsign + registration, in_use status indicator, and summary stats.
 *
 * Mock data modelled on the backend Vehicle schema:
 *   callsign, registration, vehicle_type, is_active, in_use (computed)
 */
import { AmbulanceLargeIcon } from '../components/AnimatedIcons';

// ── HPCSA category metadata (raw codes as requested) ────────────────────────
const QUAL_META: Record<string, { label: string; color: string }> = {
  BAA: { label: 'Basic Ambulance Assistant', color: '#6366f1' },
  AEA: { label: 'Ambulance Emergency Assistant', color: '#088395' },
  ECT: { label: 'Emergency Care Technician', color: '#0891b2' },
  ECA: { label: 'Emergency Care Assistant', color: '#059669' },
  ANT: { label: 'Critical Care Assistant', color: '#d97706' },
  ECP: { label: 'Emergency Care Practitioner', color: '#dc2626' },
};

// ── Mock ambulance data ─────────────────────────────────────────────────────
interface MockAmbulance {
  id: string;
  callsign: string;
  registration: string;
  vehicle_type: string;
  is_active: boolean;
  in_use: boolean;
  crew: { name: string; qualification: string }[];
  km_today: number;
  last_service: string;
  prfs_today: number;
}

const MOCK_AMBULANCES: MockAmbulance[] = [
  {
    id: '1',
    callsign: 'JEMS 1',
    registration: 'CA 456-789',
    vehicle_type: 'Ambulance',
    is_active: true,
    in_use: true,
    crew: [
      { name: 'A. Ishwar', qualification: 'AEA' },
      { name: 'T. Naidoo', qualification: 'ECT' },
    ],
    km_today: 142,
    last_service: '2026-04-15',
    prfs_today: 4,
  },
  {
    id: '2',
    callsign: 'JEMS 2',
    registration: 'CA 123-456',
    vehicle_type: 'Ambulance',
    is_active: true,
    in_use: false,
    crew: [],
    km_today: 0,
    last_service: '2026-05-02',
    prfs_today: 0,
  },
];

// ── Mini stat pill ──────────────────────────────────────────────────────────
function MiniStat({ label, value, accent }: { label: string; value: string | number; accent: string }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '4px 10px', borderRadius: 'var(--radius-full)',
      background: `${accent}10`, fontSize: '0.72rem', fontWeight: 600,
    }}>
      <span style={{ color: accent }}>{value}</span>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
    </div>
  );
}

// ── Summary stat card ───────────────────────────────────────────────────────
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

// ── License plate tag ───────────────────────────────────────────────────────
function LicensePlate({ registration }: { registration: string }) {
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '5px 14px', borderRadius: 'var(--radius-sm)',
      background: '#fef9c3', border: '2px solid #ca8a04',
      fontFamily: "'Inter', monospace", fontSize: '0.82rem',
      fontWeight: 800, color: '#1a1d2e', letterSpacing: '0.12em',
      textTransform: 'uppercase',
    }}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#ca8a04" strokeWidth="2.5">
        <rect x="1" y="5" width="22" height="14" rx="2" />
      </svg>
      {registration}
    </div>
  );
}

// ── Main view ───────────────────────────────────────────────────────────────
export default function AmbulancesView() {
  const totalVehicles = MOCK_AMBULANCES.length;
  const inService = MOCK_AMBULANCES.filter(a => a.in_use).length;
  const available = MOCK_AMBULANCES.filter(a => !a.in_use && a.is_active).length;

  return (
    <div style={{
      padding: '28px 36px 48px', maxWidth: 1320,
      margin: '0 auto', fontFamily: 'var(--font-sans)',
    }}>
      <style>{`
        @keyframes amb-fade-in {
          from { opacity: 0; transform: translateY(12px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .amb-in { animation: amb-fade-in 0.45s ease-out forwards; }
        .amb-in:nth-child(2) { animation-delay: 0.08s; }
        .amb-card {
          position: relative;
          background: var(--gradient-card);
          border: 1px solid var(--glass-border);
          border-radius: var(--radius-lg);
          padding: 28px;
          transition: all 250ms cubic-bezier(0.4, 0, 0.2, 1);
          overflow: hidden;
          cursor: default;
        }
        .amb-card:hover {
          transform: translateY(-4px);
          box-shadow: 0 16px 40px -12px rgba(8, 131, 149, 0.18);
          border-color: rgba(8, 131, 149, 0.25);
        }
        .amb-card::before {
          content: '';
          position: absolute;
          top: 0; left: 0; right: 0;
          height: 3px;
          border-radius: var(--radius-lg) var(--radius-lg) 0 0;
        }
        .amb-card.in-use::before {
          background: linear-gradient(90deg, #088395, #388E3C);
        }
        .amb-card.available::before {
          background: var(--surface-300);
        }
      `}</style>

      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="amb-in" style={{ marginBottom: 24 }}>
        <h1 style={{
          fontSize: '1.7rem', fontWeight: 800, color: 'var(--text-primary)',
          margin: 0, letterSpacing: '-0.025em',
        }}>
          Fleet Management 🚑
        </h1>
        <p style={{
          fontSize: '0.85rem', color: 'var(--text-muted)',
          margin: '4px 0 0', lineHeight: 1.5,
        }}>
          Monitor ambulance status, crew assignments, and vehicle statistics.
        </p>
      </div>

      {/* ── Summary Stats ──────────────────────────────────────── */}
      <div className="amb-in" style={{
        display: 'flex', gap: 12, marginBottom: 28, flexWrap: 'wrap',
      }}>
        <SummaryStat label="Total Vehicles" value={totalVehicles} accent="var(--brand-teal)" />
        <SummaryStat label="In Service" value={inService} accent="var(--brand-green)" />
        <SummaryStat label="Available" value={available} accent="var(--brand-orange)" />
      </div>

      {/* ── Ambulance Cards Grid ───────────────────────────────── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
        gap: 24,
      }}>
        {MOCK_AMBULANCES.map(amb => (
          <div
            key={amb.id}
            className={`amb-card amb-in ${amb.in_use ? 'in-use' : 'available'}`}
          >
            {/* In-use indicator — corner badge */}
            <div style={{
              position: 'absolute', top: 14, right: 14,
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '4px 12px', borderRadius: 'var(--radius-full)',
              background: amb.in_use ? 'rgba(56, 142, 60, 0.1)' : 'rgba(136, 144, 164, 0.08)',
              border: `1px solid ${amb.in_use ? 'rgba(56, 142, 60, 0.2)' : 'var(--glass-border)'}`,
            }}>
              <div style={{
                width: 8, height: 8, borderRadius: '50%',
                background: amb.in_use ? '#388E3C' : '#a8afc2',
                boxShadow: amb.in_use ? '0 0 8px rgba(56, 142, 60, 0.5)' : 'none',
                animation: amb.in_use ? 'status-pulse 2s ease-in-out infinite' : 'none',
              }} />
              <span style={{
                fontSize: '0.72rem', fontWeight: 700,
                color: amb.in_use ? '#388E3C' : 'var(--text-muted)',
                textTransform: 'uppercase', letterSpacing: '0.05em',
              }}>
                {amb.in_use ? 'In Use' : 'Available'}
              </span>
            </div>

            {/* Large ambulance illustration */}
            <div style={{
              display: 'flex', justifyContent: 'center', padding: '12px 0 18px',
            }}>
              <AmbulanceLargeIcon width={180} inUse={amb.in_use} />
            </div>

            {/* Callsign + Name */}
            <div style={{ textAlign: 'center', marginBottom: 12 }}>
              <h3 style={{
                fontSize: '1.2rem', fontWeight: 800, color: 'var(--text-primary)',
                margin: '0 0 4px', letterSpacing: '-0.01em',
              }}>
                {amb.callsign}
              </h3>
              <div style={{ marginBottom: 10 }}>
                <LicensePlate registration={amb.registration} />
              </div>
              <span style={{
                display: 'inline-block', padding: '2px 10px',
                borderRadius: 'var(--radius-full)', fontSize: '0.68rem',
                fontWeight: 600, background: 'rgba(8, 131, 149, 0.08)',
                color: 'var(--brand-teal)', textTransform: 'uppercase',
                letterSpacing: '0.06em',
              }}>
                {amb.vehicle_type}
              </span>
            </div>

            {/* Divider */}
            <div style={{
              height: 1, background: 'var(--glass-border)',
              margin: '14px 0',
            }} />

            {/* Crew currently assigned */}
            {amb.crew.length > 0 ? (
              <div style={{ marginBottom: 14 }}>
                <div style={{
                  fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-muted)',
                  textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8,
                }}>
                  Crew on board
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {amb.crew.map(c => {
                    const qMeta = QUAL_META[c.qualification] || { label: c.qualification, color: '#888' };
                    return (
                      <div key={c.name} style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '6px 10px', borderRadius: 'var(--radius-sm)',
                        background: 'var(--surface-50)',
                      }}>
                        <div style={{
                          width: 26, height: 26, borderRadius: '50%',
                          background: `${qMeta.color}15`, color: qMeta.color,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: '0.6rem', fontWeight: 800,
                        }}>
                          {c.name.split(' ').map(n => n[0]).join('')}
                        </div>
                        <span style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-primary)', flex: 1 }}>
                          {c.name}
                        </span>
                        <span style={{
                          padding: '2px 8px', borderRadius: 'var(--radius-full)',
                          fontSize: '0.65rem', fontWeight: 700,
                          background: `${qMeta.color}12`, color: qMeta.color,
                        }}>
                          {c.qualification}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div style={{
                padding: '14px', textAlign: 'center', borderRadius: 'var(--radius-sm)',
                background: 'var(--surface-50)', marginBottom: 14,
              }}>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                  No crew assigned — vehicle available
                </span>
              </div>
            )}

            {/* Quick stats */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
              <MiniStat label="km today" value={amb.km_today} accent="var(--brand-teal)" />
              <MiniStat label="PRFs today" value={amb.prfs_today} accent="var(--brand-green)" />
              <MiniStat
                label="last service"
                value={new Date(amb.last_service).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' })}
                accent="var(--brand-orange)"
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
