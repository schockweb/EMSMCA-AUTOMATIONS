/**
 * ProviderLogin — Company-gated login portal for a service provider.
 * Uses the premium glassmorphism dark-mode global login style.
 */
import { useState, useEffect } from 'react';
import type { FormEvent } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import axios from 'axios';

interface ProviderInfo {
  name: string;
  slug: string;
  logo_url: string | null;
  pr_number: string | null;
}

interface CrewOption {
  id: string;
  full_name: string;
  qualification: string;
  hpcsa_number: string | null;
}

interface VehicleOption {
  id: string;
  callsign: string;
  registration_number: string;
}

export default function ProviderLogin() {
  const { providerSlug } = useParams<{ providerSlug: string }>();
  const navigate = useNavigate();

  const [providerInfo, setProviderInfo] = useState<ProviderInfo | null>(null);

  // Admin login fields
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [adminError, setAdminError] = useState('');
  const [adminLoading, setAdminLoading] = useState(false);

  // Crew shift start
  const [crewList, setCrewList] = useState<CrewOption[]>([]);
  const [vehicleList, setVehicleList] = useState<VehicleOption[]>([]);
  const [selectedCrewId, setSelectedCrewId] = useState('');
  const [selectedPartnerId, setSelectedPartnerId] = useState('');
  const [selectedVehicleId, setSelectedVehicleId] = useState('');
  const [shiftLoading, setShiftLoading] = useState(false);
  const [shiftError, setShiftError] = useState('');

  // Lock body scroll on mount
  useEffect(() => {
    const prevHtml = document.documentElement.style.overflow;
    const prevBody = document.body.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    return () => {
      document.documentElement.style.overflow = prevHtml;
      document.body.style.overflow = prevBody;
    };
  }, []);

  // Pre-load provider logo/name
  useEffect(() => {
    if (!providerInfo && providerSlug) {
      axios.get('/api/providers/public')
        .then(res => {
          const p = res.data.find((p: any) => p.slug === providerSlug);
          if (p) setProviderInfo({ name: p.name, slug: p.slug, logo_url: p.logo_url, pr_number: null });
        }).catch(() => {});
    }
  }, [providerSlug, providerInfo]);

  // Load crew and vehicle list
  useEffect(() => {
    if (!providerSlug) return;
    axios.get(`/api/providers/${providerSlug}/public-crew`)
      .then(res => setCrewList(res.data))
      .catch(() => {});
    axios.get(`/api/providers/${providerSlug}/public-vehicles`)
      .then(res => setVehicleList(res.data))
      .catch(() => {});
  }, [providerSlug]);

  // ── Admin Login ──
  const handleAdminLogin = async (e: FormEvent) => {
    e.preventDefault();
    setAdminError('');
    setAdminLoading(true);
    try {
      const res = await axios.post('/api/crew/login', {
        email: adminEmail.trim(),
        password: adminPassword,
      });
      const data = res.data;
      // Store as crew_token + crew_profile — ProviderAdminDashboard reads these keys
      localStorage.setItem('crew_token', data.access_token);
      localStorage.setItem('crew_profile', JSON.stringify({
        id: data.crew_id,
        name: data.crew_name,
        provider_id: data.provider_id,
        provider_name: data.provider_name,
        provider_slug: data.provider_slug,
        qualification: data.qualification,
        hpcsa_number: data.hpcsa_number,
        role: data.role,
      }));
      navigate(`/${providerSlug}/admin/dashboard`);
    } catch (err: any) {
      setAdminError(err.response?.data?.detail || 'Invalid admin credentials');
    }
    setAdminLoading(false);
  };

  // ── Step 2b: Crew Shift Start ──
  const handleStartShift = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedCrewId) { setShiftError('Please select your name.'); return; }
    if (!selectedVehicleId) { setShiftError('Please select an ambulance.'); return; }
    setShiftError('');
    setShiftLoading(true);
    try {
      const partnerName = crewList.find(c => c.id === selectedPartnerId)?.full_name || '';
      const vehicleCallsign = vehicleList.find(v => v.id === selectedVehicleId)?.callsign || '';
      const res = await axios.post('/api/crew/shift-start-by-id', {
        crew_id: selectedCrewId,
        provider_slug: providerSlug,
        partner_name: partnerName || undefined,
        vehicle_id: selectedVehicleId,
        vehicle_callsign: vehicleCallsign,
      });
      const data = res.data;
      localStorage.setItem('crew_token', data.access_token);
      localStorage.setItem('crew_profile', JSON.stringify({
        id: data.crew_id,
        name: data.full_name,
        provider_id: data.provider_id,
        provider_name: data.provider_name,
        provider_slug: data.provider_slug,
        qualification: data.qualification,
        hpcsa_number: data.hpcsa_number,
        role: data.role,
        partner_name: data.partner_name || '',
        vehicle_id: data.vehicle_id || '',
        vehicle_callsign: data.vehicle_callsign || '',
      }));
      navigate(`/${providerSlug}/crew/dashboard`);
    } catch (err: any) {
      setShiftError(err.response?.data?.detail || 'Failed to start shift. Try again.');
    }
    setShiftLoading(false);
  };

  return (
    <div className="login-page" style={{ overflowY: 'auto', position: 'relative' }}>
      
      {/* ── BACK BUTTON ── */}
      <button
        onClick={() => navigate('/login')}
        style={{
          position: 'absolute',
          top: '24px',
          left: '24px',
          background: 'rgba(255, 255, 255, 0.8)',
          backdropFilter: 'blur(10px)',
          border: '1px solid var(--glass-border)',
          borderRadius: '8px',
          padding: '8px 16px',
          color: 'var(--text-secondary)',
          fontSize: '0.85rem',
          fontWeight: 600,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          boxShadow: '0 2px 10px rgba(0,0,0,0.05)',
          transition: 'all 0.2s ease',
          zIndex: 10
        }}
        onMouseEnter={e => {
          e.currentTarget.style.background = '#ffffff';
          e.currentTarget.style.color = 'var(--text-primary)';
          e.currentTarget.style.boxShadow = '0 4px 15px rgba(0,0,0,0.1)';
        }}
        onMouseLeave={e => {
          e.currentTarget.style.background = 'rgba(255, 255, 255, 0.8)';
          e.currentTarget.style.color = 'var(--text-secondary)';
          e.currentTarget.style.boxShadow = '0 2px 10px rgba(0,0,0,0.05)';
        }}
      >
        <span>←</span> Back
      </button>

      <div className="login-card" style={{ margin: '80px 16px 40px 16px', width: '100%', maxWidth: '400px' }}>
        
        {/* Provider Logo Header */}
        <div className="login-logo" style={{ marginBottom: '48px' }}>
          {providerInfo?.logo_url ? (
            <img src={providerInfo.logo_url} alt={providerInfo.name} style={{ height: 80, objectFit: 'contain', marginBottom: 16 }} />
          ) : (
            <h1 style={{ marginBottom: 16 }}>{providerInfo?.name || 'Company Portal'}</h1>
          )}
          <p style={{ textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 700, fontSize: '0.8rem', color: '#088395' }}>
            Administration Portal
          </p>
        </div>

        {/* ── ADMIN LOGIN + SHIFT START ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '32px' }}>
            
            {/* Admin Login Section */}
            <div>
              <div style={{ fontSize: '0.85rem', fontWeight: 800, color: '#1f2937', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '1.1rem' }}>🔐</span> Admin Login
              </div>
              {adminError && <div className="login-error">{adminError}</div>}
              <form onSubmit={handleAdminLogin}>
                <div className="input-group" style={{ marginBottom: '12px' }}>
                  <input
                    type="text"
                    className="input"
                    placeholder="Admin Email"
                    value={adminEmail}
                    onChange={e => setAdminEmail(e.target.value)}
                    required
                  />
                </div>
                <div className="input-group" style={{ marginBottom: '16px' }}>
                  <input
                    type="password"
                    className="input"
                    placeholder="Password"
                    value={adminPassword}
                    onChange={e => setAdminPassword(e.target.value)}
                    required
                  />
                </div>
                <button type="submit" className="btn btn-primary btn-lg" style={{ width: '100%' }} disabled={adminLoading}>
                  {adminLoading ? 'Signing In...' : 'Sign In as Admin'}
                </button>
              </form>
            </div>

            {/* Divider */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ flex: 1, height: 1, background: 'var(--glass-border)' }} />
              <span style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Crew Access</span>
              <div style={{ flex: 1, height: 1, background: 'var(--glass-border)' }} />
            </div>

            {/* Start Shift Section */}
            <div>
              <div style={{ fontSize: '0.85rem', fontWeight: 800, color: '#1f2937', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '1.1rem' }}>🚑</span> Start Shift
              </div>
              {shiftError && <div className="login-error">{shiftError}</div>}
              <form onSubmit={handleStartShift}>
                <div className="input-group" style={{ marginBottom: '12px' }}>
                  <label className="input-label" style={{ fontSize: '0.75rem' }}>Your Name *</label>
                  <select className="input" value={selectedCrewId} onChange={e => setSelectedCrewId(e.target.value)} required>
                    <option value="">— Select your name —</option>
                    {crewList.map(c => (
                      <option key={c.id} value={c.id}>{c.full_name} ({c.qualification})</option>
                    ))}
                  </select>
                </div>

                <div className="input-group" style={{ marginBottom: '12px' }}>
                  <label className="input-label" style={{ fontSize: '0.75rem' }}>Person Assisting (Partner)</label>
                  <select className="input" value={selectedPartnerId} onChange={e => setSelectedPartnerId(e.target.value)}>
                    <option value="">— Select partner (optional) —</option>
                    {crewList.filter(c => c.id !== selectedCrewId).map(c => (
                      <option key={c.id} value={c.id}>{c.full_name} ({c.qualification})</option>
                    ))}
                  </select>
                </div>

                <div className="input-group" style={{ marginBottom: '16px' }}>
                  <label className="input-label" style={{ fontSize: '0.75rem' }}>Ambulance *</label>
                  <select className="input" value={selectedVehicleId} onChange={e => setSelectedVehicleId(e.target.value)} required>
                    <option value="">— Select ambulance —</option>
                    {vehicleList.map(v => (
                      <option key={v.id} value={v.id}>{v.callsign} ({v.registration_number})</option>
                    ))}
                  </select>
                </div>

                <button type="submit" className="btn btn-accent btn-lg" style={{ width: '100%' }} disabled={shiftLoading || !selectedCrewId || !selectedVehicleId}>
                  {shiftLoading ? 'Starting Shift...' : 'Start New Shift →'}
                </button>
              </form>
            </div>

          </div>

      </div>
    </div>
  );
}
