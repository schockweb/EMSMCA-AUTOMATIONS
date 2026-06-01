/**
 * ProviderAdminDashboard — Minimal admin panel.
 * Dense tables, modal-driven forms. No gradients, no soft shadows.
 */
import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { HPCSA_CATEGORIES, CATEGORY_META, type HpcsaCategory } from '../../data/hpcsaScope';

// ── Tokens ───────────────────────────────────────────────────────
const INK = '#0a0a0a';
const MUT = '#6b7280';
const LN  = '#e5e7eb';
const LN2 = '#d1d5db';
const BG  = '#fafafa';
const G   = '#10b981';
const GD  = '#059669';
const RED = '#dc2626';

function getApi() {
  return axios.create({ headers: { Authorization: `Bearer ${localStorage.getItem('crew_token')}` } });
}

type Tab = 'employees' | 'vehicles';

interface Employee {
  id: string;
  full_name: string;
  initials: string | null;
  email: string;
  hpcsa_number: string | null;
  qualification: string;
  phone: string | null;
  is_active: boolean;
  last_login: string | null;
}

interface Vehicle {
  id: string;
  callsign: string;
  registration: string;
  vehicle_type: string;
  is_active: boolean;
  /** True when a crew member currently has an in-progress DRAFT PRF
   *  bound to this vehicle. Drives the dashboard's In Use / Available
   *  status pill — `is_active` only reflects admin enable/disable. */
  in_use?: boolean;
}

// Badge colour keyed by HPCSA registration tier — keeps the visual hierarchy
// (ALS = purple, ILS = green, BLS = teal) regardless of which specific HPCSA
// category a crew member holds. Unknown/legacy values fall through to MUT.
const TIER_COLOR: Record<string, string> = {
  ALS: '#7c3aed', ILS: G, BLS: '#0891b2', ECT: '#0ea5e9', ECA: '#0ea5e9',
};
const qualColour = (q: string): string => {
  const meta = CATEGORY_META[q as HpcsaCategory];
  return TIER_COLOR[meta?.tier ?? q] || MUT;
};

// Dropdown options for the create / edit crew modals. Sourced from the HPCSA
// scope module so adding a category there flows through automatically.
const HPCSA_QUAL_OPTIONS = HPCSA_CATEGORIES.map(code => ({
  value: code,
  label: `${code} — ${CATEGORY_META[code].label}`,
}));

const blankEmp = () => ({ full_name: '', initials: '', hpcsa_number: '', qualification: 'AEA', phone: '' });
const blankVeh = () => ({ callsign: '', registration: '', vehicle_type: 'Ambulance' });

// ── Field primitives ────────────────────────────────────────────
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px', fontSize: '0.88rem',
  border: `1px solid ${LN2}`, background: '#fff', color: INK,
  outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit',
  borderRadius: 4,
};
const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: '0.64rem', fontWeight: 700, color: INK,
  textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 5,
};
const onFc = (e: React.FocusEvent<any>) => { e.currentTarget.style.borderColor = G; };
const onBl = (e: React.FocusEvent<any>) => { e.currentTarget.style.borderColor = LN2; };

function Field({ label, value, onChange, placeholder, type = 'text', required, mono }: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; type?: string; required?: boolean; mono?: boolean;
}) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={labelStyle}>{label}{required && <span style={{ color: RED, marginLeft: 3 }}>*</span>}</label>
      <input autoComplete="off" type={type} value={value}
        onChange={e => onChange(e.target.value)} placeholder={placeholder}
        onFocus={onFc} onBlur={onBl}
        style={{ ...inputStyle, fontFamily: mono ? 'ui-monospace, SFMono-Regular, monospace' : 'inherit' }} />
    </div>
  );
}

