/**
 * ProviderAdminDashboard — Minimal admin panel.
 * Dense tables, modal-driven forms. No gradients, no soft shadows.
 */
import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
// Raw axios — this client-portal dashboard authenticates with crew_token via
// getApi() and must stay off the admin api/client interceptor.
import axios from 'axios';
import { useScrollLock } from '../../hooks/useScrollLock';
import { HPCSA_CATEGORIES, CATEGORY_META, type HpcsaCategory } from '../../data/hpcsaScope';

// ── Tokens ───────────────────────────────────────────────────────
const INK = '#0a0a0a';
const MUT = '#6b7280';
const LN  = '#e5e7eb';
const LN2 = '#d1d5db';
const BG  = '#fafafa';
// EMSMCA brand teal replaces the former green throughout this dashboard —
// the client's palette has no green. G = teal, GD = darker teal for borders/hover.
const G   = '#088395';
const GD  = '#066b7a';
const TEAL = '#088395';   // EMSMCA brand teal — used for crew photo placeholders
const RED = '#dc2626';

function getApi() {
  return axios.create({ headers: { Authorization: `Bearer ${localStorage.getItem('crew_token')}` } });
}

type Tab = 'employees' | 'vehicles' | 'prfs';

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
  role?: string;
  photo_url?: string | null;
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
  photo_url?: string | null;
}

interface Prf {
  id: string;
  prf_number: number;
  case_number: string | null;
  /** Set once the billing pipeline finishes — the View button needs it
   *  because the PRF viewer page loads by case id. */
  case_id: string | null;
  status: string;
  patient_name: string | null;
  call_type: string | null;
  crew_1: string | null;
  crew_2: string | null;
  vehicle: string | null;
  submitted_at: string | null;
  created_at: string | null;
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

const blankEmp = () => ({ full_name: '', initials: '', hpcsa_number: '', qualification: 'AEA', phone: '', role: 'crew', is_active: true });
const blankVeh = () => ({ callsign: '', registration: '', vehicle_type: 'Ambulance' });
const blankVehEdit = () => ({ callsign: '', registration: '', vehicle_type: 'Ambulance', is_active: true });
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
  useScrollLock();   // block scrolling of the page behind this pop-up
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

  // Open on the tab named in the URL (?tab=prfs) so returning from the PRF
  // viewer lands back on the Patient Report Forms list, not the default tab.
  const [searchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState<Tab>(() => {
    const t = searchParams.get('tab');
    return t === 'prfs' || t === 'vehicles' || t === 'employees' ? t : 'employees';
  });

  // search + status filter (reset on tab switch)
  const [search,       setSearch]       = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all');
  // Mobile-only: the crew toolbar collapses to icons; the search icon toggles
  // this to reveal the search input.
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);

  // data
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [vehicles,  setVehicles]  = useState<Vehicle[]>([]);
  const [prfs,      setPrfs]      = useState<Prf[]>([]);
  const [loading,   setLoading]   = useState(false);

  // modals
  const [addEmpOpen, setAddEmpOpen] = useState(false);
  const [editEmpId,  setEditEmpId]  = useState<string | null>(null);
  const [addVehOpen, setAddVehOpen] = useState(false);

  // add employee
  const [newEmp,    setNewEmp]    = useState(blankEmp());
  const [newEmpErr, setNewEmpErr] = useState('');
  const [newEmpSav, setNewEmpSav] = useState(false);
  // Photo is chosen before the crew row exists, so it's held here and uploaded
  // right after creation (the create call returns the new crew id).
  const [newEmpPhoto,    setNewEmpPhoto]    = useState<File | null>(null);
  const [newEmpPhotoUrl, setNewEmpPhotoUrl] = useState('');
  const resetNewEmpPhoto = () => { setNewEmpPhoto(null); setNewEmpPhotoUrl(''); };

  // edit employee
  const [editEmp,    setEditEmp]    = useState(blankEmp());
  const [editEmpErr, setEditEmpErr] = useState('');
  const [editEmpSav, setEditEmpSav] = useState(false);
  const [editEmpPhoto, setEditEmpPhoto] = useState<string | null>(null);
  const [empPhotoBusy, setEmpPhotoBusy] = useState(false);

  // add vehicle
  const [newVeh,    setNewVeh]    = useState(blankVeh());
  const [newVehErr, setNewVehErr] = useState('');
  const [newVehSav, setNewVehSav] = useState(false);
  const [newVehPhoto,    setNewVehPhoto]    = useState<File | null>(null);
  const [newVehPhotoUrl, setNewVehPhotoUrl] = useState('');
  const resetNewVehPhoto = () => { setNewVehPhoto(null); setNewVehPhotoUrl(''); };

  // edit vehicle
  const [editVehId,  setEditVehId]  = useState<string | null>(null);
  const [editVeh,    setEditVeh]    = useState(blankVehEdit());
  const [editVehErr, setEditVehErr] = useState('');
  const [editVehSav, setEditVehSav] = useState(false);
  const [editVehPhoto, setEditVehPhoto] = useState<string | null>(null);
  const [vehPhotoBusy, setVehPhotoBusy] = useState(false);

  // reset-password result (shown inside the edit employee modal)
  const [pwReset,    setPwReset]    = useState<string | null>(null);
  const [pwResetBusy, setPwResetBusy] = useState(false);

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

  const fetchPrfs = useCallback(async () => {
    if (!providerId) return;
    setLoading(true);
    try { const { data } = await getApi().get(`/api/providers/${providerId}/prfs`); setPrfs(data); }
    catch { /* ignore */ }
    setLoading(false);
  }, [providerId]);

  useEffect(() => {
    if (activeTab === 'employees') fetchEmployees();
    else if (activeTab === 'vehicles') fetchVehicles();
    else if (activeTab === 'prfs') fetchPrfs();
  }, [activeTab]);

