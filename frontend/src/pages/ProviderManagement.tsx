/**
 * ProviderManagement — Admin page to manage Service Providers, Crew, and Vehicles.
 * Accessible from the admin sidebar.
 */
import { useState, useEffect, useCallback } from 'react';
import api from '../api/client';
import { useScrollLock } from '../hooks/useScrollLock';

interface Provider {
  id: string;
  name: string;
  slug: string;
  pr_number: string | null;
  prf_name?: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  is_active: boolean;
  crew_count: number;
  vehicle_count: number;
  prf_count: number;
  created_at: string | null;
  logo_url?: string | null;
  portal_login_username?: string | null;
  admin_email?: string | null;
}

interface CrewMember {
  id: string;
  email: string;
  full_name: string;
  initials: string | null;
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
}

const teal = '#088395';
const rose = '#C2185B';

// ── Inline SVG icons (stroke = currentColor so they inherit text color) ──
type IconProps = { size?: number };
const svgBase = (size: number) => ({
  width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
});
const GearIcon = ({ size = 16 }: IconProps) => (
  <svg {...svgBase(size)}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);
const BackIcon = ({ size = 18 }: IconProps) => (
  <svg {...svgBase(size)}><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
);
const UsersIcon = ({ size = 16 }: IconProps) => (
  <svg {...svgBase(size)}>
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);
const AmbulanceIcon = ({ size = 16 }: IconProps) => (
  <svg {...svgBase(size)}>
    <path d="M10 10H6M8 8v4" />
    <path d="M4 17V7a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v3h3.5a1 1 0 0 1 .8.4l2.5 3.3a1 1 0 0 1 .2.6V17a1 1 0 0 1-1 1h-1" />
    <circle cx="7.5" cy="18" r="2" /><circle cx="17.5" cy="18" r="2" /><path d="M9.5 18h6M4 18H3" />
  </svg>
);
const TrashIcon = ({ size = 16 }: IconProps) => (
  <svg {...svgBase(size)}>
    <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V6" />
    <path d="M10 11v6M14 11v6" />
  </svg>
);
const EditIcon = ({ size = 16 }: IconProps) => (
  <svg {...svgBase(size)}>
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
  </svg>
);
const UploadIcon = ({ size = 16 }: IconProps) => (
  <svg {...svgBase(size)}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" /></svg>
);
const WarnIcon = ({ size = 16 }: IconProps) => (
  <svg {...svgBase(size)}>
    <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
    <path d="M12 9v4M12 17h.01" />
  </svg>
);
const HospitalIcon = ({ size = 16 }: IconProps) => (
  <svg {...svgBase(size)}>
    <path d="M3 21h18M5 21V7l7-4 7 4v14" /><path d="M12 8v6M9 11h6" />
  </svg>
);
const SpinnerIcon = ({ size = 16 }: IconProps) => (
  <svg {...svgBase(size)} style={{ animation: 'pm-spin 0.8s linear infinite' }}>
    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
  </svg>
);