function SelectField({ label, value, onChange, options }: {
  label: string; value: string; onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={labelStyle}>{label}</label>
      <select value={value} onChange={e => onChange(e.target.value)} onFocus={onFc} onBlur={onBl}
        style={{ ...inputStyle, appearance: 'menulist' }}>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

// ── Modal ────────────────────────────────────────────────────────
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 100,
      background: 'rgba(10,10,10,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 16,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: '#fff', border: `1px solid ${LN2}`, borderRadius: 6,
        width: '100%', maxWidth: 560, maxHeight: '90vh', overflowY: 'auto',
        boxShadow: '0 8px 32px rgba(0,0,0,0.12)',
      }}>
        <div style={{
          padding: '13px 18px', borderBottom: `1px solid ${LN}`,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <div style={{ fontSize: '0.78rem', fontWeight: 800, color: INK, textTransform: 'uppercase', letterSpacing: '0.1em' }}>
            {title}
          </div>
          <button onClick={onClose} aria-label="Close" style={{
            width: 26, height: 26, border: `1px solid ${LN2}`, background: '#fff',
            color: INK, cursor: 'pointer', fontSize: '0.95rem', lineHeight: 1,
            borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 0,
          }}>×</button>
        </div>
        <div style={{ padding: 20 }}>{children}</div>
      </div>
    </div>
  );
}

function Alert({ type, text }: { type: 'error' | 'success'; text: string }) {
  const isErr = type === 'error';
  return (
    <div style={{
      padding: '9px 12px', marginBottom: 14, fontSize: '0.82rem', fontWeight: 600,
      border: `1px solid ${isErr ? RED : G}`, color: isErr ? RED : GD,
      background: isErr ? '#fef2f2' : '#f0fdf4', borderRadius: 4,
    }}>
      {text}
    </div>
  );
}

// ── Generic button ──────────────────────────────────────────────
function Btn({ onClick, children, kind = 'secondary', type = 'button', disabled, style }: {
  onClick?: () => void;
  children: React.ReactNode;
  kind?: 'primary' | 'secondary' | 'danger';
  type?: 'button' | 'submit';
  disabled?: boolean;
  style?: React.CSSProperties;
}) {
  const base: React.CSSProperties = {
    padding: '8px 14px', fontSize: '0.76rem',
    fontWeight: 700, cursor: disabled ? 'wait' : 'pointer', borderRadius: 4,
    whiteSpace: 'nowrap', transition: 'background 0.12s',
    fontFamily: 'inherit',
  };
  const kinds: Record<string, React.CSSProperties> = {
    primary:   { background: G, color: '#fff', border: `1px solid ${GD}` },
    secondary: { background: '#fff', color: INK, border: `1px solid ${LN2}` },
    danger:    { background: '#fff', color: RED, border: `1px solid #fecaca` },
  };
  return (
    <button type={type} onClick={onClick} disabled={disabled} style={{ ...base, ...kinds[kind], ...style }}>
      {children}
    </button>
  );
}

// Hook: re-renders when the viewport crosses the mobile breakpoint, so
// layout decisions (sidebar vs top-tabs, table vs cards, etc.) react to
// orientation changes without a manual reload.
function useIsMobile(breakpoint = 720) {
  const [isMobile, setIsMobile] = useState(
    typeof window !== 'undefined' ? window.innerWidth < breakpoint : false,
  );
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < breakpoint);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [breakpoint]);
  return isMobile;
}

