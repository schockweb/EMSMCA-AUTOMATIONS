/**
 * ProviderAdminDashboard — Minimal admin panel.
 * Dense tables, modal-driven forms. No gradients, no soft shadows.
 */
import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { HPCSA_CATEGORIES, CATEGORY_META, type HpcsaCategory } from '../../data/hpcsaScope';
import { HomeTabIcon, AmbulanceTabIcon, EmployeeTabIcon, AmbulanceLargeIcon, EmployeeLargeIcon } from '../../components/AnimatedIcons';

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

type Tab = 'dashboard' | 'employees' | 'vehicles';

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

const resizeImage = (file: File, callback: (base64: string) => void) => {
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const MAX_WIDTH = 240;
      const MAX_HEIGHT = 240;
      let width = img.width;
      let height = img.height;

      if (width > height) {
        if (width > MAX_WIDTH) {
          height *= MAX_WIDTH / width;
          width = MAX_WIDTH;
        }
      } else {
        if (height > MAX_HEIGHT) {
          width *= MAX_HEIGHT / height;
          height = MAX_HEIGHT;
        }
      }
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(img, 0, 0, width, height);
        callback(canvas.toDataURL('image/jpeg', 0.8));
      }
    };
    img.src = e.target?.result as string;
  };
  reader.readAsDataURL(file);
};

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

  const [activeTab, setActiveTab] = useState<Tab>('dashboard');

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

  // edit vehicle
  const [editVehId,  setEditVehId]  = useState<string | null>(null);
  const [editVeh,    setEditVeh]    = useState(blankVeh());
  const [editVehErr, setEditVehErr] = useState('');
  const [editVehSav, setEditVehSav] = useState(false);

  // temporary photos during edit
  const [tempEmpPhoto, setTempEmpPhoto] = useState<string | null>(null);
  const [tempVehPhoto, setTempVehPhoto] = useState<string | null>(null);

  // confirm delete states
  const [confirmEmpDelete, setConfirmEmpDelete] = useState(false);
  const [confirmVehDelete, setConfirmVehDelete] = useState(false);

  // search states
  const [empSearch, setEmpSearch] = useState('');
  const [vehSearch, setVehSearch] = useState('');

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
    fetchEmployees();
    fetchVehicles();
  }, [fetchEmployees, fetchVehicles]);

  useEffect(() => {
    if (activeTab === 'employees') fetchEmployees();
    else if (activeTab === 'vehicles') fetchVehicles();
  }, [activeTab, fetchEmployees, fetchVehicles]);

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
    setTempEmpPhoto(localStorage.getItem(`photo_employee_${e.id}`));
    setConfirmEmpDelete(false);
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

      // Save photo to localStorage
      if (tempEmpPhoto) {
        localStorage.setItem(`photo_employee_${editEmpId}`, tempEmpPhoto);
      } else {
        localStorage.removeItem(`photo_employee_${editEmpId}`);
      }

      setEditEmpId(null);
      fetchEmployees();
    } catch (err: any) {
      setEditEmpErr(err.response?.data?.detail || 'Failed to update.');
    }
    setEditEmpSav(false);
  };

  const deleteEmployee = async (id: string, name: string) => {
    if (!providerId) return;
    try {
      await getApi().delete(`/api/providers/${providerId}/crew/${id}`);
      localStorage.removeItem(`photo_employee_${id}`);
      setEditEmpId(null);
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

  const openEditVeh = (v: Vehicle) => {
    setEditVehId(v.id);
    setEditVeh({
      callsign: v.callsign,
      registration: v.registration,
      vehicle_type: v.vehicle_type,
    });
    setEditVehErr('');
    setTempVehPhoto(localStorage.getItem(`photo_vehicle_${v.id}`));
    setConfirmVehDelete(false);
  };

  const submitEditVeh = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!providerId || !editVehId) return;
    setEditVehSav(true); setEditVehErr('');
    try {
      await getApi().patch(`/api/providers/${providerId}/vehicles/${editVehId}`, {
        callsign: editVeh.callsign.trim(),
        registration: editVeh.registration.trim(),
        vehicle_type: editVeh.vehicle_type,
      });

      // Save photo to localStorage
      if (tempVehPhoto) {
        localStorage.setItem(`photo_vehicle_${editVehId}`, tempVehPhoto);
      } else {
        localStorage.removeItem(`photo_vehicle_${editVehId}`);
      }

      setEditVehId(null);
      fetchVehicles();
    } catch (err: any) {
      setEditVehErr(err.response?.data?.detail || 'Failed to update vehicle.');
    }
    setEditVehSav(false);
  };

  const deleteVehicle = async (id: string, callsign: string) => {
    if (!providerId) return;
    try {
      await getApi().delete(`/api/providers/${providerId}/vehicles/${id}`);
      localStorage.removeItem(`photo_vehicle_${id}`);
      setEditVehId(null);
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
        padding: isMobile ? '8px 12px' : '10px 24px',
        background: '#fff', borderBottom: `1px solid ${LN}`,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexShrink: 0, gap: isMobile ? 12 : 24,
        flexWrap: 'wrap',
      }}>
        {providerSlug?.toLowerCase() === 'jems' ? (
          <img src="/jems_logo.png" alt="JEMS Medical Services" style={{ height: isMobile ? 32 : 38, width: 'auto' }} />
        ) : (
          <div style={{ fontWeight: 800, fontSize: isMobile ? '0.95rem' : '1.1rem', color: INK }}>{profile.provider_name}</div>
        )}

        {/* ── Centered Animated Tab Bar ─────────────────────────────── */}
        <nav style={{
          display: 'flex', justifyContent: 'center', alignItems: 'center',
          gap: isMobile ? 16 : 32,
        }}>
          {([
            { key: 'dashboard' as Tab, label: 'Dashboard', Icon: HomeTabIcon, color: '#059669', bgLight: 'rgba(5, 150, 105, 0.1)' },
            { key: 'vehicles' as Tab,  label: 'Ambulances', Icon: AmbulanceTabIcon, color: '#10b981', bgLight: 'rgba(16, 185, 129, 0.1)' },
            { key: 'employees' as Tab, label: 'Employees', Icon: EmployeeTabIcon, color: '#34d399', bgLight: 'rgba(52, 211, 153, 0.1)' },
          ]).map(({ key, label, Icon, color, bgLight }) => {
            const isActive = activeTab === key;
            return (
              <button key={key} onClick={() => setActiveTab(key)} style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
                padding: 0, background: 'transparent',
                border: 'none', cursor: 'pointer', transition: 'all 0.2s ease',
                fontFamily: 'inherit',
              }}>
                <div style={{
                  width: isMobile ? 36 : 44, height: isMobile ? 36 : 44,
                  borderRadius: '50%',
                  background: isActive ? color : bgLight,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  transition: 'all 0.25s ease',
                  boxShadow: isActive ? `0 2px 10px ${color}30` : 'none',
                  border: isActive ? `2px solid ${color}` : `1px solid ${color}40`,
                }}>
                  <Icon size={isMobile ? 18 : 22} active={isActive} />
                </div>
                <span style={{
                  fontSize: isMobile ? '0.55rem' : '0.65rem', fontWeight: 800,
                  color: isActive ? color : MUT, letterSpacing: '0.03em',
                  textTransform: 'uppercase',
                }}>{label}</span>
              </button>
            );
          })}
        </nav>

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

      {/* ── Tab Content ───────────────────────────────────────────── */}
      <main style={{ flex: 1, overflowY: 'auto', padding: 0, minWidth: 0 }}>

        {/* ══════════════════ DASHBOARD TAB ══════════════════ */}
        {/* ══════════════════ DASHBOARD TAB ══════════════════ */}
        {activeTab === 'dashboard' && (() => {
          return (
            <div style={{ padding: isMobile ? '16px 12px' : '28px 36px', maxWidth: 1200, margin: '0 auto' }}>
              {/* Header */}
              <h1 style={{ fontSize: isMobile ? '1.3rem' : '1.7rem', fontWeight: 800, margin: '0 0 20px', color: INK }}>
                Dashboard Overview
              </h1>

              {/* Dynamic Analytics Counters Row */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(4, 1fr)',
                gap: isMobile ? 10 : 16, marginBottom: 28,
              }}>
                {[
                  { label: 'Total Vehicles', value: vehicles.length, accent: G },
                  { label: 'In Service', value: vehicles.filter(v => v.in_use).length, accent: '#d97706' },
                  { label: 'Total Crew', value: employees.length, accent: '#0ea5e9' },
                  { label: 'Active Crew', value: employees.filter(e => e.is_active).length, accent: '#7c3aed' },
                ].map(s => (
                  <div key={s.label} style={{
                    background: '#fff', border: `1px solid ${LN}`, borderRadius: 10,
                    padding: isMobile ? '14px 10px' : '20px 24px', textAlign: 'center',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
                  }}>
                    <div style={{ fontSize: isMobile ? '1.6rem' : '2rem', fontWeight: 800, color: s.accent, lineHeight: 1 }}>
                      {s.value}
                    </div>
                    <div style={{
                      fontSize: '0.68rem', fontWeight: 700, color: MUT,
                      textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 6,
                    }}>{s.label}</div>
                  </div>
                ))}
              </div>

              {/* Core Operational Lists (Vehicles & Employees) — Full Width Column Layout */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
                
                {/* Fleet Overview widget */}
                <div>
                  <h2 style={{ fontSize: '1.1rem', fontWeight: 800, margin: '0 0 14px', color: INK, textAlign: 'left' }}>Fleet Overview</h2>
                  {vehicles.length === 0 ? (
                    <div style={{ padding: 32, textAlign: 'center', color: MUT, background: '#fff', border: `1px solid ${LN}`, borderRadius: 8 }}>
                      No vehicles registered yet.
                    </div>
                  ) : (
                    <div style={{
                      display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(280px, 1fr))',
                      gap: 14,
                    }}>
                      {vehicles.map(v => (
                        <div key={v.id} style={{
                          background: '#fff', border: `1px solid ${LN}`, borderRadius: 10,
                          padding: '16px 18px', display: 'flex', alignItems: 'center', gap: 14,
                          boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
                        }}>
                          {localStorage.getItem(`photo_vehicle_${v.id}`) ? (
                            <img src={localStorage.getItem(`photo_vehicle_${v.id}`)!} style={{ width: 60, height: 60, borderRadius: '50%', objectFit: 'cover', border: `2px solid ${v.in_use ? '#d97706' : LN}` }} />
                          ) : (
                            <AmbulanceLargeIcon width={60} inUse={v.in_use || false} />
                          )}
                          <div style={{ flex: 1, textAlign: 'left' }}>
                            <div style={{ fontWeight: 800, fontSize: '1rem', color: INK }}>{v.callsign}</div>
                            <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: '0.76rem', color: MUT }}>{v.registration}</div>
                          </div>
                          <div style={{
                            padding: '4px 10px', borderRadius: 12, fontSize: '0.68rem', fontWeight: 700,
                            background: v.in_use ? '#fef3c7' : '#dcfce7',
                            color: v.in_use ? '#92400e' : '#166534',
                          }}>
                            {v.in_use ? 'IN USE' : 'AVAILABLE'}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Crew at a glance widget */}
                <div>
                  <h2 style={{ fontSize: '1.1rem', fontWeight: 800, margin: '0 0 14px', color: INK, textAlign: 'left' }}>Crew at a Glance</h2>
                  {employees.length === 0 ? (
                    <div style={{ padding: 32, textAlign: 'center', color: MUT, background: '#fff', border: `1px solid ${LN}`, borderRadius: 8 }}>
                      No crew members registered yet.
                    </div>
                  ) : (
                    <div style={{
                      display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(240px, 1fr))',
                      gap: 14,
                    }}>
                      {employees.map(e => {
                        const meta = CATEGORY_META[e.qualification as HpcsaCategory];
                        return (
                          <div key={e.id} style={{
                            background: '#fff', border: `1px solid ${LN}`, borderRadius: 10,
                            padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12,
                            boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
                          }}>
                            {localStorage.getItem(`photo_employee_${e.id}`) ? (
                              <img src={localStorage.getItem(`photo_employee_${e.id}`)!} style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
                            ) : (
                              <div style={{
                                width: 36, height: 36, borderRadius: '50%',
                                background: `${qualColour(e.qualification)}18`, color: qualColour(e.qualification),
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                fontSize: '0.7rem', fontWeight: 800, flexShrink: 0,
                              }}>
                                {(e.initials || e.full_name.split(' ').map(n => n[0]).join('')).slice(0, 2).toUpperCase()}
                              </div>
                            )}
                            <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                              <div style={{ fontWeight: 700, fontSize: '0.88rem', color: INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.full_name}</div>
                              <div style={{ fontSize: '0.7rem', color: MUT }}>{e.qualification}{e.hpcsa_number ? ` — ${e.hpcsa_number}` : ''}</div>
                            </div>
                            <div style={{
                              width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                              background: e.is_active ? G : '#a8afc2',
                            }} title={e.is_active ? 'Active' : 'Inactive'} />
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

              </div>
            </div>
          );
        })()}

        {/* ══════════════════ AMBULANCES TAB ══════════════════ */}
        {/* ══════════════════ AMBULANCES TAB ══════════════════ */}
        {activeTab === 'vehicles' && (() => {
          const filteredVehicles = vehicles.filter(v => 
            v.callsign.toLowerCase().includes(vehSearch.toLowerCase()) ||
            v.registration.toLowerCase().includes(vehSearch.toLowerCase()) ||
            v.vehicle_type.toLowerCase().includes(vehSearch.toLowerCase())
          );
          return (
            <div style={{ padding: isMobile ? '16px 12px' : '28px 36px', maxWidth: 1200, margin: '0 auto' }}>
              <div style={{
                display: 'flex', alignItems: isMobile ? 'stretch' : 'center',
                justifyContent: 'space-between', flexDirection: isMobile ? 'column' : 'row',
                gap: 12, marginBottom: 24,
              }}>
                <div>
                  <h1 style={{ margin: 0, fontSize: isMobile ? '1.3rem' : '1.7rem', fontWeight: 800, color: INK }}>
                    Ambulances
                  </h1>
                  <p style={{ fontSize: '0.85rem', color: MUT, margin: '4px 0 0' }}>
                    {vehicles.length} vehicle{vehicles.length !== 1 ? 's' : ''} registered
                  </p>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <Btn onClick={fetchVehicles} style={{ borderRadius: 24 }}>Refresh</Btn>
                  <Btn kind="primary" onClick={() => setAddVehOpen(true)} style={{ borderRadius: 24 }}>+ New Ambulance</Btn>
                </div>
              </div>

              {/* Search Bar */}
              <div style={{ marginBottom: 24 }}>
                <input
                  type="text"
                  placeholder="Search ambulances by callsign, registration or type..."
                  value={vehSearch}
                  onChange={e => setVehSearch(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '12px 18px',
                    fontSize: '0.88rem',
                    border: `1px solid ${LN2}`,
                    borderRadius: 24,
                    outline: 'none',
                    background: '#fff',
                    color: INK,
                    boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
                    transition: 'all 0.2s ease',
                    boxSizing: 'border-box',
                  }}
                  onFocus={e => { e.currentTarget.style.borderColor = G; e.currentTarget.style.boxShadow = `0 4px 12px ${G}15`; }}
                  onBlur={e => { e.currentTarget.style.borderColor = LN2; e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.04)'; }}
                />
              </div>

              {loading ? (
                <div style={{ padding: 40, textAlign: 'center', color: MUT, background: '#fff', borderRadius: 8, border: `1px solid ${LN}` }}>Loading…</div>
              ) : vehicles.length === 0 ? (
                <div style={{ padding: 48, textAlign: 'center', color: MUT, background: '#fff', borderRadius: 8, border: `1px solid ${LN}` }}>
                  No vehicles registered. Click <b>+ New Ambulance</b> to add your fleet.
                </div>
              ) : filteredVehicles.length === 0 ? (
                <div style={{ padding: 48, textAlign: 'center', color: MUT, background: '#fff', borderRadius: 8, border: `1px solid ${LN}` }}>
                  No ambulances found matching "<b>{vehSearch}</b>".
                </div>
              ) : (
                <div style={{
                  display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(340px, 1fr))',
                  gap: 24,
                }}>
                  {filteredVehicles.map(v => (
                    <div key={v.id} style={{
                      background: '#fff', borderRadius: 28, border: `1px solid ${LN}`,
                      overflow: 'hidden', boxShadow: '0 4px 16px rgba(0,0,0,0.06)',
                      position: 'relative', transition: 'transform 0.25s, box-shadow 0.25s',
                      display: 'flex', flexDirection: 'column', alignItems: 'center',
                      padding: '28px 24px 20px', textAlign: 'center',
                    }}
                    onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.transform = 'translateY(-4px)'; (e.currentTarget as HTMLDivElement).style.boxShadow = '0 12px 32px rgba(8, 145, 178, 0.15)'; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.transform = ''; (e.currentTarget as HTMLDivElement).style.boxShadow = '0 4px 16px rgba(0,0,0,0.06)'; }}
                    >
                      {/* In-use badge — top right */}
                      <div style={{
                        position: 'absolute', top: 16, right: 16,
                        display: 'flex', alignItems: 'center', gap: 6,
                        padding: '4px 12px', borderRadius: 20,
                        background: v.in_use ? 'rgba(16, 185, 129, 0.1)' : '#f3f4f6',
                        border: `1px solid ${v.in_use ? 'rgba(16, 185, 129, 0.2)' : LN}`,
                      }}>
                        <div style={{
                          width: 8, height: 8, borderRadius: '50%',
                          background: v.in_use ? G : '#a8afc2',
                          boxShadow: v.in_use ? `0 0 8px ${G}60` : 'none',
                        }} />
                        <span style={{
                          fontSize: '0.68rem', fontWeight: 700,
                          color: v.in_use ? GD : MUT, textTransform: 'uppercase',
                        }}>
                          {v.in_use ? 'In Use' : 'Available'}
                        </span>
                      </div>

                      {/* Ambulance illustration in circular frame */}
                      <div style={{
                        width: isMobile ? 120 : 150, height: isMobile ? 120 : 150,
                        borderRadius: '50%', overflow: 'hidden',
                        background: v.in_use ? 'rgba(8, 145, 178, 0.06)' : 'rgba(0,0,0,0.02)',
                        border: `3px solid ${v.in_use ? '#0891b2' : LN}`,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        marginBottom: 16,
                      }}>
                        {localStorage.getItem(`photo_vehicle_${v.id}`) ? (
                          <img src={localStorage.getItem(`photo_vehicle_${v.id}`)!} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        ) : (
                          <AmbulanceLargeIcon width={isMobile ? 100 : 120} inUse={v.in_use || false} />
                        )}
                      </div>

                      {/* Callsign */}
                      <h3 style={{ fontSize: '1.3rem', fontWeight: 800, color: INK, margin: '0 0 8px' }}>
                        {v.callsign}
                      </h3>

                      {/* Registration plate */}
                      <div style={{
                        display: 'inline-block', padding: '5px 14px', borderRadius: 20,
                        background: '#fef9c3', border: '2px solid #ca8a04',
                        fontFamily: 'ui-monospace, monospace', fontSize: '0.85rem',
                        fontWeight: 800, color: '#1a1d2e', letterSpacing: '0.1em',
                        marginBottom: 10,
                      }}>
                        {v.registration}
                      </div>

                      {/* Vehicle type badge */}
                      <div style={{
                        padding: '3px 12px', borderRadius: 20,
                        background: 'rgba(8, 145, 178, 0.08)', color: '#0891b2',
                        fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase',
                        letterSpacing: '0.06em', marginBottom: 12,
                      }}>
                        {v.vehicle_type}
                      </div>

                      {/* Active / Inactive status */}
                      <div style={{
                        display: 'flex', alignItems: 'center', gap: 6, marginBottom: 16,
                      }}>
                        <div style={{
                          width: 7, height: 7, borderRadius: '50%',
                          background: v.is_active ? G : '#a8afc2',
                        }} />
                        <span style={{
                          fontSize: '0.72rem', fontWeight: 600,
                          color: v.is_active ? GD : MUT,
                        }}>
                          {v.is_active ? 'Active' : 'Deactivated'}
                        </span>
                      </div>

                      {/* Edit button */}
                      <Btn onClick={() => openEditVeh(v)} style={{ width: '100%' }}>Edit</Btn>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })()}

        {/* ══════════════════ EMPLOYEES TAB ══════════════════ */}
        {activeTab === 'employees' && (() => {
          const filteredEmployees = employees.filter(e => 
            e.full_name.toLowerCase().includes(empSearch.toLowerCase()) ||
            (e.qualification && e.qualification.toLowerCase().includes(empSearch.toLowerCase())) ||
            (e.hpcsa_number && e.hpcsa_number.toLowerCase().includes(empSearch.toLowerCase())) ||
            (e.phone && e.phone.toLowerCase().includes(empSearch.toLowerCase()))
          );
          return (
            <div style={{ padding: isMobile ? '16px 12px' : '28px 36px', maxWidth: 1200, margin: '0 auto' }}>
              <div style={{
                display: 'flex', alignItems: isMobile ? 'stretch' : 'center',
                justifyContent: 'space-between', flexDirection: isMobile ? 'column' : 'row',
                gap: 12, marginBottom: 24,
              }}>
                <div>
                  <h1 style={{ margin: 0, fontSize: isMobile ? '1.3rem' : '1.7rem', fontWeight: 800, color: INK }}>
                    Crew Members
                  </h1>
                  <p style={{ fontSize: '0.85rem', color: MUT, margin: '4px 0 0' }}>
                    {employees.length} crew member{employees.length !== 1 ? 's' : ''} registered
                  </p>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <Btn onClick={fetchEmployees} style={{ borderRadius: 24 }}>Refresh</Btn>
                  <Btn kind="primary" onClick={() => setAddEmpOpen(true)} style={{ borderRadius: 24 }}>+ New Employee</Btn>
                </div>
              </div>

              {/* Search Bar */}
              <div style={{ marginBottom: 24 }}>
                <input
                  type="text"
                  placeholder="Search crew members by name, qualification, HPCSA number or phone..."
                  value={empSearch}
                  onChange={e => setEmpSearch(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '12px 18px',
                    fontSize: '0.88rem',
                    border: `1px solid ${LN2}`,
                    borderRadius: 24,
                    outline: 'none',
                    background: '#fff',
                    color: INK,
                    boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
                    transition: 'all 0.2s ease',
                    boxSizing: 'border-box',
                  }}
                  onFocus={e => { e.currentTarget.style.borderColor = G; e.currentTarget.style.boxShadow = `0 4px 12px ${G}15`; }}
                  onBlur={e => { e.currentTarget.style.borderColor = LN2; e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.04)'; }}
                />
              </div>

              {loading ? (
                <div style={{ padding: 40, textAlign: 'center', color: MUT, background: '#fff', borderRadius: 8, border: `1px solid ${LN}` }}>Loading…</div>
              ) : employees.length === 0 ? (
                <div style={{ padding: 48, textAlign: 'center', color: MUT, background: '#fff', borderRadius: 8, border: `1px solid ${LN}` }}>
                  No crew members registered. Click <b>+ New Employee</b> to add your team.
                </div>
              ) : filteredEmployees.length === 0 ? (
                <div style={{ padding: 48, textAlign: 'center', color: MUT, background: '#fff', borderRadius: 8, border: `1px solid ${LN}` }}>
                  No crew members found matching "<b>{empSearch}</b>".
                </div>
              ) : (
                <div style={{
                  display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(280px, 1fr))',
                  gap: 20,
                }}>
                  {filteredEmployees.map(e => {
                    const meta = CATEGORY_META[e.qualification as HpcsaCategory] || { label: e.qualification, tier: 'BLS' };
                    const qColor = qualColour(e.qualification);
                    return (
                      <div key={e.id} style={{
                        background: '#fff', borderRadius: 28, border: `1px solid ${LN}`,
                        boxShadow: '0 4px 16px rgba(0,0,0,0.06)',
                        display: 'flex', flexDirection: 'column', alignItems: 'center',
                        padding: '28px 22px 22px', textAlign: 'center', position: 'relative',
                        transition: 'transform 0.25s, box-shadow 0.25s',
                      }}
                      onMouseEnter={ev => { (ev.currentTarget as HTMLDivElement).style.transform = 'translateY(-4px)'; (ev.currentTarget as HTMLDivElement).style.boxShadow = `0 12px 32px ${qColor}20`; }}
                      onMouseLeave={ev => { (ev.currentTarget as HTMLDivElement).style.transform = ''; (ev.currentTarget as HTMLDivElement).style.boxShadow = '0 4px 16px rgba(0,0,0,0.06)'; }}
                      >
                        {/* Active status bar */}
                        <div style={{
                          position: 'absolute', top: 0, left: 0, right: 0, height: 4,
                          borderRadius: '28px 28px 0 0',
                          background: e.is_active ? `linear-gradient(90deg, ${qColor}, ${G})` : LN,
                        }} />

                        {/* Profile icon with unified status badge */}
                        <div style={{ position: 'relative', width: 100, height: 100, marginBottom: 14 }}>
                          {localStorage.getItem(`photo_employee_${e.id}`) ? (
                            <img src={localStorage.getItem(`photo_employee_${e.id}`)!} style={{ width: 100, height: 100, borderRadius: '50%', objectFit: 'cover', border: `3px solid ${e.is_active ? qColor : LN}` }} />
                          ) : (
                            <EmployeeLargeIcon
                              size={100}
                              initials={(e.initials || e.full_name.split(' ').map(n => n[0]).join('')).slice(0, 2).toUpperCase()}
                              onShift={e.is_active}
                              showDot={false}
                            />
                          )}

                          {/* Unified status pill badge — top-right overlapping the avatar */}
                          <div style={{
                            position: 'absolute',
                            top: -6,
                            right: -24, // floats over the top-right beautifully
                            display: 'flex',
                            alignItems: 'center',
                            gap: 5,
                            padding: '4px 10px',
                            borderRadius: 20,
                            background: e.is_active ? 'rgba(16, 185, 129, 0.1)' : 'rgba(107, 114, 128, 0.08)',
                            border: `1.5px solid ${e.is_active ? 'rgba(16, 185, 129, 0.3)' : 'rgba(107, 114, 128, 0.2)'}`,
                            boxShadow: '0 2px 10px rgba(0,0,0,0.06)',
                            whiteSpace: 'nowrap',
                            zIndex: 5,
                          }}>
                            <div style={{
                              width: 7,
                              height: 7,
                              borderRadius: '50%',
                              background: e.is_active ? '#388E3C' : '#a8afc2',
                              boxShadow: e.is_active ? '0 0 6px rgba(56, 142, 60, 0.5)' : 'none',
                              animation: e.is_active ? 'status-pulse 2s ease-in-out infinite' : 'none',
                            }} />
                            <span style={{
                              fontSize: '0.68rem',
                              fontWeight: 700,
                              color: e.is_active ? GD : MUT,
                              letterSpacing: '0.01em',
                            }}>
                              {e.is_active ? 'On shift and at base' : 'Off duty'}
                            </span>
                          </div>
                        </div>

                        {/* Name */}
                        <h3 style={{ fontSize: '1.15rem', fontWeight: 800, color: INK, margin: '0 0 4px' }}>
                          {e.full_name}
                        </h3>

                        {/* Email — subtle */}
                        <div style={{ fontSize: '0.68rem', color: `${MUT}aa`, marginBottom: 8, fontStyle: 'italic' }}>
                          {e.email}
                        </div>

                        {/* HPCSA number */}
                        <div style={{
                          fontSize: '0.76rem', color: MUT, marginBottom: 10,
                          fontFamily: 'ui-monospace, monospace',
                        }}>
                          HPCSA: {e.hpcsa_number || '—'}
                        </div>

                        {/* Qualification badge */}
                        <div style={{
                          display: 'inline-flex', alignItems: 'center', gap: 6,
                          padding: '5px 14px', borderRadius: 20,
                          background: `${qColor}12`,
                          border: `1px solid ${qColor}30`,
                          marginBottom: 10,
                        }}>
                          <span style={{
                            fontSize: '0.74rem', fontWeight: 800,
                            color: qColor, letterSpacing: '0.04em',
                          }}>
                            {e.qualification}
                          </span>
                          <span style={{ fontSize: '0.64rem', color: MUT, fontWeight: 500 }}>
                            {meta.label}
                          </span>
                        </div>

                        {/* Divider */}
                        <div style={{ width: '80%', height: 1, background: LN, margin: '4px 0 10px' }} />

                        {/* Phone — subtle */}
                        <div style={{
                          fontSize: '0.7rem', color: `${MUT}99`,
                          marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4,
                        }}>
                          <span style={{ fontSize: '0.65rem' }}>📞</span> {e.phone || '—'}
                        </div>

                        {/* Last Login */}
                        <div style={{
                          fontSize: '0.85rem', color: `${MUT}99`,
                          marginBottom: 14, display: 'flex', alignItems: 'center', gap: 4, fontWeight: 600,
                        }}>
                          <span style={{ fontSize: '0.8rem' }}>🕐</span> Last login: {e.last_login ? new Date(e.last_login).toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'Never'}
                        </div>

                        {/* Action buttons */}
                        <div style={{ display: 'flex', width: '100%', marginTop: 'auto' }}>
                          <Btn onClick={() => openEditEmp(e)} style={{ width: '100%' }}>Edit Profile</Btn>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })()}
      </main>

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
            {/* Photo Section */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, marginBottom: 20 }}>
              <div style={{ position: 'relative', width: 90, height: 90 }}>
                {tempEmpPhoto ? (
                  <img src={tempEmpPhoto} style={{ width: 90, height: 90, borderRadius: '50%', objectFit: 'cover', border: `3px solid ${qualColour(editEmp.qualification)}` }} />
                ) : (
                  <div style={{ width: 90, height: 90, borderRadius: '50%', background: '#f3f4f6', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px dashed #d1d5db' }}>
                    <span style={{ fontSize: '2.2rem' }}>👤</span>
                  </div>
                )}
                <label htmlFor="emp-photo-upload" style={{
                  position: 'absolute', bottom: 0, right: 0, width: 28, height: 28, borderRadius: '50%',
                  background: '#fff', border: `1px solid ${LN}`, display: 'flex', alignItems: 'center',
                  justifyContent: 'center', cursor: 'pointer', boxShadow: '0 2px 6px rgba(0,0,0,0.1)'
                }}>
                  📷
                </label>
                <input
                  type="file"
                  id="emp-photo-upload"
                  accept="image/*"
                  onChange={(evt) => {
                    const file = evt.target.files?.[0];
                    if (file) {
                      resizeImage(file, (base64) => {
                        setTempEmpPhoto(base64);
                      });
                    }
                  }}
                  style={{ display: 'none' }}
                />
              </div>
              <div style={{ display: 'flex', gap: 12 }}>
                <button type="button" onClick={() => document.getElementById('emp-photo-upload')?.click()} style={{
                  background: 'transparent', border: 'none', color: '#0891b2', fontSize: '0.78rem', fontWeight: 700, cursor: 'pointer'
                }}>
                  Upload Photo
                </button>
                {tempEmpPhoto && (
                  <button type="button" onClick={() => setTempEmpPhoto(null)} style={{
                    background: 'transparent', border: 'none', color: '#ef4444', fontSize: '0.78rem', fontWeight: 700, cursor: 'pointer'
                  }}>
                    Remove Photo
                  </button>
                )}
              </div>
            </div>

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
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <Btn kind="secondary" onClick={() => setEditEmpId(null)} style={{ flex: 1, padding: '11px 14px' }}>Cancel</Btn>
              <button type="submit" disabled={editEmpSav} style={{
                flex: 2, padding: '11px 14px', background: G, color: '#fff',
                border: `1px solid ${GD}`, fontSize: '0.8rem', fontWeight: 700, borderRadius: 4,
                cursor: editEmpSav ? 'wait' : 'pointer', fontFamily: 'inherit',
              }}>
                {editEmpSav ? 'Saving…' : 'Save Changes'}
              </button>
            </div>

            {/* Danger Zone */}
            <div style={{
              marginTop: 24, padding: 16, border: '1px solid #fecaca', borderRadius: 12, background: '#fef2f2',
              textAlign: 'left'
            }}>
              <h4 style={{ margin: '0 0 4px', fontSize: '0.85rem', fontWeight: 800, color: '#991b1b' }}>Danger Zone</h4>
              <p style={{ margin: '0 0 12px', fontSize: '0.72rem', color: '#7f1d1d', lineHeight: 1.4 }}>
                Deleting this crew member is permanent and cannot be undone. All database records and logs mapped to this user will lose active references.
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <input
                  type="checkbox"
                  id="confirmEmpDelete"
                  checked={confirmEmpDelete}
                  onChange={e => setConfirmEmpDelete(e.target.checked)}
                  style={{ cursor: 'pointer' }}
                />
                <label htmlFor="confirmEmpDelete" style={{ fontSize: '0.72rem', fontWeight: 700, color: '#7f1d1d', cursor: 'pointer', userSelect: 'none' }}>
                  I confirm I want to permanently delete this crew member
                </label>
              </div>
              <button
                type="button"
                disabled={!confirmEmpDelete}
                onClick={() => deleteEmployee(editEmpId, editEmp.full_name)}
                style={{
                  width: '100%', padding: '10px 14px', background: '#dc2626', color: '#fff',
                  border: 'none', borderRadius: 4, fontSize: '0.8rem', fontWeight: 700,
                  cursor: confirmEmpDelete ? 'pointer' : 'not-allowed',
                  opacity: confirmEmpDelete ? 1 : 0.4,
                  transition: 'opacity 0.2s',
                  fontFamily: 'inherit',
                }}
              >
                Permanently Delete Employee
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

      {/* Edit Vehicle Modal */}
      {editVehId && (
        <Modal title="Edit Vehicle" onClose={() => { setEditVehId(null); setEditVehErr(''); }}>
          {editVehErr && <Alert type="error" text={editVehErr} />}
          <form onSubmit={submitEditVeh}>
            {/* Photo Section */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, marginBottom: 20 }}>
              <div style={{ position: 'relative', width: 140, height: 90, borderRadius: 12, overflow: 'hidden', border: `1px solid ${LN}`, background: '#f9fafb' }}>
                {tempVehPhoto ? (
                  <img src={tempVehPhoto} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <span style={{ fontSize: '2.5rem' }}>🚑</span>
                  </div>
                )}
                <label htmlFor="veh-photo-upload" style={{
                  position: 'absolute', bottom: 6, right: 6, width: 28, height: 28, borderRadius: '50%',
                  background: '#fff', border: `1px solid ${LN}`, display: 'flex', alignItems: 'center',
                  justifyContent: 'center', cursor: 'pointer', boxShadow: '0 2px 6px rgba(0,0,0,0.1)'
                }}>
                  📷
                </label>
                <input
                  type="file"
                  id="veh-photo-upload"
                  accept="image/*"
                  onChange={(evt) => {
                    const file = evt.target.files?.[0];
                    if (file) {
                      resizeImage(file, (base64) => {
                        setTempVehPhoto(base64);
                      });
                    }
                  }}
                  style={{ display: 'none' }}
                />
              </div>
              <div style={{ display: 'flex', gap: 12 }}>
                <button type="button" onClick={() => document.getElementById('veh-photo-upload')?.click()} style={{
                  background: 'transparent', border: 'none', color: '#0891b2', fontSize: '0.78rem', fontWeight: 700, cursor: 'pointer'
                }}>
                  Upload Photo
                </button>
                {tempVehPhoto && (
                  <button type="button" onClick={() => setTempVehPhoto(null)} style={{
                    background: 'transparent', border: 'none', color: '#ef4444', fontSize: '0.78rem', fontWeight: 700, cursor: 'pointer'
                  }}>
                    Remove Photo
                  </button>
                )}
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '0 14px' }}>
              <Field label="Callsign" value={editVeh.callsign} onChange={v => setEditVeh(p => ({ ...p, callsign: v }))} placeholder="JEMS-1" required mono />
              <Field label="Registration" value={editVeh.registration} onChange={v => setEditVeh(p => ({ ...p, registration: v }))} placeholder="GP 12-34-56" required mono />
            </div>
            <SelectField
              label="Vehicle Type"
              value={editVeh.vehicle_type}
              onChange={v => setEditVeh(p => ({ ...p, vehicle_type: v }))}
              options={[
                { value: 'Ambulance',         label: 'Ambulance' },
                { value: 'Rapid Response',    label: 'Rapid Response' },
                { value: 'Patient Transport', label: 'Patient Transport' },
                { value: 'Supervisor',        label: 'Supervisor' },
              ]}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <Btn kind="secondary" onClick={() => setEditVehId(null)} style={{ flex: 1, padding: '11px 14px' }}>Cancel</Btn>
              <button type="submit" disabled={editVehSav} style={{
                flex: 2, padding: '11px 14px', background: G, color: '#fff',
                border: `1px solid ${GD}`, fontSize: '0.8rem', fontWeight: 700, borderRadius: 4,
                cursor: editVehSav ? 'wait' : 'pointer', fontFamily: 'inherit',
              }}>
                {editVehSav ? 'Saving…' : 'Save Changes'}
              </button>
            </div>

            {/* Danger Zone */}
            <div style={{
              marginTop: 24, padding: 16, border: '1px solid #fecaca', borderRadius: 12, background: '#fef2f2',
              textAlign: 'left'
            }}>
              <h4 style={{ margin: '0 0 4px', fontSize: '0.85rem', fontWeight: 800, color: '#991b1b' }}>Danger Zone</h4>
              <p style={{ margin: '0 0 12px', fontSize: '0.72rem', color: '#7f1d1d', lineHeight: 1.4 }}>
                Deleting this vehicle is permanent and cannot be undone. Active cases and PRFs that rely on this vehicle callsign will retain archived logs but callsign lookup will be removed.
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <input
                  type="checkbox"
                  id="confirmVehDelete"
                  checked={confirmVehDelete}
                  onChange={e => setConfirmVehDelete(e.target.checked)}
                  style={{ cursor: 'pointer' }}
                />
                <label htmlFor="confirmVehDelete" style={{ fontSize: '0.72rem', fontWeight: 700, color: '#7f1d1d', cursor: 'pointer', userSelect: 'none' }}>
                  I confirm I want to permanently delete this vehicle
                </label>
              </div>
              <button
                type="button"
                disabled={!confirmVehDelete}
                onClick={() => deleteVehicle(editVehId, editVeh.callsign)}
                style={{
                  width: '100%', padding: '10px 14px', background: '#dc2626', color: '#fff',
                  border: 'none', borderRadius: 4, fontSize: '0.8rem', fontWeight: 700,
                  cursor: confirmVehDelete ? 'pointer' : 'not-allowed',
                  opacity: confirmVehDelete ? 1 : 0.4,
                  transition: 'opacity 0.2s',
                  fontFamily: 'inherit',
                }}
              >
                Permanently Delete Vehicle
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
