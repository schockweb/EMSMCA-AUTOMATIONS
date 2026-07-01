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
  const [shiftStep, setShiftStep] = useState<1 | 2>(1);
  const [selectedVehicleId, setSelectedVehicleId] = useState('');
  const [selectedCrewIds, setSelectedCrewIds] = useState<string[]>([]);
  const [shiftLoading, setShiftLoading] = useState(false);
  const [shiftError, setShiftError] = useState('');
  const [showShiftForm, setShowShiftForm] = useState(false);

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
    if (selectedCrewIds.length === 0) { setShiftError('Please select at least one crew member.'); return; }
    
    const primaryCrewId = selectedCrewIds[0];
    const assistingCrewIds = selectedCrewIds.slice(1);
    const partnerId = assistingCrewIds.length > 0 ? assistingCrewIds[0] : null;
    const partnerName = partnerId ? (crewList.find(c => c.id === partnerId)?.full_name || '') : '';
    const vehicleCallsign = vehicleList.find(v => v.id === selectedVehicleId)?.callsign || '';

    setShiftError('');
    setShiftLoading(true);
    try {
      const res = await axios.post('/api/crew/shift-start-by-id', {
        crew_id: primaryCrewId,
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

      // Store partner profile for Digital PRF
      if (partnerId) {
         const p = crewList.find(c => c.id === partnerId);
         if (p) localStorage.setItem('crew2_profile', JSON.stringify(p));
      } else {
         localStorage.removeItem('crew2_profile');
      }
      
      // Store any 3rd, 4th, etc. extra crew members
      const extraCrew = assistingCrewIds.slice(1).map(id => crewList.find(c => c.id === id)).filter(Boolean);
      if (extraCrew.length > 0) {
         localStorage.setItem('extra_crew_profiles', JSON.stringify(extraCrew));
      } else {
         localStorage.removeItem('extra_crew_profiles');
      }

      navigate(`/${providerSlug}/crew/dashboard`);
    } catch (err: any) {
      setShiftError(err.response?.data?.detail || 'Failed to start shift. Try again.');
    }
    setShiftLoading(false);
  };

  const toggleCrewSelection = (id: string) => {
    setSelectedCrewIds(prev => 
      prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id]
    );
  };

  return (
    <div className="login-page" style={{ overflowY: 'auto' }}>
      
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

      <div className="login-card" style={{ margin: '80px 0 40px 0', width: '100%', maxWidth: '440px', boxSizing: 'border-box' }}>
        
        {/* Provider Logo Header */}
        <div className="login-logo" style={{ marginBottom: '24px' }}>
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
              <div style={{ fontSize: '0.85rem', fontWeight: 800, color: '#1f2937', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '16px' }}>
                Admin Login
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

            {/* Start Shift Button */}
            <div>
              <button
                type="button"
                onClick={() => setShowShiftForm(true)}
                className="btn btn-accent btn-lg"
                style={{ width: '100%' }}
              >
                Start Shift
              </button>
            </div>

          </div>

      </div>

      {/* ── START SHIFT WIZARD MODAL ── */}
      {showShiftForm && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 100,
          background: 'rgba(10,10,10,0.5)', backdropFilter: 'blur(4px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 16,
        }}>
          <div style={{
            background: '#ffffff',
            borderRadius: '12px',
            width: '100%',
            maxWidth: '500px',
            boxShadow: '0 20px 40px rgba(0,0,0,0.2)',
            overflow: 'hidden',
            animation: 'fadeInUp 0.3s ease-out',
            display: 'flex', flexDirection: 'column',
            maxHeight: '90vh'
          }}>
            {/* Header */}
            <div style={{
              padding: '20px 24px', borderBottom: '1px solid #e5e7eb',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              background: '#f9fafb'
            }}>
              <div>
                <div style={{ fontSize: '1rem', fontWeight: 800, color: '#1f2937', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  {shiftStep === 1 ? 'Step 1: Select Ambulance' : 'Step 2: Select Crew Members'}
                </div>
                <div style={{ fontSize: '0.75rem', color: '#6b7280', marginTop: 4 }}>
                  {shiftStep === 1 ? 'Which vehicle are you operating today?' : 'Select everyone working on this vehicle.'}
                </div>
              </div>
              <button onClick={() => { setShowShiftForm(false); setShiftStep(1); setSelectedVehicleId(''); setSelectedCrewIds([]); }} aria-label="Close" style={{
                width: 32, height: 32, background: '#e5e7eb', border: 'none',
                color: '#4b5563', cursor: 'pointer', fontSize: '1.4rem', lineHeight: 1,
                borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: 0,
              }}>×</button>
            </div>
            
            {/* Body */}
            <div style={{ padding: '24px', overflowY: 'auto' }}>
              {shiftError && <div className="login-error" style={{ marginBottom: '16px' }}>{shiftError}</div>}
              
              {shiftStep === 1 && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                  {vehicleList.map(v => (
                    <button
                      key={v.id}
                      type="button"
                      onClick={() => { setSelectedVehicleId(v.id); setShiftStep(2); }}
                      style={{
                        padding: '16px', borderRadius: '8px', border: '2px solid',
                        borderColor: selectedVehicleId === v.id ? 'var(--brand-teal)' : '#e5e7eb',
                        background: selectedVehicleId === v.id ? '#f0fdfa' : '#ffffff',
                        textAlign: 'left', cursor: 'pointer', transition: 'all 0.2s',
                        display: 'flex', flexDirection: 'column', gap: 4
                      }}
                    >
                      <span style={{ fontWeight: 800, color: '#1f2937' }}>{v.callsign}</span>
                      <span style={{ fontSize: '0.75rem', color: '#6b7280' }}>{v.registration_number}</span>
                    </button>
                  ))}
                  {vehicleList.length === 0 && (
                    <div style={{ gridColumn: 'span 2', textAlign: 'center', padding: '24px', color: '#6b7280' }}>
                      No vehicles available.
                    </div>
                  )}
                </div>
              )}

              {shiftStep === 2 && (
                <form onSubmit={handleStartShift}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '24px' }}>
                    {crewList.map(c => {
                      const isSelected = selectedCrewIds.includes(c.id);
                      const isPrimary = selectedCrewIds[0] === c.id;
                      return (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => toggleCrewSelection(c.id)}
                          style={{
                            padding: '12px 16px', borderRadius: '8px', border: '1px solid',
                            borderColor: isSelected ? 'var(--brand-teal)' : '#e5e7eb',
                            background: isSelected ? '#f0fdfa' : '#ffffff',
                            textAlign: 'left', cursor: 'pointer', transition: 'all 0.2s',
                            display: 'flex', alignItems: 'center', gap: 12
                          }}
                        >
                          <div style={{
                            width: 20, height: 20, borderRadius: '4px', border: '2px solid',
                            borderColor: isSelected ? 'var(--brand-teal)' : '#d1d5db',
                            background: isSelected ? 'var(--brand-teal)' : '#fff',
                            display: 'flex', alignItems: 'center', justifyContent: 'center'
                          }}>
                            {isSelected && <span style={{ color: '#fff', fontSize: '14px', lineHeight: 1 }}>✓</span>}
                          </div>
                          <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                            <span style={{ fontWeight: 600, color: '#1f2937' }}>{c.full_name}</span>
                            <span style={{ fontSize: '0.75rem', color: '#6b7280' }}>{c.qualification}</span>
                          </div>
                          {isPrimary && (
                            <span style={{ fontSize: '0.7rem', fontWeight: 800, color: 'var(--brand-teal)', background: '#ccfbf1', padding: '2px 8px', borderRadius: '12px' }}>
                              PRIMARY
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>

                  <div style={{ display: 'flex', gap: '12px', borderTop: '1px solid #e5e7eb', paddingTop: '20px' }}>
                    <button
                      type="button"
                      onClick={() => setShiftStep(1)}
                      className="btn btn-lg"
                      style={{ flex: '0 0 auto', padding: '12px 24px', background: '#f3f4f6', color: '#374151', border: '1px solid #d1d5db' }}
                    >
                      ← Back
                    </button>
                    <button type="submit" className="btn btn-accent btn-lg" style={{ flex: 1 }} disabled={shiftLoading || selectedCrewIds.length === 0}>
                      {shiftLoading ? 'Starting Shift...' : `Start Shift (${selectedCrewIds.length}) →`}
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