export default function ProviderAdminDashboard() {
  const { providerSlug } = useParams<{ providerSlug: string }>();
  const navigate = useNavigate();
  const isMobile = useIsMobile();

  const profile    = JSON.parse(localStorage.getItem('crew_profile') || '{}');
  const providerId = profile.provider_id || null;

  const [activeTab, setActiveTab] = useState<Tab>('employees');

  // data
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [vehicles,  setVehicles]  = useState<Vehicle[]>([]);
  const [loading,   setLoading]   = useState(false);

  // modals
  const [addEmpOpen, setAddEmpOpen] = useState(false);
  const [editEmpId,  setEditEmpId]  = useState<string | null>(null);
  const [addVehOpen, setAddVehOpen] = useState(false);

  // add employee
  const [newEmp,    setNewEmp]    = useState(blankEmp());
  const [newEmpErr, setNewEmpErr] = useState('');
  const [newEmpSav, setNewEmpSav] = useState(false);

  // edit employee
  const [editEmp,    setEditEmp]    = useState(blankEmp());
  const [editEmpErr, setEditEmpErr] = useState('');
  const [editEmpSav, setEditEmpSav] = useState(false);

  // add vehicle
  const [newVeh,    setNewVeh]    = useState(blankVeh());
  const [newVehErr, setNewVehErr] = useState('');
  const [newVehSav, setNewVehSav] = useState(false);

  // auth guard
  useEffect(() => {
    if (!localStorage.getItem('crew_token')) navigate(`/${providerSlug}/login`);
  }, []);

  const fetchEmployees = useCallback(async () => {
    if (!providerId) return;
    setLoading(true);
    try { const { data } = await getApi().get(`/api/providers/${providerId}/crew`); setEmployees(data); }
    catch { /* ignore */ }
    setLoading(false);
  }, [providerId]);

  const fetchVehicles = useCallback(async () => {
    if (!providerId) return;
    setLoading(true);
    try { const { data } = await getApi().get(`/api/providers/${providerId}/vehicles`); setVehicles(data); }
    catch { /* ignore */ }
    setLoading(false);
  }, [providerId]);

  useEffect(() => {
    if (activeTab === 'employees') fetchEmployees(); else fetchVehicles();
  }, [activeTab]);

  // ── Actions ─────────────────────────────────────────────────────
  const submitNewEmp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!providerId) { setNewEmpErr('Session invalid.'); return; }
    if (!newEmp.hpcsa_number.trim()) { setNewEmpErr('HPCSA number is required.'); return; }
    setNewEmpSav(true); setNewEmpErr('');
    try {
      await getApi().post(`/api/providers/${providerId}/crew`, {
        full_name:    newEmp.full_name.trim(),
        initials:     newEmp.initials.trim() || null,
        email:        `${newEmp.hpcsa_number.trim().toLowerCase()}@noemail.local`,
        hpcsa_number: newEmp.hpcsa_number.trim().toUpperCase(),
        qualification: newEmp.qualification,
        phone:        newEmp.phone.trim() || null,
      });
      setNewEmp(blankEmp());
      setAddEmpOpen(false);
      fetchEmployees();
    } catch (err: any) {
      setNewEmpErr(err.response?.data?.detail || 'Failed to register crew member.');
    }
    setNewEmpSav(false);
  };

  const openEditEmp = (e: Employee) => {
    setEditEmpId(e.id);
    setEditEmp({
      full_name:    e.full_name,
      initials:     e.initials || '',
      hpcsa_number: e.hpcsa_number || '',
      qualification: e.qualification,
      phone:        e.phone || '',
    });
    setEditEmpErr('');
  };

  const submitEditEmp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editEmpId || !providerId) return;
    setEditEmpSav(true); setEditEmpErr('');
    try {
      await getApi().patch(`/api/providers/${providerId}/crew/${editEmpId}`, {
        full_name:    editEmp.full_name.trim(),
        initials:     editEmp.initials.trim() || null,
        hpcsa_number: editEmp.hpcsa_number.trim().toUpperCase() || null,
        qualification: editEmp.qualification,
        phone:        editEmp.phone.trim() || null,
      });
      setEditEmpId(null);
      fetchEmployees();
    } catch (err: any) {
      setEditEmpErr(err.response?.data?.detail || 'Failed to update.');
    }
    setEditEmpSav(false);
  };

  const deleteEmployee = async (id: string, name: string) => {
    if (!providerId) return;
    if (!window.confirm(`Permanently delete ${name}?`)) return;
    try {
      await getApi().delete(`/api/providers/${providerId}/crew/${id}`);
      fetchEmployees();
    } catch (err: any) {
      alert(err.response?.data?.detail || 'Failed to delete.');
    }
  };

  const submitNewVeh = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!providerId) { setNewVehErr('Session invalid.'); return; }
    setNewVehSav(true); setNewVehErr('');
    try {
      await getApi().post(`/api/providers/${providerId}/vehicles`, {
        callsign: newVeh.callsign.trim(),
        registration: newVeh.registration.trim(),
        vehicle_type: newVeh.vehicle_type,
      });
      setNewVeh(blankVeh());
      setAddVehOpen(false);
      fetchVehicles();
    } catch (err: any) {
      setNewVehErr(err.response?.data?.detail || 'Failed to add vehicle.');
    }
    setNewVehSav(false);
  };

  const deleteVehicle = async (id: string, callsign: string) => {
    if (!providerId) return;
    if (!window.confirm(`Permanently delete vehicle ${callsign}?`)) return;
    try {
      await getApi().delete(`/api/providers/${providerId}/vehicles/${id}`);
      fetchVehicles();
    } catch (err: any) {
      alert(err.response?.data?.detail || 'Failed to delete vehicle.');
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('crew_token'); localStorage.removeItem('crew_profile');
    navigate(`/${providerSlug}/login`);
  };

  // ── Nav ────────────────────────────────────────────────────────
  const SideBtn = ({ tab, label, count }: { tab: Tab; label: string; count: number }) => {
    const active = activeTab === tab;
    return (
      <button onClick={() => setActiveTab(tab)} style={{
        display: 'flex', alignItems: 'center',
        justifyContent: isMobile ? 'center' : 'space-between',
        gap: isMobile ? 8 : 0,
        padding: '10px 14px', border: 'none', cursor: 'pointer',
        textAlign: isMobile ? 'center' : 'left',
        width: isMobile ? 'auto' : '100%',
        flex: isMobile ? '1 1 auto' : undefined,
        background: active ? G : 'transparent',
        color: active ? '#fff' : INK,
        fontSize: '0.82rem', fontWeight: 700,
        borderRadius: 4, fontFamily: 'inherit',
        whiteSpace: 'nowrap',
      }}>
        <span>{label}</span>
        <span style={{
          fontSize: '0.7rem', fontWeight: 700, fontFamily: 'ui-monospace, monospace',
          color: active ? 'rgba(255,255,255,0.65)' : MUT,
        }}>{count}</span>
      </button>
    );
  };

  const thStyle: React.CSSProperties = {
    padding: '9px 14px', textAlign: 'left', fontSize: '0.62rem',
    fontWeight: 800, color: MUT, textTransform: 'uppercase',
    letterSpacing: '0.12em', whiteSpace: 'nowrap', background: '#fafafa',
    borderBottom: `1px solid ${LN}`,
  };
  const tdStyle: React.CSSProperties = {
    padding: '11px 14px', fontSize: '0.82rem', color: INK, verticalAlign: 'middle',
  };

  // ── Render ─────────────────────────────────────────────────────
  return (
    <div style={{
      minHeight: '100vh', background: BG, color: INK,
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      display: 'flex', flexDirection: 'column',
    }}>

      {/* Header — on mobile we drop the user name/role line so just the
          logo and Logout button fit on a single phone-width row. */}
      <header style={{
        padding: isMobile ? '10px 14px' : '11px 22px',
        background: '#fff', borderBottom: `1px solid ${LN}`,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexShrink: 0, gap: 10,
      }}>
        {providerSlug?.toLowerCase() === 'jems' ? (
          <img src="/jems_logo.png" alt="JEMS Medical Services" style={{ height: 28, width: 'auto' }} />
        ) : (
          <div style={{ fontWeight: 800, fontSize: '0.9rem', color: INK }}>{profile.provider_name}</div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          {!isMobile && (
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: '0.78rem', fontWeight: 700, color: INK }}>{profile.name}</div>
              <div style={{ fontSize: '0.6rem', color: MUT, textTransform: 'uppercase', letterSpacing: '0.1em' }}>Admin</div>
            </div>
          )}
          <Btn kind="secondary" onClick={handleLogout}>Logout</Btn>
        </div>
      </header>

      {/* Body — column layout on mobile so the sidebar becomes a horizontal
          tab strip above the main content. The desktop side-by-side layout
          collapses on phones because a 200px sidebar leaves only ~150px for
          the table on a 360px screen. */}
      <div style={{
        display: 'flex',
        flex: 1,
        overflow: 'hidden',
        flexDirection: isMobile ? 'column' : 'row',
      }}>

        {/* Sidebar / top tabs */}
        <aside style={{
          ...(isMobile
            ? {
              width: '100%', flexShrink: 0, background: '#fff',
              borderBottom: `1px solid ${LN}`, padding: '8px 10px',
              display: 'flex', flexDirection: 'row', gap: 6,
              overflowX: 'auto',
            }
            : {
              width: 200, flexShrink: 0, background: '#fff',
              borderRight: `1px solid ${LN}`, padding: '18px 10px',
              display: 'flex', flexDirection: 'column', gap: 2,
            }),
        }}>
          {!isMobile && (
            <div style={{
              fontSize: '0.58rem', fontWeight: 800, color: MUT,
              textTransform: 'uppercase', letterSpacing: '0.16em',
              padding: '0 10px 10px', marginBottom: 2,
            }}>Registry</div>
          )}
          <SideBtn tab="employees" label="Employees" count={employees.length} />
          <SideBtn tab="vehicles"  label="Vehicles"  count={vehicles.length}  />
        </aside>

        {/* Main */}
        <main style={{ flex: 1, overflowY: 'auto', padding: isMobile ? '14px 12px' : '24px 28px', minWidth: 0 }}>
          {/* Title bar — stacks vertically on mobile so the title and
              the Refresh / New button row each get a full screen-width line. */}
          <div style={{
            display: 'flex', alignItems: isMobile ? 'stretch' : 'flex-end',
            justifyContent: 'space-between', flexDirection: isMobile ? 'column' : 'row',
            gap: 12, marginBottom: 16,
          }}>
            <div>
              <h1 style={{
                margin: 0, fontSize: '1.05rem', fontWeight: 800, color: INK,
                textTransform: 'uppercase', letterSpacing: '0.04em',
              }}>
                {activeTab === 'employees' ? 'Crew Members' : 'Fleet'}
              </h1>
              <div style={{ fontSize: '0.7rem', color: MUT, marginTop: 3 }}>
                {activeTab === 'employees' ? `${employees.length} registered` : `${vehicles.length} registered`}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <Btn onClick={activeTab === 'employees' ? fetchEmployees : fetchVehicles}
                style={isMobile ? { flex: 1, padding: '10px 14px' } : undefined}>Refresh</Btn>
              <Btn kind="primary" onClick={() => activeTab === 'employees' ? setAddEmpOpen(true) : setAddVehOpen(true)}
                style={isMobile ? { flex: 2, padding: '10px 14px' } : undefined}>
                + New {activeTab === 'employees' ? 'Employee' : 'Vehicle'}
              </Btn>
            </div>
          </div>

          {/* List — table on desktop, stacked card list on mobile.
              Tables don't fit a phone screen; cards keep all info visible
              without horizontal scrolling. */}
          {isMobile ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {activeTab === 'employees' ? (
                loading ? (
                  <div style={{ padding: 32, textAlign: 'center', color: MUT, fontSize: '0.84rem', background: '#fff', border: `1px solid ${LN}`, borderRadius: 6 }}>Loading…</div>
                ) : employees.length === 0 ? (
                  <div style={{ padding: 32, textAlign: 'center', color: MUT, fontSize: '0.84rem', background: '#fff', border: `1px solid ${LN}`, borderRadius: 6 }}>
                    No crew members. Tap <b>New Employee</b> to register.
                  </div>
                ) : employees.map(e => (
                  <div key={e.id} style={{ background: '#fff', border: `1px solid ${LN}`, borderRadius: 6, padding: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                      <div style={{
                        width: 34, height: 34, background: G, color: '#fff',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: '0.7rem', fontWeight: 800,
                        fontFamily: 'ui-monospace, monospace', borderRadius: 4, flexShrink: 0,
                      }}>
                        {(e.initials || e.full_name.split(' ').map(n => n[0]).join('')).slice(0, 2).toUpperCase()}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 700, fontSize: '0.9rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.full_name}</div>
                        <div style={{ display: 'flex', gap: 8, marginTop: 3, flexWrap: 'wrap', alignItems: 'center' }}>
                          <span style={{
                            display: 'inline-block', padding: '1px 6px',
                            border: `1px solid ${qualColour(e.qualification) || MUT}`,
                            color: qualColour(e.qualification) || INK,
                            fontSize: '0.6rem', fontWeight: 700,
                            letterSpacing: '0.06em', borderRadius: 3,
                          }}>{e.qualification}</span>
                          {!e.is_active && <span style={{ fontSize: '0.6rem', color: RED, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Inactive</span>}
                        </div>
                      </div>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px', fontSize: '0.76rem', color: MUT, marginBottom: 10 }}>
                      <div><span style={{ fontWeight: 700, color: INK }}>HPCSA:</span> <span style={{ fontFamily: 'ui-monospace, monospace' }}>{e.hpcsa_number || '—'}</span></div>
                      <div><span style={{ fontWeight: 700, color: INK }}>Phone:</span> {e.phone || '—'}</div>
                      <div style={{ gridColumn: '1 / -1' }}><span style={{ fontWeight: 700, color: INK }}>Last login:</span> {e.last_login ? new Date(e.last_login).toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</div>
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <Btn onClick={() => openEditEmp(e)} style={{ flex: 1, padding: '8px 10px', fontSize: '0.78rem' }}>Edit</Btn>
                      <Btn kind="danger" onClick={() => deleteEmployee(e.id, e.full_name)} style={{ flex: 1, padding: '8px 10px', fontSize: '0.78rem' }}>Delete</Btn>
                    </div>
                  </div>
                ))
              ) : (
                loading ? (
                  <div style={{ padding: 32, textAlign: 'center', color: MUT, fontSize: '0.84rem', background: '#fff', border: `1px solid ${LN}`, borderRadius: 6 }}>Loading…</div>
                ) : vehicles.length === 0 ? (
                  <div style={{ padding: 32, textAlign: 'center', color: MUT, fontSize: '0.84rem', background: '#fff', border: `1px solid ${LN}`, borderRadius: 6 }}>
                    No vehicles. Tap <b>New Vehicle</b> to register your fleet.
                  </div>
                ) : vehicles.map(v => (
                  <div key={v.id} style={{ background: '#fff', border: `1px solid ${LN}`, borderRadius: 6, padding: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, gap: 8 }}>
                      <div style={{ fontWeight: 700, fontSize: '0.9rem', fontFamily: 'ui-monospace, monospace' }}>{v.callsign}</div>
                      <div style={{ fontSize: '0.7rem', fontWeight: 700, color: !v.is_active ? RED : v.in_use ? '#d97706' : GD }}>
                        ● {!v.is_active ? 'Inactive' : v.in_use ? 'In Use' : 'Available'}
                      </div>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px', fontSize: '0.76rem', color: MUT, marginBottom: 10 }}>
                      <div><span style={{ fontWeight: 700, color: INK }}>Reg:</span> <span style={{ fontFamily: 'ui-monospace, monospace' }}>{v.registration}</span></div>
                      <div><span style={{ fontWeight: 700, color: INK }}>Type:</span> {v.vehicle_type}</div>
                    </div>
                    <Btn kind="danger" onClick={() => deleteVehicle(v.id, v.callsign)} style={{ width: '100%', padding: '8px 10px', fontSize: '0.78rem' }}>Delete</Btn>
                  </div>
                ))
              )}
            </div>
          ) : (
          <div style={{ background: '#fff', border: `1px solid ${LN}`, borderRadius: 6, overflowX: 'auto' }}>
            {activeTab === 'employees' ? (
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
                <thead>
                  <tr>
                    <th style={{ ...thStyle, width: 52 }}></th>
                    <th style={thStyle}>Name</th>
                    <th style={thStyle}>HPCSA</th>
                    <th style={thStyle}>Level</th>
                    <th style={thStyle}>Phone</th>
                    <th style={thStyle}>Last Login</th>
                    <th style={{ ...thStyle, textAlign: 'right' }}></th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr><td colSpan={7} style={{ padding: 40, textAlign: 'center', color: MUT, fontSize: '0.82rem' }}>Loading…</td></tr>
                  ) : employees.length === 0 ? (
                    <tr><td colSpan={7} style={{ padding: 48, textAlign: 'center', color: MUT, fontSize: '0.82rem' }}>
                      No crew members. Click <b>New Employee</b> to register.
                    </td></tr>
                  ) : employees.map(e => (
                    <tr key={e.id} style={{ borderTop: `1px solid ${LN}` }}>
                      <td style={tdStyle}>
                        <div style={{
                          width: 30, height: 30, background: G, color: '#fff',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: '0.66rem', fontWeight: 800,
                          fontFamily: 'ui-monospace, monospace', borderRadius: 4,
                        }}>
                          {(e.initials || e.full_name.split(' ').map(n => n[0]).join('')).slice(0, 2).toUpperCase()}
                        </div>
                      </td>
                      <td style={tdStyle}>
                        <div style={{ fontWeight: 700 }}>{e.full_name}</div>
                        {!e.is_active && <div style={{ fontSize: '0.66rem', color: RED, fontWeight: 700, marginTop: 2, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Inactive</div>}
                      </td>
                      <td style={{ ...tdStyle, fontFamily: 'ui-monospace, monospace', fontSize: '0.78rem' }}>
                        {e.hpcsa_number || '—'}
                      </td>
                      <td style={tdStyle}>
                        <span style={{
                          display: 'inline-block', padding: '2px 7px',
                          border: `1px solid ${qualColour(e.qualification)}`,
                          color: qualColour(e.qualification),
                          fontSize: '0.64rem', fontWeight: 700,
                          letterSpacing: '0.06em', borderRadius: 3,
                        }}>{e.qualification}</span>
                      </td>
                      <td style={{ ...tdStyle, color: MUT, fontSize: '0.78rem' }}>{e.phone || '—'}</td>
                      <td style={{ ...tdStyle, color: MUT, fontSize: '0.78rem' }}>
                        {e.last_login ? new Date(e.last_login).toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <Btn onClick={() => openEditEmp(e)} style={{ marginRight: 6 }}>Edit</Btn>
                        <Btn kind="danger" onClick={() => deleteEmployee(e.id, e.full_name)}>Delete</Btn>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={thStyle}>Callsign</th>
                    <th style={thStyle}>Registration</th>
                    <th style={thStyle}>Type</th>
                    <th style={thStyle}>Status</th>
                    <th style={{ ...thStyle, textAlign: 'right' }}></th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr><td colSpan={5} style={{ padding: 40, textAlign: 'center', color: MUT, fontSize: '0.82rem' }}>Loading…</td></tr>
                  ) : vehicles.length === 0 ? (
                    <tr><td colSpan={5} style={{ padding: 48, textAlign: 'center', color: MUT, fontSize: '0.82rem' }}>
                      No vehicles. Click <b>New Vehicle</b> to register your fleet.
                    </td></tr>
                  ) : vehicles.map(v => (
                    <tr key={v.id} style={{ borderTop: `1px solid ${LN}` }}>
                      <td style={{ ...tdStyle, fontFamily: 'ui-monospace, monospace', fontWeight: 700, letterSpacing: '0.04em' }}>
                        {v.callsign}
                      </td>
                      <td style={{ ...tdStyle, fontFamily: 'ui-monospace, monospace', fontSize: '0.78rem' }}>
                        {v.registration}
                      </td>
                      <td style={{ ...tdStyle, color: MUT, fontSize: '0.78rem' }}>{v.vehicle_type}</td>
                      <td style={{ ...tdStyle, fontSize: '0.72rem', fontWeight: 700 }}>
                        {!v.is_active ? (
                          <span style={{ color: RED }}>● Inactive</span>
                        ) : v.in_use ? (
                          <span style={{ color: '#d97706' }}>● In Use</span>
                        ) : (
                          <span style={{ color: GD }}>● Available</span>
                        )}
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <Btn kind="danger" onClick={() => deleteVehicle(v.id, v.callsign)}>Delete</Btn>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          )}
        </main>
      </div>

      {/* Add Employee Modal */}
      {addEmpOpen && (
        <Modal title="Register New Employee" onClose={() => { setAddEmpOpen(false); setNewEmpErr(''); }}>
          {newEmpErr && <Alert type="error" text={newEmpErr} />}
          <form onSubmit={submitNewEmp}>
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '0 14px' }}>
              <Field label="Full Name" value={newEmp.full_name} onChange={v => setNewEmp(p => ({ ...p, full_name: v }))} placeholder="John Smith" required />
              <Field label="Initials" value={newEmp.initials} onChange={v => setNewEmp(p => ({ ...p, initials: v }))} placeholder="J.S." />
              <Field label="HPCSA Number" value={newEmp.hpcsa_number} onChange={v => setNewEmp(p => ({ ...p, hpcsa_number: v }))} placeholder="MT0012345" required mono />
              <Field label="Phone" value={newEmp.phone} onChange={v => setNewEmp(p => ({ ...p, phone: v }))} placeholder="082 000 0000" />
            </div>
            <SelectField
              label="HPCSA Registration"
              value={newEmp.qualification}
              onChange={v => setNewEmp(p => ({ ...p, qualification: v }))}
              options={HPCSA_QUAL_OPTIONS}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <Btn kind="secondary" onClick={() => setAddEmpOpen(false)} style={{ flex: 1, padding: '11px 14px' }}>Cancel</Btn>
              <button type="submit" disabled={newEmpSav} style={{
                flex: 2, padding: '11px 14px', background: G, color: '#fff',
                border: `1px solid ${GD}`, fontSize: '0.8rem', fontWeight: 700, borderRadius: 4,
                cursor: newEmpSav ? 'wait' : 'pointer', fontFamily: 'inherit',
              }}>
                {newEmpSav ? 'Registering…' : 'Register Employee'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Edit Employee Modal */}
      {editEmpId && (
        <Modal title="Edit Employee" onClose={() => { setEditEmpId(null); setEditEmpErr(''); }}>
          {editEmpErr && <Alert type="error" text={editEmpErr} />}
          <form onSubmit={submitEditEmp}>
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '0 14px' }}>
              <Field label="Full Name" value={editEmp.full_name} onChange={v => setEditEmp(p => ({ ...p, full_name: v }))} required />
              <Field label="Initials" value={editEmp.initials} onChange={v => setEditEmp(p => ({ ...p, initials: v }))} />
              <Field label="HPCSA Number" value={editEmp.hpcsa_number} onChange={v => setEditEmp(p => ({ ...p, hpcsa_number: v }))} mono />
              <Field label="Phone" value={editEmp.phone} onChange={v => setEditEmp(p => ({ ...p, phone: v }))} />
            </div>
            <SelectField
              label="HPCSA Registration"
              value={editEmp.qualification}
              onChange={v => setEditEmp(p => ({ ...p, qualification: v }))}
              options={HPCSA_QUAL_OPTIONS}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <Btn kind="secondary" onClick={() => setEditEmpId(null)} style={{ flex: 1, padding: '11px 14px' }}>Cancel</Btn>
              <button type="submit" disabled={editEmpSav} style={{
                flex: 2, padding: '11px 14px', background: G, color: '#fff',
                border: `1px solid ${GD}`, fontSize: '0.8rem', fontWeight: 700, borderRadius: 4,
                cursor: editEmpSav ? 'wait' : 'pointer', fontFamily: 'inherit',
              }}>
                {editEmpSav ? 'Saving…' : 'Save Changes'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Add Vehicle Modal */}
      {addVehOpen && (
        <Modal title="Register New Vehicle" onClose={() => { setAddVehOpen(false); setNewVehErr(''); }}>
          {newVehErr && <Alert type="error" text={newVehErr} />}
          <form onSubmit={submitNewVeh}>
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '0 14px' }}>
              <Field label="Callsign" value={newVeh.callsign} onChange={v => setNewVeh(p => ({ ...p, callsign: v }))} placeholder="JEMS-1" required mono />
              <Field label="Registration" value={newVeh.registration} onChange={v => setNewVeh(p => ({ ...p, registration: v }))} placeholder="GP 12-34-56" required mono />
            </div>
            <SelectField
              label="Vehicle Type" value={newVeh.vehicle_type}
              onChange={v => setNewVeh(p => ({ ...p, vehicle_type: v }))}
              options={[
                { value: 'Ambulance',         label: 'Ambulance' },
                { value: 'Rapid Response',    label: 'Rapid Response' },
                { value: 'Patient Transport', label: 'Patient Transport' },
                { value: 'Supervisor',        label: 'Supervisor' },
              ]}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <Btn kind="secondary" onClick={() => setAddVehOpen(false)} style={{ flex: 1, padding: '11px 14px' }}>Cancel</Btn>
              <button type="submit" disabled={newVehSav} style={{
                flex: 2, padding: '11px 14px', background: G, color: '#fff',
                border: `1px solid ${GD}`, fontSize: '0.8rem', fontWeight: 700, borderRadius: 4,
                cursor: newVehSav ? 'wait' : 'pointer', fontFamily: 'inherit',
              }}>
                {newVehSav ? 'Registering…' : 'Register Vehicle'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