  // ── Search + status filtering (client-side; lists are small) ─────
  const q = search.trim().toLowerCase();
  const matchStatus = (active: boolean) =>
    statusFilter === 'all' || (statusFilter === 'active' ? active : !active);

  const filteredEmployees = employees.filter(e =>
    matchStatus(e.is_active) &&
    (!q || [e.full_name, e.hpcsa_number, e.qualification, e.phone, e.role]
      .some(f => (f || '').toLowerCase().includes(q)))
  );
  const filteredVehicles = vehicles.filter(v =>
    matchStatus(v.is_active) &&
    (!q || [v.callsign, v.registration, v.vehicle_type]
      .some(f => (f || '').toLowerCase().includes(q)))
  );
  const filteredPrfs = prfs.filter(p =>
    !q || [String(p.prf_number), p.case_number, p.patient_name, p.call_type,
      p.crew_1, p.crew_2, p.vehicle, p.status]
      .some(f => (f || '').toLowerCase().includes(q))
  );

  // Small headline counts shown as chips beneath the title.
  const empActive = employees.filter(e => e.is_active).length;
  const vehActive = vehicles.filter(v => v.is_active).length;
  const vehInUse  = vehicles.filter(v => v.in_use).length;

  // ── Actions ─────────────────────────────────────────────────────
  const submitNewEmp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!providerId) { setNewEmpErr('Session invalid.'); return; }
    if (newEmp.role !== 'admin' && !newEmp.hpcsa_number.trim()) { setNewEmpErr('HPCSA number is required for crew.'); return; }
    setNewEmpSav(true); setNewEmpErr('');
    try {
      const { data } = await getApi().post(`/api/providers/${providerId}/crew`, {
        full_name:    newEmp.full_name.trim(),
        initials:     newEmp.role === 'admin' ? null : newEmp.initials.trim() || null,
        email:        newEmp.role === 'admin' ? null : `${newEmp.hpcsa_number.trim().toLowerCase()}@noemail.local`, // backend will auto-gen if email is missing
        hpcsa_number: newEmp.role === 'admin' ? null : newEmp.hpcsa_number.trim().toUpperCase(),
        qualification: newEmp.role === 'admin' ? 'Admin' : newEmp.qualification,
        phone:        newEmp.role === 'admin' ? null : newEmp.phone.trim() || null,
        role:         newEmp.role,
      });
      // Upload the chosen face photo now that we have the new crew id.
      if (newEmpPhoto && data?.id) {
        try {
          const form = new FormData();
          form.append('file', newEmpPhoto);
          await getApi().post(`/api/providers/${providerId}/crew/${data.id}/photo`, form,
            { headers: { 'Content-Type': 'multipart/form-data' } });
        } catch { /* photo is non-fatal — the crew member was still created */ }
      }
      setNewEmp(blankEmp());
      resetNewEmpPhoto();
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
      role:         e.role || 'crew',
      is_active:    e.is_active,
    });
    setEditEmpPhoto(e.photo_url || null);
    setEditEmpErr('');
    setPwReset(null);
  };

  const uploadEmpPhoto = async (file: File) => {
    if (!editEmpId || !providerId) return;
    setEmpPhotoBusy(true); setEditEmpErr('');
    try {
      const form = new FormData();
      form.append('file', file);
      const { data } = await getApi().post(
        `/api/providers/${providerId}/crew/${editEmpId}/photo`, form,
        { headers: { 'Content-Type': 'multipart/form-data' } },
      );
      // Cache-bust so the replaced thumbnail (same filename) refreshes at once.
      setEditEmpPhoto(data.photo_url ? `${data.photo_url}?t=${Date.now()}` : null);
      fetchEmployees();
    } catch (err: any) {
      setEditEmpErr(err.response?.data?.detail || 'Failed to upload photo.');
    }
    setEmpPhotoBusy(false);
  };

  const submitEditEmp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editEmpId || !providerId) return;
    if (editEmp.role !== 'admin' && !editEmp.hpcsa_number.trim()) { setEditEmpErr('HPCSA number is required for crew.'); return; }
    setEditEmpSav(true); setEditEmpErr('');
    try {
      await getApi().patch(`/api/providers/${providerId}/crew/${editEmpId}`, {
        full_name:    editEmp.full_name.trim(),
        initials:     editEmp.role === 'admin' ? null : editEmp.initials.trim() || null,
        hpcsa_number: editEmp.role === 'admin' ? null : editEmp.hpcsa_number.trim().toUpperCase() || null,
        qualification: editEmp.role === 'admin' ? 'Admin' : editEmp.qualification,
        phone:        editEmp.role === 'admin' ? null : editEmp.phone.trim() || null,
        role:         editEmp.role,
        is_active:    editEmp.is_active,
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
      const { data } = await getApi().post(`/api/providers/${providerId}/vehicles`, {
        callsign: newVeh.callsign.trim(),
        registration: newVeh.registration.trim(),
        vehicle_type: newVeh.vehicle_type,
      });
      // Upload the chosen photo now that we have the new vehicle id.
      if (newVehPhoto && data?.id) {
        try {
          const form = new FormData();
          form.append('file', newVehPhoto);
          await getApi().post(`/api/providers/${providerId}/vehicles/${data.id}/photo`, form,
            { headers: { 'Content-Type': 'multipart/form-data' } });
        } catch { /* photo is non-fatal — the vehicle was still created */ }
      }
      setNewVeh(blankVeh());
      resetNewVehPhoto();
      setAddVehOpen(false);
      fetchVehicles();
    } catch (err: any) {
      setNewVehErr(err.response?.data?.detail || 'Failed to add vehicle.');
    }
    setNewVehSav(false);
  };

  const uploadVehPhoto = async (file: File) => {
    if (!editVehId || !providerId) return;
    setVehPhotoBusy(true); setEditVehErr('');
    try {
      const form = new FormData();
      form.append('file', file);
      const { data } = await getApi().post(
        `/api/providers/${providerId}/vehicles/${editVehId}/photo`, form,
        { headers: { 'Content-Type': 'multipart/form-data' } },
      );
      setEditVehPhoto(data.photo_url ? `${data.photo_url}?t=${Date.now()}` : null);
      fetchVehicles();
    } catch (err: any) {
      setEditVehErr(err.response?.data?.detail || 'Failed to upload photo.');
    }
    setVehPhotoBusy(false);
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

  const openEditVeh = (v: Vehicle) => {
    setEditVehId(v.id);
    setEditVeh({
      callsign:     v.callsign,
      registration: v.registration,
      vehicle_type: v.vehicle_type,
      is_active:    v.is_active,
    });
    setEditVehPhoto(v.photo_url || null);
    setEditVehErr('');
  };

  const submitEditVeh = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editVehId || !providerId) return;
    setEditVehSav(true); setEditVehErr('');
    try {
      await getApi().patch(`/api/providers/${providerId}/vehicles/${editVehId}`, {
        callsign:     editVeh.callsign.trim(),
        registration: editVeh.registration.trim(),
        vehicle_type: editVeh.vehicle_type,
        is_active:    editVeh.is_active,
      });
      setEditVehId(null);
      fetchVehicles();
    } catch (err: any) {
      setEditVehErr(err.response?.data?.detail || 'Failed to update vehicle.');
    }
    setEditVehSav(false);
  };

  // Reset a crew member's password — backend returns a one-time temp password
  // that the admin reads out / sends to the crew member. Surfaced inside the
  // edit modal so it stays in context with the employee being edited.
  const resetPassword = async () => {
    if (!editEmpId || !providerId) return;
    setPwResetBusy(true); setPwReset(null); setEditEmpErr('');
    try {
      const { data } = await getApi().post(`/api/providers/${providerId}/crew/${editEmpId}/reset-password`);
      setPwReset(data.temp_password || '');
    } catch (err: any) {
      setEditEmpErr(err.response?.data?.detail || 'Failed to reset password.');
    }
    setPwResetBusy(false);
  };

  const handleLogout = () => {
    localStorage.removeItem('crew_token'); localStorage.removeItem('crew_profile');
    navigate(`/${providerSlug}/login`);
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
  const fmtDateTime = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleString('en-ZA', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })
      : '—';
  // Small headline count pill. `color` tints the dot + value; default is neutral.
  const chipStyle = (color: string = MUT): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', gap: 5,
    padding: '2px 9px', borderRadius: 999, border: `1px solid ${LN}`,
    background: '#fff', fontSize: '0.68rem', fontWeight: 700, color,
    whiteSpace: 'nowrap',
  });
  // Mobile compact-toolbar icon button. `primary` gives the green filled look
  // used for the add-employee action; others are neutral outlined squares.
  const iconBtn = (primary: boolean): React.CSSProperties => ({
    width: 42, height: 42, borderRadius: 8, padding: 0, flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
    background: primary ? G : '#fff',
    color: primary ? '#fff' : INK,
    border: `1px solid ${primary ? GD : LN2}`,
  });
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

      {/* ── Icon Navigation Bar ─────────────────────────────────────────
          Two centred quick-action icons below the header.
          · Crew   — jumps to Employees section
          · Ambulance — jumps to Vehicles section                      */}
      <nav style={{
        background: '#fff', borderBottom: `1px solid ${LN}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        gap: isMobile ? 32 : 56, padding: isMobile ? '10px 0' : '12px 0',
        flexShrink: 0,
      }}>
        {([
          {
            key: 'crew',
            label: 'Crew',
            tab: 'employees' as Tab,
            icon: (
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="9" cy="7" r="3"/>
                <path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/>
                <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
                <path d="M21 21v-2a4 4 0 0 0-3-3.87"/>
              </svg>
            ),
          },
          {
            key: 'ambulance',
            label: 'Ambulance',
            tab: 'vehicles' as Tab,
            icon: (
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="1" y="7" width="16" height="11" rx="1"/>
                <path d="M16 12h4l2 4v2h-6V12z"/>
                <circle cx="5.5" cy="18.5" r="1.5"/>
                <circle cx="18.5" cy="18.5" r="1.5"/>
                <path d="M7 10h3M8.5 8.5v3"/>
              </svg>
            ),
          },
          {
            key: 'prfs',
            label: 'PRFs',
            tab: 'prfs' as Tab,
            icon: (
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <path d="M14 2v6h6"/>
                <path d="M9 13h6M9 17h6"/>
              </svg>
            ),
          },
        ] as { key: string; label: string; tab: Tab; icon: React.ReactNode }[]).map(({ key, label, tab, icon }) => {
          return (
            <button
              key={key}
              type="button"
              onClick={() => setActiveTab(tab)}
              style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
                background: 'transparent', border: 'none', cursor: 'pointer', padding: '4px 10px',
                color: activeTab === tab ? G : MUT,
                transition: 'color 0.18s',
              }}
            >
              {icon}
              <span style={{ fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                {label}
              </span>
              {/* Active underline dot */}
              <span style={{
                width: 5, height: 5, borderRadius: 99,
                background: activeTab === tab ? G : 'transparent',
                transition: 'background 0.18s',
              }} />
            </button>
          );
        })}
      </nav>

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


        {/* Main */}
        <main style={{ flex: 1, overflowY: 'auto', padding: isMobile ? '14px 12px' : '24px 28px', minWidth: 0 }}>
          {activeTab === 'prfs' ? (
          <>
          {/* ── PRFs — every form submitted by this provider's crews ──
              Title bar mirrors the Fleet layout: title left, search +
              refresh icons right. */}
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
                Patient Report Forms
              </h1>
              <div style={{ fontSize: '0.78rem', color: MUT, marginTop: 6, lineHeight: 1.5 }}>
                PRFs appear here automatically as your crews submit them.
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" aria-label="Search" onClick={() => setMobileSearchOpen(o => !o)} style={iconBtn(mobileSearchOpen)}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>
                </svg>
              </button>
              <button type="button" aria-label="Refresh" onClick={fetchPrfs} style={iconBtn(false)}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>
                </svg>
              </button>
            </div>
          </div>

          {mobileSearchOpen && (
            <div style={{ marginBottom: 14 }}>
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search PRF #, patient, crew, vehicle…"
                onFocus={onFc} onBlur={onBl}
                autoComplete="off" autoFocus
                style={{ ...inputStyle, padding: '9px 12px', width: '100%' }}
              />
            </div>
          )}

          {loading ? (
            <div style={{ padding: 40, textAlign: 'center', color: MUT, fontSize: '0.84rem', background: '#fff', border: `1px solid ${LN}`, borderRadius: 6 }}>Loading…</div>
          ) : filteredPrfs.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: MUT, fontSize: '0.84rem', background: '#fff', border: `1px solid ${LN}`, borderRadius: 6 }}>
              {prfs.length === 0 ? 'No PRFs yet. Submitted PRFs from your crews will appear here.' : 'No PRFs match your search.'}
            </div>
          ) : isMobile ? (
            /* Stacked cards — a 7-column table can't fit a phone screen. */
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {filteredPrfs.map(p => (
                <div key={p.id} style={{ background: '#fff', border: `1px solid ${LN}`, borderRadius: 8, padding: 14 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 10 }}>
                    <div style={{ fontWeight: 800, fontSize: '0.95rem', fontFamily: 'ui-monospace, monospace' }}>PRF #{p.prf_number}</div>
                    <div style={{ fontSize: '0.7rem', color: MUT, whiteSpace: 'nowrap' }}>{fmtDateTime(p.submitted_at || p.created_at)}</div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '7px 12px', fontSize: '0.78rem', color: MUT, marginBottom: 12 }}>
                    <div style={{ gridColumn: '1 / -1' }}><span style={{ fontWeight: 700, color: INK }}>Patient:</span> {p.patient_name || '—'}</div>
                    <div><span style={{ fontWeight: 700, color: INK }}>Crew:</span> {[p.crew_1, p.crew_2].filter(Boolean).join(', ') || '—'}</div>
                    <div><span style={{ fontWeight: 700, color: INK }}>Vehicle:</span> {p.vehicle || '—'}</div>
                    <div style={{ gridColumn: '1 / -1' }}><span style={{ fontWeight: 700, color: INK }}>Case:</span> <span style={{ fontFamily: 'ui-monospace, monospace' }}>{p.case_number || '—'}</span></div>
                  </div>
                  {p.case_id ? (
                    <Btn kind="primary" onClick={() => navigate(`/${providerSlug}/crew/prf-view/${p.case_id}?from=admin`)} style={{ width: '100%', padding: '11px 10px', fontSize: '0.8rem' }}>View PRF</Btn>
                  ) : (
                    <div style={{ textAlign: 'center', fontSize: '0.72rem', color: MUT, padding: '8px 0', background: BG, borderRadius: 6 }}>
                      {p.status === 'submitted' ? 'Processing — view available shortly.' : 'View not available.'}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div style={{ background: '#fff', border: `1px solid ${LN}`, borderRadius: 6, overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={thStyle}>PRF #</th>
                    <th style={thStyle}>Case Number</th>
                    <th style={thStyle}>Patient</th>
                    <th style={thStyle}>Crew</th>
                    <th style={thStyle}>Vehicle</th>
                    <th style={thStyle}>Submitted</th>
                    <th style={{ ...thStyle, textAlign: 'right' }} aria-label="Actions"></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredPrfs.map(p => (
                    <tr key={p.id} style={{ borderBottom: `1px solid ${LN}` }}>
                      <td style={{ ...tdStyle, fontFamily: 'ui-monospace, monospace', fontWeight: 700 }}>#{p.prf_number}</td>
                      <td style={{ ...tdStyle, fontFamily: 'ui-monospace, monospace' }}>{p.case_number || '—'}</td>
                      <td style={tdStyle}>{p.patient_name || '—'}</td>
                      <td style={tdStyle}>{[p.crew_1, p.crew_2].filter(Boolean).join(', ') || '—'}</td>
                      <td style={{ ...tdStyle, fontFamily: 'ui-monospace, monospace' }}>{p.vehicle || '—'}</td>
                      <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>{fmtDateTime(p.submitted_at || p.created_at)}</td>
                      <td style={{ ...tdStyle, textAlign: 'right' }}>
                        {p.case_id ? (
                          <Btn onClick={() => navigate(`/${providerSlug}/crew/prf-view/${p.case_id}?from=admin`)} style={{ padding: '6px 12px', fontSize: '0.74rem' }}>View</Btn>
                        ) : (
                          <span style={{ fontSize: '0.7rem', color: MUT }}>{p.status === 'submitted' ? 'Processing…' : '—'}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          </>
          ) : (
          <>
          {activeTab === 'employees' ? (
          /* Crew view (mobile + desktop) — decluttered: no title, chips or status
             filter. Just a neat right-aligned group of icon actions. The search
             icon toggles a full-width search input beneath the group. */
          <div style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8 }}>
              <button type="button" aria-label="Search" onClick={() => setMobileSearchOpen(o => !o)} style={iconBtn(mobileSearchOpen)}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>
                </svg>
              </button>
              <button type="button" aria-label="Refresh" onClick={fetchEmployees} style={iconBtn(false)}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>
                </svg>
              </button>
              <button type="button" aria-label="New employee" onClick={() => setAddEmpOpen(true)} style={iconBtn(true)}>
                <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="9" cy="7" r="3.2"/>
                  <path d="M3.5 20v-1.5a4.5 4.5 0 0 1 4.5-4.5h2a4.5 4.5 0 0 1 2.6.83"/>
                  <path d="M17 14v6M20 17h-6"/>
                </svg>
              </button>
            </div>
            {mobileSearchOpen && (
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search name, HPCSA, level…"
                onFocus={onFc} onBlur={onBl}
                autoComplete="off" autoFocus
                style={{ ...inputStyle, padding: '9px 12px', marginTop: 8, width: '100%' }}
              />
            )}
          </div>
          ) : (
          <>
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
                Fleet
              </h1>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" aria-label="Search" onClick={() => setMobileSearchOpen(o => !o)} style={iconBtn(mobileSearchOpen)}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>
                </svg>
              </button>
              <button type="button" aria-label="Refresh" onClick={fetchVehicles} style={iconBtn(false)}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>
                </svg>
              </button>
              <Btn kind="primary" onClick={() => setAddVehOpen(true)}
                style={isMobile ? { flex: 2, padding: '10px 14px' } : undefined}>
                + New Vehicle
              </Btn>
            </div>
          </div>

          {/* Search — hidden until the search icon above is pressed. */}
          {mobileSearchOpen && (
            <div style={{ marginBottom: 14 }}>
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search callsign, registration, type…"
                onFocus={onFc} onBlur={onBl}
                autoComplete="off" autoFocus
                style={{ ...inputStyle, padding: '9px 12px', width: '100%' }}
              />
            </div>
          )}
          </>
          )}

          {/* List — table on desktop, stacked card list on mobile.
              Tables don't fit a phone screen; cards keep all info visible
              without horizontal scrolling. */}
          {isMobile ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {activeTab === 'employees' ? (
                loading ? (
                  <div style={{ padding: 32, textAlign: 'center', color: MUT, fontSize: '0.84rem', background: '#fff', border: `1px solid ${LN}`, borderRadius: 6 }}>Loading…</div>
                ) : filteredEmployees.length === 0 ? (
                  <div style={{ padding: 32, textAlign: 'center', color: MUT, fontSize: '0.84rem', background: '#fff', border: `1px solid ${LN}`, borderRadius: 6 }}>
                    {employees.length === 0 ? <>No crew members. Tap <b>New Employee</b> to register.</> : 'No crew members match your search or filter.'}
                  </div>
                ) : filteredEmployees.map(e => (
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
                          {e.role === 'admin' ? (
                            <span style={{
                              display: 'inline-block', padding: '1px 6px',
                              border: `1px solid ${INK}`, color: INK,
                              fontSize: '0.6rem', fontWeight: 700,
                              letterSpacing: '0.06em', borderRadius: 3,
                            }}>ADMIN</span>
                          ) : (
                            <span style={{
                              display: 'inline-block', padding: '1px 6px',
                              border: `1px solid ${qualColour(e.qualification) || MUT}`,
                              color: qualColour(e.qualification) || INK,
                              fontSize: '0.6rem', fontWeight: 700,
                              letterSpacing: '0.06em', borderRadius: 3,
                            }}>{e.qualification}</span>
                          )}
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
                ) : filteredVehicles.length === 0 ? (
                  <div style={{ padding: 32, textAlign: 'center', color: MUT, fontSize: '0.84rem', background: '#fff', border: `1px solid ${LN}`, borderRadius: 6 }}>
                    {vehicles.length === 0 ? <>No vehicles. Tap <b>New Vehicle</b> to register your fleet.</> : 'No vehicles match your search or filter.'}
                  </div>
                ) : filteredVehicles.map(v => (
                  <div key={v.id} style={{ background: '#fff', border: `1px solid ${LN}`, borderRadius: 6, padding: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, gap: 8 }}>
                      <div style={{ fontWeight: 700, fontSize: '0.9rem', fontFamily: 'ui-monospace, monospace' }}>{v.callsign}</div>
                      {!v.is_active && (
                        <div style={{ fontSize: '0.7rem', fontWeight: 700, color: RED }}>
                          ● Inactive
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px', fontSize: '0.76rem', color: MUT, marginBottom: 10 }}>
                      <div><span style={{ fontWeight: 700, color: INK }}>Reg:</span> <span style={{ fontFamily: 'ui-monospace, monospace' }}>{v.registration}</span></div>
                      <div><span style={{ fontWeight: 700, color: INK }}>Type:</span> {v.vehicle_type}</div>
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <Btn onClick={() => openEditVeh(v)} style={{ flex: 1, padding: '8px 10px', fontSize: '0.78rem' }}>Edit</Btn>
                      <Btn kind="danger" onClick={() => deleteVehicle(v.id, v.callsign)} style={{ flex: 1, padding: '8px 10px', fontSize: '0.78rem' }}>Delete</Btn>
                    </div>
                  </div>
                ))
              )}
            </div>
          ) : (
          <div style={{ background: '#fff', border: `1px solid ${LN}`, borderRadius: 6, overflowX: 'auto' }}>
            {activeTab === 'employees' ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 20, padding: 16 }}>
                {loading ? (
                  <div style={{ gridColumn: '1 / -1', padding: 32, textAlign: 'center', color: MUT, fontSize: '0.82rem' }}>Loading…</div>
                ) : filteredEmployees.length === 0 ? (
                  <div style={{ gridColumn: '1 / -1', padding: 40, textAlign: 'center', color: MUT, fontSize: '0.82rem' }}>
                    {employees.length === 0 ? <>No crew members. Click <b>New Employee</b> to register.</> : 'No crew members match your search or filter.'}
                  </div>
                ) : filteredEmployees.map(e => (
                  <div key={e.id} style={{ background: '#fff', border: `1px solid ${LN}`, borderRadius: 20, padding: 30, minHeight: 470, display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', boxShadow: '0 2px 6px rgba(0,0,0,0.05)' }}>
                    {/* Profile photo — face thumbnail, or initials fallback */}
                    <div style={{
                      width: 168, height: 168, borderRadius: '50%', overflow: 'hidden',
                      background: TEAL, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: '3rem', fontWeight: 800, fontFamily: 'ui-monospace, monospace',
                      marginBottom: 16, flexShrink: 0, border: `3px solid ${LN}`,
                    }}>
                      {e.photo_url ? (
                        <img src={e.photo_url} alt={e.full_name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      ) : (
                        (e.initials || e.full_name.split(' ').map(n => n[0]).join('')).slice(0, 2).toUpperCase()
                      )}
                    </div>
                    <div style={{ fontWeight: 800, fontSize: '1.1rem', color: INK, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.full_name}</div>
                    {/* Status pill */}
                    <div style={{
                      marginTop: 6, fontSize: '0.62rem', fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase',
                      padding: '3px 12px', borderRadius: 999,
                      background: e.is_active ? 'rgba(8,131,149,0.12)' : 'rgba(220,38,38,0.1)',
                      color: e.is_active ? TEAL : RED,
                    }}>
                      {e.is_active ? 'Active' : 'Inactive'}
                    </div>
                    {/* Details */}
                    <div style={{ width: '100%', marginTop: 16, paddingTop: 14, borderTop: `1px solid ${LN}`, fontSize: '0.8rem', color: MUT, lineHeight: 2, textAlign: 'left' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><span style={{ fontWeight: 700, color: INK }}>HPCSA</span><span style={{ fontFamily: 'ui-monospace, monospace' }}>{e.hpcsa_number || '—'}</span></div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><span style={{ fontWeight: 700, color: INK }}>Phone</span><span>{e.phone || '—'}</span></div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><span style={{ fontWeight: 700, color: INK }}>Last login</span><span>{e.last_login ? new Date(e.last_login).toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</span></div>
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 'auto', paddingTop: 18, width: '100%' }}>
                      <Btn onClick={() => openEditEmp(e)} style={{ flex: 1, padding: '9px 10px', fontSize: '0.8rem' }}>Edit</Btn>
                      <Btn kind="danger" onClick={() => deleteEmployee(e.id, e.full_name)} style={{ flex: 1, padding: '9px 10px', fontSize: '0.8rem' }}>Delete</Btn>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 20, padding: 16 }}>
                {loading ? (
                  <div style={{ gridColumn: '1 / -1', padding: 32, textAlign: 'center', color: MUT, fontSize: '0.82rem' }}>Loading…</div>
                ) : filteredVehicles.length === 0 ? (
                  <div style={{ gridColumn: '1 / -1', padding: 40, textAlign: 'center', color: MUT, fontSize: '0.82rem' }}>
                    {vehicles.length === 0 ? <>No vehicles. Click <b>New Vehicle</b> to register your fleet.</> : 'No vehicles match your search or filter.'}
                  </div>
                ) : filteredVehicles.map(v => (
                  <div key={v.id} style={{ background: '#fff', border: `1px solid ${LN}`, borderRadius: 20, padding: 30, minHeight: 470, display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', boxShadow: '0 2px 6px rgba(0,0,0,0.05)' }}>
                    {/* Ambulance photo — thumbnail, or ambulance icon fallback */}
                    <div style={{
                      width: 168, height: 168, borderRadius: '50%', overflow: 'hidden',
                      background: TEAL, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: '3.4rem', fontWeight: 800,
                      marginBottom: 16, flexShrink: 0, border: `3px solid ${LN}`,
                    }}>
                      {v.photo_url ? (
                        <img src={v.photo_url} alt={v.callsign} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      ) : (
                        <svg width="76" height="76" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-label="Ambulance">
                          <path d="M10 10H6"/>
                          <path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/>
                          <path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.62L18.3 9.38a1 1 0 0 0-.78-.38H14"/>
                          <path d="M8 8v4"/>
                          <path d="M9 18h6"/>
                          <circle cx="17" cy="18" r="2"/>
                          <circle cx="7" cy="18" r="2"/>
                        </svg>
                      )}
                    </div>
                    <div style={{ fontWeight: 800, fontSize: '1.1rem', color: INK, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'ui-monospace, monospace', letterSpacing: '0.04em' }}>{v.callsign}</div>
                    {/* Status pill — only flagged when inactive */}
                    {!v.is_active && (
                      <div style={{
                        marginTop: 6, fontSize: '0.62rem', fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase',
                        padding: '3px 12px', borderRadius: 999,
                        background: 'rgba(220,38,38,0.1)', color: RED,
                      }}>
                        Inactive
                      </div>
                    )}
                    {/* Details */}
                    <div style={{ width: '100%', marginTop: 16, paddingTop: 14, borderTop: `1px solid ${LN}`, fontSize: '0.8rem', color: MUT, lineHeight: 2, textAlign: 'left' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><span style={{ fontWeight: 700, color: INK }}>Registration</span><span style={{ fontFamily: 'ui-monospace, monospace' }}>{v.registration || '—'}</span></div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><span style={{ fontWeight: 700, color: INK }}>Type</span><span>{v.vehicle_type || '—'}</span></div>
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 'auto', paddingTop: 18, width: '100%' }}>
                      <Btn onClick={() => openEditVeh(v)} style={{ flex: 1, padding: '9px 10px', fontSize: '0.8rem' }}>Edit</Btn>
                      <Btn kind="danger" onClick={() => deleteVehicle(v.id, v.callsign)} style={{ flex: 1, padding: '9px 10px', fontSize: '0.8rem' }}>Delete</Btn>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          )}
          </>
          )}
        </main>
      </div>

      {/* Add Employee Modal */}
      {addEmpOpen && (
        <Modal title="Register New Employee" onClose={() => { setAddEmpOpen(false); setNewEmpErr(''); resetNewEmpPhoto(); }}>
          {newEmpErr && <Alert type="error" text={newEmpErr} />}
          <form onSubmit={submitNewEmp}>
            {/* ── Crew face photo ── */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, marginBottom: 16 }}>
              <div style={{
                width: 96, height: 96, borderRadius: '50%', overflow: 'hidden',
                background: TEAL, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '1.6rem', fontWeight: 800, fontFamily: 'ui-monospace, monospace',
                flexShrink: 0, border: `2px solid ${LN}`,
              }}>
                {newEmpPhotoUrl ? (
                  <img src={newEmpPhotoUrl} alt="Crew photo" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  (newEmp.initials || newEmp.full_name.split(' ').map(n => n[0]).join('')).slice(0, 2).toUpperCase() || '?'
                )}
              </div>
              <label style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer',
                padding: '8px 14px', border: `1px solid ${GD}`, borderRadius: 4,
                background: G, color: '#fff', fontSize: '0.78rem', fontWeight: 700,
              }}>
                {newEmpPhotoUrl ? 'Change Photo of Crew' : 'Add Photo of Crew'}
                <input type="file" accept="image/png,image/jpeg,image/webp" style={{ display: 'none' }}
                  onChange={e => {
                    const f = e.target.files?.[0];
                    if (f) { if (newEmpPhotoUrl) URL.revokeObjectURL(newEmpPhotoUrl); setNewEmpPhoto(f); setNewEmpPhotoUrl(URL.createObjectURL(f)); }
                    e.currentTarget.value = '';
                  }} />
              </label>
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer' }}>
                <input type="checkbox" checked={newEmp.role === 'admin'} onChange={e => setNewEmp(p => ({ ...p, role: e.target.checked ? 'admin' : 'crew' }))} style={{ width: 16, height: 16, cursor: 'pointer' }} />
                This user is an Administrator
              </label>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '0 14px' }}>
              <Field label="Full Name" value={newEmp.full_name} onChange={v => setNewEmp(p => ({ ...p, full_name: v }))} placeholder="John Smith" required />
              {newEmp.role !== 'admin' && <Field label="Initials" value={newEmp.initials} onChange={v => setNewEmp(p => ({ ...p, initials: v }))} placeholder="J.S." />}
              {newEmp.role !== 'admin' && <Field label="HPCSA Number" value={newEmp.hpcsa_number} onChange={v => setNewEmp(p => ({ ...p, hpcsa_number: v }))} placeholder="MT0012345" required mono />}
              {newEmp.role !== 'admin' && <Field label="Phone" value={newEmp.phone} onChange={v => setNewEmp(p => ({ ...p, phone: v }))} placeholder="082 000 0000" />}
            </div>
            {newEmp.role !== 'admin' && (
              <SelectField
                label="HPCSA Registration"
                value={newEmp.qualification}
                onChange={v => setNewEmp(p => ({ ...p, qualification: v }))}
                options={HPCSA_QUAL_OPTIONS}
              />
            )}
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
            {/* ── Crew face photo ── */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, marginBottom: 16 }}>
              <div style={{
                width: 96, height: 96, borderRadius: '50%', overflow: 'hidden',
                background: TEAL, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '1.6rem', fontWeight: 800, fontFamily: 'ui-monospace, monospace',
                flexShrink: 0, border: `2px solid ${LN}`,
              }}>
                {editEmpPhoto ? (
                  <img src={editEmpPhoto} alt="Crew photo" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  (editEmp.initials || editEmp.full_name.split(' ').map(n => n[0]).join('')).slice(0, 2).toUpperCase() || '?'
                )}
              </div>
              <label style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, cursor: empPhotoBusy ? 'wait' : 'pointer',
                padding: '8px 14px', border: `1px solid ${GD}`, borderRadius: 4,
                background: empPhotoBusy ? '#e5e7eb' : G, color: empPhotoBusy ? MUT : '#fff',
                fontSize: '0.78rem', fontWeight: 700,
              }}>
                {empPhotoBusy ? 'Uploading…' : (editEmpPhoto ? 'Replace Photo of Crew' : 'Add Photo of Crew')}
                <input type="file" accept="image/png,image/jpeg,image/webp" style={{ display: 'none' }}
                  disabled={empPhotoBusy}
                  onChange={e => { const f = e.target.files?.[0]; if (f) uploadEmpPhoto(f); e.currentTarget.value = ''; }} />
              </label>
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer' }}>
                <input type="checkbox" checked={editEmp.role === 'admin'} onChange={e => setEditEmp(p => ({ ...p, role: e.target.checked ? 'admin' : 'crew' }))} style={{ width: 16, height: 16, cursor: 'pointer' }} />
                This user is an Administrator
              </label>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '0 14px' }}>
              <Field label="Full Name" value={editEmp.full_name} onChange={v => setEditEmp(p => ({ ...p, full_name: v }))} required />
              {editEmp.role !== 'admin' && <Field label="Initials" value={editEmp.initials} onChange={v => setEditEmp(p => ({ ...p, initials: v }))} />}
              {editEmp.role !== 'admin' && <Field label="HPCSA Number" value={editEmp.hpcsa_number} onChange={v => setEditEmp(p => ({ ...p, hpcsa_number: v }))} mono />}
              {editEmp.role !== 'admin' && <Field label="Phone" value={editEmp.phone} onChange={v => setEditEmp(p => ({ ...p, phone: v }))} />}
            </div>
            {editEmp.role !== 'admin' && (
              <SelectField
                label="HPCSA Registration"
                value={editEmp.qualification}
                onChange={v => setEditEmp(p => ({ ...p, qualification: v }))}
                options={HPCSA_QUAL_OPTIONS}
              />
            )}
            {/* ── Account & status ── */}
            <div style={{ borderTop: `1px solid ${LN}`, margin: '4px 0 14px' }} />
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer', marginBottom: 14 }}>
              <input type="checkbox" checked={editEmp.is_active} onChange={e => setEditEmp(p => ({ ...p, is_active: e.target.checked }))} style={{ width: 16, height: 16, cursor: 'pointer' }} />
              Active — can log in and be assigned to shifts
            </label>
            {pwReset !== null && (
              <Alert type="success" text={`Temporary password: ${pwReset} — share it with the employee; they can change it after logging in.`} />
            )}
            <div style={{ marginBottom: 16 }}>
              <Btn kind="secondary" onClick={resetPassword} disabled={pwResetBusy} style={{ width: '100%', padding: '10px 14px' }}>
                {pwResetBusy ? 'Resetting…' : 'Reset Password'}
              </Btn>
            </div>
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
        <Modal title="Register New Vehicle" onClose={() => { setAddVehOpen(false); setNewVehErr(''); resetNewVehPhoto(); }}>
          {newVehErr && <Alert type="error" text={newVehErr} />}
          <form onSubmit={submitNewVeh}>
            {/* ── Ambulance photo ── */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, marginBottom: 16 }}>
              <div style={{
                width: 96, height: 96, borderRadius: '50%', overflow: 'hidden',
                background: TEAL, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '2rem', flexShrink: 0, border: `2px solid ${LN}`,
              }}>
                {newVehPhotoUrl ? (
                  <img src={newVehPhotoUrl} alt="Ambulance photo" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-label="Ambulance">
                    <path d="M10 10H6"/>
                    <path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/>
                    <path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.62L18.3 9.38a1 1 0 0 0-.78-.38H14"/>
                    <path d="M8 8v4"/>
                    <path d="M9 18h6"/>
                    <circle cx="17" cy="18" r="2"/>
                    <circle cx="7" cy="18" r="2"/>
                  </svg>
                )}
              </div>
              <label style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer',
                padding: '8px 14px', border: `1px solid ${GD}`, borderRadius: 4,
                background: G, color: '#fff', fontSize: '0.78rem', fontWeight: 700,
              }}>
                {newVehPhotoUrl ? 'Change Photo of Ambulance' : 'Add Photo of Ambulance'}
                <input type="file" accept="image/png,image/jpeg,image/webp" style={{ display: 'none' }}
                  onChange={e => {
                    const f = e.target.files?.[0];
                    if (f) { if (newVehPhotoUrl) URL.revokeObjectURL(newVehPhotoUrl); setNewVehPhoto(f); setNewVehPhotoUrl(URL.createObjectURL(f)); }
                    e.currentTarget.value = '';
                  }} />
              </label>
            </div>
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
            {/* ── Ambulance photo ── */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, marginBottom: 16 }}>
              <div style={{
                width: 96, height: 96, borderRadius: '50%', overflow: 'hidden',
                background: TEAL, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '2rem', flexShrink: 0, border: `2px solid ${LN}`,
              }}>
                {editVehPhoto ? (
                  <img src={editVehPhoto} alt="Ambulance photo" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-label="Ambulance">
                    <path d="M10 10H6"/>
                    <path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/>
                    <path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.62L18.3 9.38a1 1 0 0 0-.78-.38H14"/>
                    <path d="M8 8v4"/>
                    <path d="M9 18h6"/>
                    <circle cx="17" cy="18" r="2"/>
                    <circle cx="7" cy="18" r="2"/>
                  </svg>
                )}
              </div>
              <label style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, cursor: vehPhotoBusy ? 'wait' : 'pointer',
                padding: '8px 14px', border: `1px solid ${GD}`, borderRadius: 4,
                background: vehPhotoBusy ? '#e5e7eb' : G, color: vehPhotoBusy ? MUT : '#fff',
                fontSize: '0.78rem', fontWeight: 700,
              }}>
                {vehPhotoBusy ? 'Uploading…' : (editVehPhoto ? 'Replace Photo of Ambulance' : 'Add Photo of Ambulance')}
                <input type="file" accept="image/png,image/jpeg,image/webp" style={{ display: 'none' }}
                  disabled={vehPhotoBusy}
                  onChange={e => { const f = e.target.files?.[0]; if (f) uploadVehPhoto(f); e.currentTarget.value = ''; }} />
              </label>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '0 14px' }}>
              <Field label="Callsign" value={editVeh.callsign} onChange={v => setEditVeh(p => ({ ...p, callsign: v }))} placeholder="JEMS-1" required mono />
              <Field label="Registration" value={editVeh.registration} onChange={v => setEditVeh(p => ({ ...p, registration: v }))} placeholder="GP 12-34-56" required mono />
            </div>
            <SelectField
              label="Vehicle Type" value={editVeh.vehicle_type}
              onChange={v => setEditVeh(p => ({ ...p, vehicle_type: v }))}
              options={[
                { value: 'Ambulance',         label: 'Ambulance' },
                { value: 'Rapid Response',    label: 'Rapid Response' },
                { value: 'Patient Transport', label: 'Patient Transport' },
                { value: 'Supervisor',        label: 'Supervisor' },
              ]}
            />
            {/* ── Status ── */}
            <div style={{ borderTop: `1px solid ${LN}`, margin: '4px 0 14px' }} />
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer', marginBottom: 16 }}>
              <input type="checkbox" checked={editVeh.is_active} onChange={e => setEditVeh(p => ({ ...p, is_active: e.target.checked }))} style={{ width: 16, height: 16, cursor: 'pointer' }} />
              Active — available to crews for new shifts
            </label>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <Btn kind="secondary" onClick={() => setEditVehId(null)} style={{ flex: 1, padding: '11px 14px' }}>Cancel</Btn>
              <button type="submit" disabled={editVehSav} style={{
                flex: 2, padding: '11px 14px', background: G, color: '#fff',
                border: `1px solid ${GD}`, fontSize: '0.8rem', fontWeight: 700, borderRadius: 4,
                cursor: editVehSav ? 'wait' : 'pointer', fontFamily: 'inherit',
              }}>
                {editVehSav ? 'Saving…' : 'Save Changes'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