export default function ProviderManagement() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);

  // Modal states
  const [showAddProvider, setShowAddProvider] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<Provider | null>(null);
  const [activeTab, setActiveTab] = useState<'crew' | 'vehicles'>('crew');

  // Edit client modal state
  const [showEditClient, setShowEditClient] = useState(false);
  const [editForm, setEditForm] = useState({ name: '', pr_number: '', prf_name: '', phone: '', email: '', address: '', is_active: true, portal_username: '', portal_password: '', admin_email: '', admin_password: '', prfNumber: '' });
  const [editSaving, setEditSaving] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [logoUploading, setLogoUploading] = useState(false);

  // Crew/Vehicle lists for selected provider
  const [crew, setCrew] = useState<CrewMember[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [crewLoading, setCrewLoading] = useState(false);

  // Add forms
  const [newProvider, setNewProvider] = useState({ name: '', phone: '', email: '', prNumber: '', ptyRegNumber: '', prfName: '', address: '', prfNumber: '', clientEmail: '', clientPassword: '', adminEmail: '', adminPassword: '' });
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [newCrew, setNewCrew] = useState({ full_name: '', email: '', initials: '', hpcsa_number: '', qualification: 'ILS', phone: '' });
  const [newVehicle, setNewVehicle] = useState({ callsign: '', registration: '', vehicle_type: 'Ambulance' });
  const [showAddCrew, setShowAddCrew] = useState(false);
  const [showAddVehicle, setShowAddVehicle] = useState(false);

  const [showEditVehicle, setShowEditVehicle] = useState(false);
  const [editingVehicleId, setEditingVehicleId] = useState<string | null>(null);
  const [editVehicleForm, setEditVehicleForm] = useState({ callsign: '', registration: '', vehicle_type: 'Ambulance' });
  const [editVehicleSaving, setEditVehicleSaving] = useState(false);
  
  const [showEditCrew, setShowEditCrew] = useState(false);
  const [editingCrewId, setEditingCrewId] = useState<string | null>(null);
  const [editCrewForm, setEditCrewForm] = useState({ full_name: '', email: '', initials: '', hpcsa_number: '', qualification: 'ILS', phone: '' });
  const [editCrewSaving, setEditCrewSaving] = useState(false);

  // Lock the background page while any pop-up on this screen is open.
  useScrollLock(showAddProvider || showEditClient || showAddCrew || showEditCrew || showAddVehicle || showEditVehicle);
  const [tempPassword, setTempPassword] = useState('');

  const fetchProviders = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/api/providers');
      setProviders(res.data);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetchProviders(); }, [fetchProviders]);

  const fetchProviderDetails = async (provider: Provider) => {
    setSelectedProvider(provider);
    setCrewLoading(true);
    try {
      const [crewRes, vehicleRes] = await Promise.all([
        api.get(`/api/providers/${provider.id}/crew`),
        api.get(`/api/providers/${provider.id}/vehicles`),
      ]);
      setCrew(crewRes.data);
      setVehicles(vehicleRes.data);
    } catch { /* ignore */ }
    setCrewLoading(false);
  };

  const openEditClient = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!selectedProvider) return;
    setEditForm({
      name: selectedProvider.name || '',
      pr_number: selectedProvider.pr_number || '',
      prf_name: selectedProvider.prf_name || '',
      phone: selectedProvider.phone || '',
      email: selectedProvider.email || '',
      address: selectedProvider.address || '',
      is_active: selectedProvider.is_active,
      portal_username: selectedProvider.portal_login_username || '',
      portal_password: '',  // never pre-fill passwords
      admin_email: selectedProvider.admin_email || '',
      admin_password: '',
      // Always blank on load — the baseline is write-only. Pre-filling it would
      // let a re-save silently reset the provider's PRF sequence.
      prfNumber: '',
    });
    setLogoPreview(selectedProvider.logo_url || null);
    setShowEditClient(true);
    setShowDeleteConfirm(false);
  };

  const handleSaveClient = async () => {
    if (!selectedProvider) return;
    setEditSaving(true);
    try {
      await api.patch(`/api/providers/${selectedProvider.id}`, {
        name: editForm.name || undefined,
        pr_number: editForm.pr_number || undefined,
        // Always sent — an explicit null clears the override so file naming
        // falls back to the company name.
        prf_name: editForm.prf_name.trim() || null,
        phone: editForm.phone || undefined,
        email: editForm.email || undefined,
        address: editForm.address || undefined,
        is_active: editForm.is_active,
        // Credential fields — only send if user typed something
        portal_login_username: editForm.portal_username.trim() || undefined,
        portal_login_password: editForm.portal_password.trim() || undefined,
        admin_email: editForm.admin_email.trim() || undefined,
        admin_password: editForm.admin_password.trim() || undefined,
        // PRF baseline — only sent when the admin typed a value, so a blank
        // field leaves the existing counter untouched. Sent as-typed; the
        // backend extracts the digits (JEM0690 → 690).
        current_prf_number: editForm.prfNumber.trim() || undefined,
      });
      const updated = { ...selectedProvider, ...editForm };
      setSelectedProvider(updated);
      setShowEditClient(false);
      fetchProviders();
    } catch (e: any) {
      alert(e.response?.data?.detail || 'Failed to update client');
    }
    setEditSaving(false);
  };

  const handleDeleteClient = async () => {
    if (!selectedProvider) return;
    if (deleteConfirmText !== selectedProvider.name) {
      alert('Client name does not match. Deletion cancelled.');
      return;
    }
    setDeleting(true);
    try {
      await api.delete(`/api/providers/${selectedProvider.id}`);
      setShowEditClient(false);
      setShowDeleteConfirm(false);
      setSelectedProvider(null);
      fetchProviders();
    } catch (e: any) {
      alert(e.response?.data?.detail || 'Failed to delete client');
    }
    setDeleting(false);
  };

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!selectedProvider || !e.target.files?.[0]) return;
    const file = e.target.files[0];
    setLogoUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await api.post(`/api/providers/${selectedProvider.id}/logo`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      const newLogoUrl = res.data.logo_url;
      setLogoPreview(newLogoUrl);
      setSelectedProvider({ ...selectedProvider, logo_url: newLogoUrl });
      fetchProviders();
    } catch (err: any) {
      alert(err.response?.data?.detail || 'Failed to upload logo');
    }
    setLogoUploading(false);
  };

  const handleAddProvider = async () => {
    if (!newProvider.name.trim()) {
      alert('Company Name is required');
      return;
    }
    try {
      const payload = {
        name: newProvider.name,
        phone: newProvider.phone || undefined,
        email: newProvider.email || undefined,
        pr_number: newProvider.prNumber || undefined,
        pty_reg_number: newProvider.ptyRegNumber || undefined,
        prf_name: newProvider.prfName.trim() || undefined,
        address: newProvider.address || undefined,
        current_prf_number: newProvider.prfNumber.trim() || undefined,
        portal_login_email: newProvider.clientEmail || undefined,
        portal_login_password: newProvider.clientPassword || undefined,
        admin_email: newProvider.adminEmail || undefined,
        admin_password: newProvider.adminPassword || undefined,
      };
      const res = await api.post('/api/providers', payload);
      const providerId = res.data.id;

      if (logoFile && providerId) {
        const formData = new FormData();
        formData.append('file', logoFile);
        await api.post(`/api/providers/${providerId}/logo`, formData, {
          headers: { 'Content-Type': 'multipart/form-data' },
        });
      }

      setShowAddProvider(false);
      setNewProvider({ name: '', phone: '', email: '', prNumber: '', ptyRegNumber: '', prfName: '', address: '', prfNumber: '', clientEmail: '', clientPassword: '', adminEmail: '', adminPassword: '' });
      setLogoFile(null);
      fetchProviders();
    } catch (e: any) {
      alert(e.response?.data?.detail || 'Failed to create client');
    }
  };

  const handleAddCrew = async () => {
    if (!selectedProvider) return;
    try {
      const res = await api.post(`/api/providers/${selectedProvider.id}/crew`, newCrew);
      setTempPassword(res.data.temp_password);
      setNewCrew({ full_name: '', email: '', initials: '', hpcsa_number: '', qualification: 'ILS', phone: '' });
      fetchProviderDetails(selectedProvider);
    } catch (e: any) {
      alert(e.response?.data?.detail || 'Failed to add crew member');
    }
  };

  // Close the Add-Crew modal and reset transient state so a re-open starts
  // clean (no lingering generated password, no half-typed fields).
  const closeAddCrew = () => {
    setShowAddCrew(false);
    setTempPassword('');
    setNewCrew({ full_name: '', email: '', initials: '', hpcsa_number: '', qualification: 'ILS', phone: '' });
  };

  const handleAddVehicle = async () => {
    if (!selectedProvider) return;
    try {
      await api.post(`/api/providers/${selectedProvider.id}/vehicles`, newVehicle);
      setShowAddVehicle(false);
      setNewVehicle({ callsign: '', registration: '', vehicle_type: 'Ambulance' });
      fetchProviderDetails(selectedProvider);
    } catch (e: any) {
      alert(e.response?.data?.detail || 'Failed to add vehicle');
    }
  };

  // Close the Add-Vehicle modal and reset the form so a re-open starts clean.
  const closeAddVehicle = () => {
    setShowAddVehicle(false);
    setNewVehicle({ callsign: '', registration: '', vehicle_type: 'Ambulance' });
  };

  const handleDeleteVehicle = async (vehicleId: string) => {
    if (!selectedProvider) return;
    if (!window.confirm('Are you sure you want to delete this vehicle?')) return;
    try {
      await api.delete(`/api/providers/${selectedProvider.id}/vehicles/${vehicleId}`);
      fetchProviderDetails(selectedProvider);
    } catch (e: any) {
      alert(e.response?.data?.detail || 'Failed to delete vehicle');
    }
  };

  const openEditVehicle = (vehicle: Vehicle) => {
    setEditingVehicleId(vehicle.id);
    setEditVehicleForm({
      callsign: vehicle.callsign,
      registration: vehicle.registration,
      vehicle_type: vehicle.vehicle_type || 'Ambulance',
    });
    setShowEditVehicle(true);
  };

  const closeEditVehicle = () => {
    setShowEditVehicle(false);
    setEditingVehicleId(null);
  };

  const handleSaveVehicle = async () => {
    if (!selectedProvider || !editingVehicleId) return;
    setEditVehicleSaving(true);
    try {
      await api.patch(`/api/providers/${selectedProvider.id}/vehicles/${editingVehicleId}`, editVehicleForm);
      closeEditVehicle();
      fetchProviderDetails(selectedProvider);
    } catch (e: any) {
      alert(e.response?.data?.detail || 'Failed to update vehicle');
    }
    setEditVehicleSaving(false);
  };

  const handleDeleteCrew = async (crewId: string) => {
    if (!selectedProvider) return;
    if (!window.confirm('Are you sure you want to delete this crew member?')) return;
    try {
      await api.delete(`/api/providers/${selectedProvider.id}/crew/${crewId}`);
      fetchProviderDetails(selectedProvider);
    } catch (e: any) {
      alert(e.response?.data?.detail || 'Failed to delete crew member');
    }
  };

  const openEditCrew = (member: CrewMember) => {
    setEditingCrewId(member.id);
    setEditCrewForm({
      full_name: member.full_name,
      email: member.email,
      initials: member.initials || '',
      hpcsa_number: member.hpcsa_number || '',
      qualification: member.qualification || 'ILS',
      phone: member.phone || '',
    });
    setShowEditCrew(true);
  };

  const closeEditCrew = () => {
    setShowEditCrew(false);
    setEditingCrewId(null);
  };

  const handleSaveCrew = async () => {
    if (!selectedProvider || !editingCrewId) return;
    setEditCrewSaving(true);
    try {
      await api.patch(`/api/providers/${selectedProvider.id}/crew/${editingCrewId}`, editCrewForm);
      closeEditCrew();
      fetchProviderDetails(selectedProvider);
    } catch (e: any) {
      alert(e.response?.data?.detail || 'Failed to update crew member');
    }
    setEditCrewSaving(false);
  };

  const cardStyle: React.CSSProperties = {
    background: 'var(--surface-50)',
    borderRadius: 12,
    border: '1px solid var(--surface-100)',
    padding: 20,
    marginBottom: 16,
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
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    fontSize: '0.84rem',
    padding: '8px 12px',
    borderRadius: 8,
    border: '1.5px solid #94a3b8',
    background: '#ffffff',
    color: 'var(--text)',
    boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.02)',
    marginBottom: 8,
    boxSizing: 'border-box',
  };

  // Field labels: full-contrast dark text, bolder and a touch larger than the
  // old muted-grey 0.68rem — the low contrast was the eye-strain culprit.
  const labelStyle: React.CSSProperties = {
    fontSize: '0.78rem',
    fontWeight: 800,
    color: 'var(--text)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    marginBottom: 5,
    display: 'block',
  };

  // ── Provider List View ──
  if (!selectedProvider) {
    return (
      <div style={{ maxWidth: 900, margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <div>
            <h1 style={{ fontSize: '1.5rem', fontWeight: 800, margin: 0, color: 'var(--text)' }}>
              Clients
            </h1>
            <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', margin: '4px 0 0' }}>
              Manage EMS companies, crew members, and vehicles
            </p>
          </div>
          <button style={btnPrimary} onClick={() => setShowAddProvider(true)}>+ Add Provider</button>
        </div>

        {/* Add Provider Modal */}
        {showAddProvider && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000 }}>
            <div style={{ ...cardStyle, maxWidth: 600, width: '90%', padding: 32, maxHeight: '85vh', overflowY: 'auto', position: 'relative' }}>
              <button onClick={() => setShowAddProvider(false)} style={{ position: 'absolute', top: 12, right: 16, background: 'none', border: 'none', fontSize: '1.3rem', cursor: 'pointer', color: 'var(--text-muted)' }}>&times;</button>
              <h3 style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: 16, color: teal }}>Add New Client</h3>
              
              <div style={{ display: 'grid', gap: 16 }}>
                <div>
                  <label style={labelStyle}>Company Name *</label>
                  <input style={inputStyle} value={newProvider.name} onChange={e => setNewProvider({ ...newProvider, name: e.target.value })} />
                </div>

                {/* Company details — auto-filled into the top-left corner of every PDF PRF (mirrors Company Settings). */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div>
                    <label style={labelStyle}>Phone Number</label>
                    <input style={inputStyle} value={newProvider.phone} onChange={e => setNewProvider({ ...newProvider, phone: e.target.value })} />
                  </div>
                  <div>
                    <label style={labelStyle}>Email Address</label>
                    <input style={inputStyle} type="email" value={newProvider.email} onChange={e => setNewProvider({ ...newProvider, email: e.target.value })} />
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div>
                    <label style={labelStyle}>PR Number</label>
                    <input style={inputStyle} value={newProvider.prNumber} onChange={e => setNewProvider({ ...newProvider, prNumber: e.target.value })} />
                  </div>
                  <div>
                    <label style={labelStyle}>PTY Reg Number</label>
                    <input style={inputStyle} value={newProvider.ptyRegNumber} onChange={e => setNewProvider({ ...newProvider, ptyRegNumber: e.target.value })} />
                  </div>
                </div>

                <div>
                  <label style={labelStyle}>Latest PRF Number</label>
                  {/* Accepts the keyword+number form used to categorise PRFs — the counter is seeded from the digits (EL30 → 30, next PRF 31). */}
                  <input
                    style={inputStyle}
                    type="text"
                    value={newProvider.prfNumber}
                    onChange={e => setNewProvider({ ...newProvider, prfNumber: e.target.value })}
                  />
                </div>

                <div>
                  <label style={labelStyle}>PRF Name</label>
                  <input
                    style={inputStyle}
                    value={newProvider.prfName}
                    onChange={e => setNewProvider({ ...newProvider, prfName: e.target.value })}
                  />
                </div>

                <div>
                  <label style={labelStyle}>Address</label>
                  <textarea style={{ ...inputStyle, minHeight: 70, resize: 'vertical', fontFamily: 'inherit' }} value={newProvider.address} onChange={e => setNewProvider({ ...newProvider, address: e.target.value })} />
                </div>

                <div>
                  <label style={labelStyle}>Company Logo</label>
                  <input type="file" style={{ ...inputStyle, padding: '8px' }} accept="image/*" onChange={e => setLogoFile(e.target.files?.[0] || null)} />
                </div>

                <div style={{ background: 'var(--surface-50)', padding: 16, borderRadius: 8, border: '1px solid var(--surface-100)' }}>
                  <h4 style={{ fontSize: '0.9rem', fontWeight: 700, marginBottom: 12, color: 'var(--text)' }}>EMSMCA Client Login</h4>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <div>
                      <label style={labelStyle}>Username *</label>
                      <input style={inputStyle} value={newProvider.clientEmail}
                        onChange={e => setNewProvider({ ...newProvider, clientEmail: e.target.value })}
                        autoComplete="off" data-lpignore="true" data-form-type="other" />
                    </div>
                    <div>
                      <label style={labelStyle}>Password *</label>
                      <input style={inputStyle} type="password" value={newProvider.clientPassword}
                        onChange={e => setNewProvider({ ...newProvider, clientPassword: e.target.value })}
                        autoComplete="new-password" data-lpignore="true" data-form-type="other" />
                    </div>
                  </div>
                </div>

                <div style={{ background: 'var(--surface-50)', padding: 16, borderRadius: 8, border: '1px solid var(--surface-100)' }}>
                  <h4 style={{ fontSize: '0.9rem', fontWeight: 700, marginBottom: 12, color: 'var(--text)' }}>Portal Admin Login</h4>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <div>
                      <label style={labelStyle}>Admin Email</label>
                      <input style={inputStyle} type="email" value={newProvider.adminEmail}
                        onChange={e => setNewProvider({ ...newProvider, adminEmail: e.target.value })}
                        autoComplete="off" data-lpignore="true" data-form-type="other" />
                    </div>
                    <div>
                      <label style={labelStyle}>Admin Password</label>
                      <input style={inputStyle} type="password" value={newProvider.adminPassword}
                        onChange={e => setNewProvider({ ...newProvider, adminPassword: e.target.value })}
                        autoComplete="new-password" data-lpignore="true" data-form-type="other" />
                    </div>
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8, marginTop: 24, justifyContent: 'flex-end' }}>
                <button style={{ ...btnPrimary, background: 'var(--surface-200)', color: 'var(--text)' }} onClick={() => setShowAddProvider(false)}>Cancel</button>
                <button style={btnPrimary} onClick={handleAddProvider}>Create Client</button>
              </div>
            </div>
          </div>
        )}

        {loading ? (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>Loading providers...</div>
        ) : providers.length === 0 ? (
          <div style={{ ...cardStyle, textAlign: 'center', padding: 40 }}>
            <p style={{ fontSize: '1rem', color: 'var(--text-muted)' }}>No service providers yet</p>
            <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>Click "Add Provider" to onboard your first EMS company.</p>
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 12 }}>
            {providers.map(p => (
              <div key={p.id} style={{ ...cardStyle, cursor: 'pointer', transition: 'border-color 0.15s', marginBottom: 0 }} onClick={() => fetchProviderDetails(p)}
                onMouseEnter={e => (e.currentTarget.style.borderColor = teal)}
                onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--surface-100)')}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    {p.logo_url ? (
                      <img src={p.logo_url} alt={p.name} style={{ width: 36, height: 36, objectFit: 'contain', borderRadius: 6, border: '1px solid var(--surface-100)', background: '#fff', padding: 2 }} />
                    ) : (
                      <div style={{ width: 36, height: 36, borderRadius: 6, background: `rgba(8,131,149,0.1)`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1rem', fontWeight: 800, color: teal }}>
                        {p.name[0]?.toUpperCase()}
                      </div>
                    )}
                    <div>
                      <div style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--text)' }}>{p.name}</div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 2 }}>
                        /{p.slug}/crew • PR: {p.pr_number || '—'} • {p.phone || '—'}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
                    {[
                      { label: 'Crew', val: p.crew_count, color: teal },
                      { label: 'Vehicles', val: p.vehicle_count, color: '#E65100' },
                      { label: 'PRFs', val: p.prf_count, color: rose },
                    ].map(s => (
                      <div key={s.label} style={{ textAlign: 'center' }}>
                        <div style={{ fontSize: '1.2rem', fontWeight: 800, color: s.color }}>{s.val}</div>
                        <div style={{ fontSize: '0.6rem', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase' }}>{s.label}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ── Provider Detail View (Crew + Vehicles) ──
  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <style>{`
        @keyframes pm-spin { to { transform: rotate(360deg); } }
        .pm-row { transition: background 0.12s; }
        .pm-row:hover { background: rgba(8,131,149,0.035); }
      `}</style>
      {/* Edit Client Modal */}
      {showEditClient && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000 }}>
          <div style={{ ...cardStyle, maxWidth: 560, width: '90%', padding: 32, maxHeight: '90vh', overflowY: 'auto', position: 'relative' }}>
            <button onClick={() => setShowEditClient(false)} style={{ position: 'absolute', top: 12, right: 16, background: 'none', border: 'none', fontSize: '1.4rem', cursor: 'pointer', color: 'var(--text-muted)' }}>&times;</button>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
              <div style={{ width: 36, height: 36, borderRadius: 8, background: `rgba(8,131,149,0.1)`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: teal }}>
                <GearIcon size={18} />
              </div>
              <div>
                <h3 style={{ fontSize: '1rem', fontWeight: 700, margin: 0, color: 'var(--text)' }}>Edit Client Settings</h3>
                <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', margin: 0 }}>{selectedProvider.name}</p>
              </div>
            </div>

            <div style={{ display: 'grid', gap: 14 }}>
              {/* ── Logo Upload Section ── */}
              <div style={{ padding: '14px 16px', borderRadius: 10, background: 'var(--surface-100)', border: '1px solid var(--surface-200)' }}>
                <label style={labelStyle}>Company Logo</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 6 }}>
                  {/* Preview */}
                  <div style={{ width: 64, height: 64, borderRadius: 10, border: '1.5px dashed var(--surface-300)', background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, overflow: 'hidden' }}>
                    {logoPreview ? (
                      <img src={logoPreview} alt="logo preview" style={{ width: '100%', height: '100%', objectFit: 'contain', padding: 4 }} />
                    ) : (
                      <span style={{ color: 'var(--text-muted)' }}><HospitalIcon size={26} /></span>
                    )}
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={{
                      display: 'inline-flex', alignItems: 'center', gap: 6,
                      padding: '7px 14px', borderRadius: 7,
                      background: logoUploading ? 'var(--surface-200)' : `linear-gradient(135deg, ${teal}, #0a9396)`,
                      color: logoUploading ? 'var(--text-muted)' : '#fff',
                      fontSize: '0.78rem', fontWeight: 700, cursor: logoUploading ? 'wait' : 'pointer',
                    }}>
                      {logoUploading ? <SpinnerIcon size={14} /> : <UploadIcon size={14} />}
                      {logoUploading ? 'Uploading…' : 'Upload Logo'}
                      <input type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" style={{ display: 'none' }} onChange={handleLogoUpload} disabled={logoUploading} />
                    </label>
                    {logoPreview && (
                      <p style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: '0.68rem', color: '#4caf50', margin: '6px 0 0', fontWeight: 600 }}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                        Logo uploaded
                      </p>
                    )}
                  </div>
                </div>
              </div>

              <div>
                <label style={labelStyle}>Company Name *</label>
                <input style={inputStyle} value={editForm.name} onChange={e => setEditForm({ ...editForm, name: e.target.value })} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={labelStyle}>PR Number</label>
                  <input style={inputStyle} value={editForm.pr_number} onChange={e => setEditForm({ ...editForm, pr_number: e.target.value })} />
                </div>
                <div>
                  <label style={labelStyle}>Phone</label>
                  <input style={inputStyle} value={editForm.phone} onChange={e => setEditForm({ ...editForm, phone: e.target.value })} />
                </div>
              </div>
              <div>
                <label style={labelStyle}>Email</label>
                <input style={inputStyle} type="email" value={editForm.email} onChange={e => setEditForm({ ...editForm, email: e.target.value })} />
              </div>
              <div>
                <label style={labelStyle}>Physical Address</label>
                <input style={inputStyle} value={editForm.address} onChange={e => setEditForm({ ...editForm, address: e.target.value })} />
              </div>
              <div>
                <label style={labelStyle}>Latest PRF Number</label>
                {/* Accepts the keyword+number form used to categorise PRFs — the counter is seeded from the digits (EL30 → 30, next PRF 31). */}
                <input
                  style={inputStyle}
                  type="text"
                  value={editForm.prfNumber}
                  onChange={e => setEditForm({ ...editForm, prfNumber: e.target.value })}
                />
              </div>
              <div>
                <label style={labelStyle}>PRF Name</label>
                <input
                  style={inputStyle}
                  value={editForm.prf_name}
                  onChange={e => setEditForm({ ...editForm, prf_name: e.target.value })}
                />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 8, background: 'var(--surface-100)', border: '1px solid var(--surface-200)' }}>
                <input
                  id="edit-is-active"
                  type="checkbox"
                  checked={editForm.is_active}
                  onChange={e => setEditForm({ ...editForm, is_active: e.target.checked })}
                  style={{ width: 16, height: 16, cursor: 'pointer', accentColor: teal }}
                />
                <label htmlFor="edit-is-active" style={{ fontSize: '0.83rem', fontWeight: 600, color: 'var(--text)', cursor: 'pointer', margin: 0 }}>
                  Client is Active
                </label>
              </div>

              {/* ── EMSMCA Client Login ── */}
              <div style={{ background: 'var(--surface-50)', padding: '14px 16px', borderRadius: 10, border: '1px solid var(--surface-200)' }}>
                <div style={{ fontSize: '0.7rem', fontWeight: 800, color: teal, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>EMSMCA Client Login</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div>
                    <label style={labelStyle}>Username</label>
                    <input
                      style={inputStyle}
                      value={editForm.portal_username}
                      onChange={e => setEditForm({ ...editForm, portal_username: e.target.value })}
                      autoComplete="off" data-lpignore="true" data-form-type="other"
                    />
                  </div>
                  <div>
                    <label style={labelStyle}>Password</label>
                    <input
                      style={inputStyle}
                      type="password"
                      value={editForm.portal_password}
                      onChange={e => setEditForm({ ...editForm, portal_password: e.target.value })}
                      autoComplete="new-password" data-lpignore="true" data-form-type="other"
                    />
                  </div>
                </div>
              </div>

              {/* ── Portal Admin Login ── */}
              <div style={{ background: 'var(--surface-50)', padding: '14px 16px', borderRadius: 10, border: '1px solid var(--surface-200)' }}>
                <div style={{ fontSize: '0.7rem', fontWeight: 800, color: '#2563eb', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>Portal Admin Login</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div>
                    <label style={labelStyle}>Admin Email</label>
                    <input
                      style={inputStyle}
                      type="email"
                      value={editForm.admin_email}
                      onChange={e => setEditForm({ ...editForm, admin_email: e.target.value })}
                      autoComplete="off" data-lpignore="true" data-form-type="other"
                    />
                  </div>
                  <div>
                    <label style={labelStyle}>Admin Password</label>
                    <input
                      style={inputStyle}
                      type="password"
                      value={editForm.admin_password}
                      onChange={e => setEditForm({ ...editForm, admin_password: e.target.value })}
                      autoComplete="new-password" data-lpignore="true" data-form-type="other"
                    />
                  </div>
                </div>
              </div>
            </div>

            <div style={{ marginTop: 24 }}>
              {!showDeleteConfirm ? (
                <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', alignItems: 'center' }}>
                  <button
                    onClick={() => { setShowDeleteConfirm(true); setDeleteConfirmText(''); }}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 7, background: 'none', border: '1px solid #e53e3e', borderRadius: 8, color: '#e53e3e', padding: '8px 14px', fontSize: '0.78rem', fontWeight: 700, cursor: 'pointer' }}
                  >
                    <TrashIcon size={14} /> Delete Client
                  </button>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button style={{ ...btnPrimary, background: 'var(--surface-200)', color: 'var(--text)' }} onClick={() => setShowEditClient(false)}>Cancel</button>
                    <button style={{ ...btnPrimary, opacity: editSaving ? 0.6 : 1 }} onClick={handleSaveClient} disabled={editSaving}>
                      {editSaving ? 'Saving…' : 'Save Changes'}
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{ background: 'rgba(229,62,62,0.06)', border: '1px solid rgba(229,62,62,0.3)', borderRadius: 10, padding: '16px' }}>
                  <p style={{ display: 'flex', alignItems: 'flex-start', gap: 7, fontSize: '0.82rem', fontWeight: 700, color: '#e53e3e', margin: '0 0 4px' }}><span style={{ flexShrink: 0, marginTop: 1 }}><WarnIcon size={15} /></span> This will permanently delete this client and ALL their crew, vehicles, and PRFs.</p>
                  <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '0 0 12px' }}>Type <strong>{selectedProvider?.name}</strong> to confirm:</p>
                  <input
                    style={{ ...inputStyle, marginBottom: 12, borderColor: 'rgba(229,62,62,0.4)' }}
                    placeholder={selectedProvider?.name}
                    value={deleteConfirmText}
                    onChange={e => setDeleteConfirmText(e.target.value)}
                  />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      onClick={handleDeleteClient}
                      disabled={deleteConfirmText !== selectedProvider?.name || deleting}
                      style={{ ...btnPrimary, background: deleteConfirmText === selectedProvider?.name ? '#e53e3e' : 'var(--surface-200)', color: deleteConfirmText === selectedProvider?.name ? '#fff' : 'var(--text-muted)', opacity: deleting ? 0.6 : 1 }}
                    >
                      {deleting ? 'Deleting…' : 'Permanently Delete'}
                    </button>
                    <button style={{ ...btnPrimary, background: 'var(--surface-200)', color: 'var(--text)' }} onClick={() => setShowDeleteConfirm(false)}>Cancel</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <button onClick={() => { setSelectedProvider(null); fetchProviders(); }} title="Back to clients" style={{ background: 'none', border: 'none', cursor: 'pointer', color: teal, display: 'inline-flex', alignItems: 'center', padding: 4 }}><BackIcon size={20} /></button>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <h1 style={{ fontSize: '1.3rem', fontWeight: 800, margin: 0, color: 'var(--text)' }}>{selectedProvider.name}</h1>
            <button
              id="edit-client-settings-btn"
              onClick={openEditClient}
              title="Edit client settings"
              style={{
                background: 'none',
                border: '1px solid var(--surface-200)',
                borderRadius: 6,
                cursor: 'pointer',
                color: 'var(--text-muted)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '4px 6px',
                transition: 'all 0.15s',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = teal; (e.currentTarget as HTMLButtonElement).style.borderColor = teal; (e.currentTarget as HTMLButtonElement).style.background = 'rgba(8,131,149,0.06)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)'; (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--surface-200)'; (e.currentTarget as HTMLButtonElement).style.background = 'none'; }}
            >
              <GearIcon size={14} />
            </button>
          </div>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: 0 }}>
            /{selectedProvider.slug}/crew • PR: {selectedProvider.pr_number || '—'} • {selectedProvider.phone || '—'}
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '2px solid var(--surface-100)', paddingBottom: 0 }}>
        {(['crew', 'vehicles'] as const).map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)} style={{
            display: 'inline-flex', alignItems: 'center', gap: 8,
            padding: '8px 20px', fontSize: '0.82rem', fontWeight: 700, cursor: 'pointer',
            border: 'none', borderBottom: activeTab === tab ? `2px solid ${teal}` : '2px solid transparent',
            background: 'transparent', color: activeTab === tab ? teal : 'var(--text-muted)',
            textTransform: 'uppercase', letterSpacing: '0.06em',
          }}>
            {tab === 'crew'
              ? <><UsersIcon size={15} /> Crew ({crew.length})</>
              : <><AmbulanceIcon size={16} /> Vehicles ({vehicles.length})</>}
          </button>
        ))}
      </div>

      {crewLoading ? (
        <div style={{ textAlign: 'center', padding: 30, color: 'var(--text-muted)' }}>Loading...</div>
      ) : activeTab === 'crew' ? (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>{crew.length} crew member{crew.length !== 1 ? 's' : ''}</span>
            <button style={btnPrimary} onClick={() => { setShowAddCrew(true); setTempPassword(''); }}>+ Add Crew</button>
          </div>

          {showAddCrew && (
            <div
              style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000, padding: 16 }}
              onClick={e => { if (e.target === e.currentTarget) closeAddCrew(); }}
            >
              <div style={{
                background: 'var(--surface-50)', borderRadius: 16,
                border: '1px solid var(--surface-100)',
                boxShadow: '0 24px 60px rgba(0,0,0,0.28), 0 4px 14px rgba(0,0,0,0.12)',
                width: '100%', maxWidth: 480, maxHeight: '90vh', overflowY: 'auto',
                position: 'relative',
              }}>
                {/* Header */}
                <div style={{ padding: '22px 26px 16px', borderBottom: '1px solid var(--surface-100)' }}>
                  <div style={{ fontSize: '1.02rem', fontWeight: 800, color: 'var(--text)', letterSpacing: '-0.01em' }}>Add Crew Member</div>
                  <button
                    onClick={closeAddCrew}
                    aria-label="Close"
                    style={{
                      position: 'absolute', top: 16, right: 18,
                      width: 30, height: 30, borderRadius: 8,
                      border: '1px solid var(--surface-200)', background: 'var(--bg)',
                      color: 'var(--text-muted)', fontSize: '1.15rem', lineHeight: 1,
                      cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
                    }}
                  >&times;</button>
                </div>

                {/* Body */}
                <div style={{ padding: '20px 26px 4px' }}>
                  <div style={{ marginBottom: 4 }}>
                    <label style={labelStyle}>Full Name *</label>
                    <input style={inputStyle} value={newCrew.full_name} onChange={e => setNewCrew({ ...newCrew, full_name: e.target.value })} />
                  </div>
                  <div style={{ marginBottom: 4 }}>
                    <label style={labelStyle}>Email *</label>
                    <input style={inputStyle} value={newCrew.email} onChange={e => setNewCrew({ ...newCrew, email: e.target.value })} />
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 14px' }}>
                    <div><label style={labelStyle}>Initials</label><input style={inputStyle} value={newCrew.initials} onChange={e => setNewCrew({ ...newCrew, initials: e.target.value })} /></div>
                    <div><label style={labelStyle}>HPCSA Number</label><input style={inputStyle} value={newCrew.hpcsa_number} onChange={e => setNewCrew({ ...newCrew, hpcsa_number: e.target.value })} /></div>
                    <div>
                      <label style={labelStyle}>Qualification</label>
                      <select style={inputStyle} value={newCrew.qualification} onChange={e => setNewCrew({ ...newCrew, qualification: e.target.value })}>
                        <option value="BLS">BLS</option>
                        <option value="ILS">ILS</option>
                        <option value="ALS">ALS</option>
                        <option value="AEA">AEA</option>
                        <option value="BAA">BAA</option>
                        <option value="ECP">ECP</option>
                        <option value="ART">ART</option>
                      </select>
                    </div>
                    <div><label style={labelStyle}>Phone</label><input style={inputStyle} value={newCrew.phone} onChange={e => setNewCrew({ ...newCrew, phone: e.target.value })} /></div>
                  </div>

                  {tempPassword && (
                    <div style={{ padding: '12px 14px', borderRadius: 10, background: 'rgba(8,131,149,0.08)', border: `1px solid rgba(8,131,149,0.2)`, marginTop: 8 }}>
                      <div style={{ fontSize: '0.68rem', fontWeight: 800, color: teal, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Temporary Password</div>
                      <div style={{ fontSize: '1.05rem', fontWeight: 800, fontFamily: 'monospace', color: 'var(--text)', marginTop: 4 }}>{tempPassword}</div>
                    </div>
                  )}
                </div>

                {/* Footer */}
                <div style={{ display: 'flex', gap: 10, padding: '16px 26px 22px' }}>
                  <button style={{ ...btnPrimary, background: 'var(--surface-100)', color: 'var(--text)', flex: 1, padding: '10px 18px' }} onClick={closeAddCrew}>Cancel</button>
                  <button style={{ ...btnPrimary, flex: 2, padding: '10px 18px' }} onClick={handleAddCrew}>Add Crew Member</button>
                </div>
              </div>
            </div>
          )}

          {showEditCrew && (
            <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
              <div style={{ ...cardStyle, width: '100%', maxWidth: 500, padding: 0, display: 'flex', flexDirection: 'column', maxHeight: '90vh' }}>
                <div style={{ padding: '20px 26px 16px', borderBottom: '1px solid var(--surface-100)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h3 style={{ fontSize: '1.05rem', fontWeight: 800, color: 'var(--text)' }}>Edit Crew Member</h3>
                  <button onClick={closeEditCrew} style={{ background: 'none', border: 'none', fontSize: '1.4rem', color: 'var(--text-muted)', cursor: 'pointer', lineHeight: 1 }}>&times;</button>
                </div>
                
                <div style={{ padding: '20px 26px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 14px' }}>
                    <div style={{ gridColumn: '1 / -1' }}><label style={labelStyle}>Full Name *</label><input style={inputStyle} value={editCrewForm.full_name} onChange={e => setEditCrewForm({ ...editCrewForm, full_name: e.target.value })} /></div>
                    <div style={{ gridColumn: '1 / -1' }}><label style={labelStyle}>Email (for Portal Login) *</label><input style={inputStyle} value={editCrewForm.email} onChange={e => setEditCrewForm({ ...editCrewForm, email: e.target.value })} /></div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 14px' }}>
                    <div><label style={labelStyle}>Initials</label><input style={inputStyle} value={editCrewForm.initials} onChange={e => setEditCrewForm({ ...editCrewForm, initials: e.target.value })} /></div>
                    <div><label style={labelStyle}>HPCSA Number</label><input style={inputStyle} value={editCrewForm.hpcsa_number} onChange={e => setEditCrewForm({ ...editCrewForm, hpcsa_number: e.target.value })} /></div>
                    <div>
                      <label style={labelStyle}>Qualification</label>
                      <select style={inputStyle} value={editCrewForm.qualification} onChange={e => setEditCrewForm({ ...editCrewForm, qualification: e.target.value })}>
                        <option value="BLS">BLS</option>
                        <option value="ILS">ILS</option>
                        <option value="ALS">ALS</option>
                        <option value="AEA">AEA</option>
                        <option value="BAA">BAA</option>
                        <option value="ECP">ECP</option>
                        <option value="ART">ART</option>
                      </select>
                    </div>
                    <div><label style={labelStyle}>Phone</label><input style={inputStyle} value={editCrewForm.phone} onChange={e => setEditCrewForm({ ...editCrewForm, phone: e.target.value })} /></div>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 10, padding: '16px 26px 22px' }}>
                  <button style={{ ...btnPrimary, background: 'var(--surface-100)', color: 'var(--text)', flex: 1, padding: '10px 18px' }} onClick={closeEditCrew}>Cancel</button>
                  <button style={{ ...btnPrimary, flex: 2, padding: '10px 18px' }} onClick={handleSaveCrew} disabled={editCrewSaving}>
                    {editCrewSaving ? 'Saving...' : 'Save Changes'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Crew Table */}
          <div style={{ ...cardStyle, padding: 0, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.86rem' }}>
              <thead>
                <tr style={{ background: 'var(--surface-100)', textAlign: 'left' }}>
                  <th style={{ padding: '12px 18px', fontWeight: 700, fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)' }}>Crew Member</th>
                  <th style={{ padding: '12px 18px', fontWeight: 700, fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)' }}>HPCSA #</th>
                  <th style={{ padding: '12px 18px', fontWeight: 700, fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', textAlign: 'right' }} />
                </tr>
              </thead>
              <tbody>
                {crew.map(c => (
                  <tr key={c.id} className="pm-row" style={{ borderBottom: '1px solid var(--surface-100)' }}>
                    <td style={{ padding: '12px 18px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <span style={{
                          width: 38, height: 38, borderRadius: '50%', flexShrink: 0,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          background: 'rgba(8,131,149,0.1)', color: teal,
                          fontSize: '0.82rem', fontWeight: 800, letterSpacing: '0.02em',
                        }}>
                          {(c.initials || c.full_name.split(' ').map(p => p[0]).join('').slice(0, 2) || '—').toUpperCase()}
                        </span>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 700, color: 'var(--text)', fontSize: '0.9rem' }}>{c.full_name}</div>
                          {c.phone && (
                            <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', marginTop: 1 }}>{c.phone}</div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td style={{ padding: '12px 18px', fontFamily: 'monospace', fontSize: '0.82rem', color: 'var(--text-muted)' }}>{c.hpcsa_number || '—'}</td>
                    <td style={{ padding: '12px 18px', textAlign: 'right' }}>
                      <button
                        onClick={() => openEditCrew(c)}
                        title="Edit crew member"
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'inline-flex', padding: 6, borderRadius: 8, transition: 'all 0.15s', marginRight: 4 }}
                        onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = teal; (e.currentTarget as HTMLButtonElement).style.background = 'rgba(8,131,149,0.08)'; }}
                        onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)'; (e.currentTarget as HTMLButtonElement).style.background = 'none'; }}
                      >
                        <EditIcon size={16} />
                      </button>
                      <button
                        onClick={() => handleDeleteCrew(c.id)}
                        title="Delete crew member"
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'inline-flex', padding: 6, borderRadius: 8, transition: 'all 0.15s' }}
                        onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = rose; (e.currentTarget as HTMLButtonElement).style.background = 'rgba(194,24,91,0.08)'; }}
                        onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)'; (e.currentTarget as HTMLButtonElement).style.background = 'none'; }}
                      >
                        <TrashIcon size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
                {crew.length === 0 && (
                  <tr><td colSpan={3} style={{ padding: 28, textAlign: 'center', color: 'var(--text-muted)' }}>No crew members yet</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>{vehicles.length} vehicle{vehicles.length !== 1 ? 's' : ''}</span>
            <button style={btnPrimary} onClick={() => setShowAddVehicle(true)}>+ Add Vehicle</button>
          </div>

          {showAddVehicle && (
            <div
              style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000, padding: 16 }}
              onClick={e => { if (e.target === e.currentTarget) closeAddVehicle(); }}
            >
              <div style={{
                background: 'var(--surface-50)', borderRadius: 16,
                border: '1px solid var(--surface-100)',
                boxShadow: '0 24px 60px rgba(0,0,0,0.28), 0 4px 14px rgba(0,0,0,0.12)',
                width: '100%', maxWidth: 480, maxHeight: '90vh', overflowY: 'auto',
                position: 'relative',
              }}>
                {/* Header */}
                <div style={{ padding: '22px 26px 16px', borderBottom: '1px solid var(--surface-100)' }}>
                  <div style={{ fontSize: '1.02rem', fontWeight: 800, color: 'var(--text)', letterSpacing: '-0.01em' }}>Add Vehicle</div>
                  <button
                    onClick={closeAddVehicle}
                    aria-label="Close"
                    style={{
                      position: 'absolute', top: 16, right: 18,
                      width: 30, height: 30, borderRadius: 8,
                      border: '1px solid var(--surface-200)', background: 'var(--bg)',
                      color: 'var(--text-muted)', fontSize: '1.15rem', lineHeight: 1,
                      cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
                    }}
                  >&times;</button>
                </div>

                {/* Body */}
                <div style={{ padding: '20px 26px 4px' }}>
                  <div style={{ marginBottom: 4 }}>
                    <label style={labelStyle}>Callsign *</label>
                    <input style={inputStyle} value={newVehicle.callsign} onChange={e => setNewVehicle({ ...newVehicle, callsign: e.target.value })} />
                  </div>
                  <div style={{ marginBottom: 4 }}>
                    <label style={labelStyle}>Registration *</label>
                    <input style={inputStyle} value={newVehicle.registration} onChange={e => setNewVehicle({ ...newVehicle, registration: e.target.value })} />
                  </div>
                  <div>
                    <label style={labelStyle}>Type</label>
                    <select style={inputStyle} value={newVehicle.vehicle_type} onChange={e => setNewVehicle({ ...newVehicle, vehicle_type: e.target.value })}>
                      <option value="Ambulance">Ambulance</option>
                      <option value="Response Vehicle">Response Vehicle</option>
                      <option value="Helicopter">Helicopter</option>
                    </select>
                  </div>
                </div>

                {/* Footer */}
                <div style={{ display: 'flex', gap: 10, padding: '16px 26px 22px' }}>
                  <button style={{ ...btnPrimary, background: 'var(--surface-100)', color: 'var(--text)', flex: 1, padding: '10px 18px' }} onClick={closeAddVehicle}>Cancel</button>
                  <button style={{ ...btnPrimary, flex: 2, padding: '10px 18px' }} onClick={handleAddVehicle}>Add Vehicle</button>
                </div>
              </div>
            </div>
          )}

          {showEditVehicle && (
            <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
              <div style={{ ...cardStyle, width: '100%', maxWidth: 450, padding: 0, display: 'flex', flexDirection: 'column', maxHeight: '90vh' }}>
                <div style={{ padding: '20px 26px 16px', borderBottom: '1px solid var(--surface-100)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h3 style={{ fontSize: '1.05rem', fontWeight: 800, color: 'var(--text)' }}>Edit Vehicle</h3>
                  <button onClick={closeEditVehicle} style={{ background: 'none', border: 'none', fontSize: '1.4rem', color: 'var(--text-muted)', cursor: 'pointer', lineHeight: 1 }}>&times;</button>
                </div>
                
                <div style={{ padding: '20px 26px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <div><label style={labelStyle}>Callsign *</label><input style={inputStyle} value={editVehicleForm.callsign} onChange={e => setEditVehicleForm({ ...editVehicleForm, callsign: e.target.value })} /></div>
                  <div><label style={labelStyle}>Registration *</label><input style={inputStyle} value={editVehicleForm.registration} onChange={e => setEditVehicleForm({ ...editVehicleForm, registration: e.target.value })} /></div>
                  <div>
                    <label style={labelStyle}>Vehicle Type</label>
                    <select style={inputStyle} value={editVehicleForm.vehicle_type} onChange={e => setEditVehicleForm({ ...editVehicleForm, vehicle_type: e.target.value })}>
                      <option value="Ambulance">Ambulance</option>
                      <option value="Response Vehicle">Response Vehicle</option>
                      <option value="Rescue Vehicle">Rescue Vehicle</option>
                      <option value="Helicopter">Helicopter</option>
                      <option value="Fixed Wing">Fixed Wing</option>
                    </select>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 10, padding: '16px 26px 22px' }}>
                  <button style={{ ...btnPrimary, background: 'var(--surface-100)', color: 'var(--text)', flex: 1, padding: '10px 18px' }} onClick={closeEditVehicle}>Cancel</button>
                  <button style={{ ...btnPrimary, flex: 2, padding: '10px 18px' }} onClick={handleSaveVehicle} disabled={editVehicleSaving}>
                    {editVehicleSaving ? 'Saving...' : 'Save Changes'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Vehicle Table */}
          <div style={{ ...cardStyle, padding: 0, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.86rem' }}>
              <thead>
                <tr style={{ background: 'var(--surface-100)', textAlign: 'left' }}>
                  <th style={{ padding: '12px 18px', fontWeight: 700, fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)' }}>Callsign</th>
                  <th style={{ padding: '12px 18px', fontWeight: 700, fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)' }}>Registration</th>
                  <th style={{ padding: '12px 18px', fontWeight: 700, fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)' }}>Type</th>
                  <th style={{ padding: '12px 18px', fontWeight: 700, fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', textAlign: 'right' }} />
                </tr>
              </thead>
              <tbody>
                {vehicles.map(v => (
                  <tr key={v.id} className="pm-row" style={{ borderBottom: '1px solid var(--surface-100)' }}>
                    <td style={{ padding: '12px 18px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <span style={{
                          width: 38, height: 38, borderRadius: 10, flexShrink: 0,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          background: 'rgba(230,81,0,0.1)', color: '#E65100',
                        }}>
                          <AmbulanceIcon size={20} />
                        </span>
                        <span style={{ fontWeight: 700, color: 'var(--text)' }}>{v.callsign}</span>
                      </div>
                    </td>
                    <td style={{ padding: '12px 18px', fontFamily: 'monospace', color: 'var(--text-muted)' }}>{v.registration}</td>
                    <td style={{ padding: '12px 18px', color: 'var(--text-muted)' }}>{v.vehicle_type}</td>
                    <td style={{ padding: '12px 18px', textAlign: 'right' }}>
                      <button
                        onClick={() => openEditVehicle(v)}
                        title="Edit vehicle"
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'inline-flex', padding: 6, borderRadius: 8, transition: 'all 0.15s', marginRight: 4 }}
                        onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = '#E65100'; (e.currentTarget as HTMLButtonElement).style.background = 'rgba(230,81,0,0.08)'; }}
                        onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)'; (e.currentTarget as HTMLButtonElement).style.background = 'none'; }}
                      >
                        <EditIcon size={16} />
                      </button>
                      <button
                        onClick={() => handleDeleteVehicle(v.id)}
                        title="Delete vehicle"
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'inline-flex', padding: 6, borderRadius: 8, transition: 'all 0.15s' }}
                        onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = rose; (e.currentTarget as HTMLButtonElement).style.background = 'rgba(194,24,91,0.08)'; }}
                        onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)'; (e.currentTarget as HTMLButtonElement).style.background = 'none'; }}
                      >
                        <TrashIcon size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
                {vehicles.length === 0 && (
                  <tr><td colSpan={4} style={{ padding: 28, textAlign: 'center', color: 'var(--text-muted)' }}>No vehicles yet</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
