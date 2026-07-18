/**
 * ProviderLogin — Company-gated login portal for a service provider.
 * Uses the premium glassmorphism dark-mode global login style.
 */
import { useState, useEffect } from 'react';
import type { FormEvent } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import axios from '../../api/client';
import { useScrollLock } from '../../hooks/useScrollLock';
import InstallAppButton from '../../components/InstallAppButton';

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

  // The mount lock above uses overflow:hidden, which iOS Safari ignores for
  // touch scrolling — so the page behind the Start-Shift wizard could still be
  // scrolled with a finger on phones, stealing scroll from the modal. This
  // robust lock (position:fixed) engages while the wizard is open and fully
  // freezes the background on mobile.
  useScrollLock(showShiftForm);

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
      .then(res => {
        const data = res.data;
        setCrewList(Array.isArray(data) ? data : []);
      })
      .catch(() => {});
    axios.get(`/api/providers/${providerSlug}/public-vehicles`)
      .then(res => {
        const data = res.data;
        setVehicleList(Array.isArray(data) ? data : []);
      })
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
         const rawP = crewList.find(c => c.id === partnerId);
         if (rawP) {
           const p = { id: rawP.id, name: rawP.full_name, full_name: rawP.full_name, hpcsa_number: rawP.hpcsa_number, qualification: rawP.qualification };
           localStorage.setItem('crew2_profile', JSON.stringify(p));
         }
      } else {
         localStorage.removeItem('crew2_profile');
      }
      
      // Store ALL assisting crew members (including 1st partner) as extra_crew_profiles
      // so the dashboard shows every partner on the shift card
      const allAssisting = assistingCrewIds
        .map(id => crewList.find(c => c.id === id))
        .filter(Boolean)
        .map(c => ({
          id: c!.id,
          name: c!.full_name,
          full_name: c!.full_name,
          hpcsa_number: c!.hpcsa_number,
          qualification: c!.qualification,
        }));
      if (allAssisting.length > 0) {
         localStorage.setItem('extra_crew_profiles', JSON.stringify(allAssisting));
      } else {
         localStorage.removeItem('extra_crew_profiles');
      }

      // Store the selected vehicle so the crew dashboard doesn't re-prompt
      const selectedVehicle = vehicleList.find(v => v.id === selectedVehicleId);
      if (selectedVehicle) {
        localStorage.setItem('active_vehicle', JSON.stringify({
          id: selectedVehicle.id,
          callsign: selectedVehicle.callsign,
          registration: selectedVehicle.registration_number,
          vehicle_type: '',
        }));
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
    <div className="login-page">
      
      {/* ── BACK BUTTON ── */}
      <button
        onClick={() => navigate('/login')}
        className="provider-back-btn"
        style={{
          position: 'absolute',
          // Offset below the device status bar / notch on mobile (the page is
          // rendered viewport-fit=cover, so without this the button is clipped
          // at the top edge on phones). Falls back to 24px on desktop where the
          // safe-area inset is 0.
          top: 'calc(env(safe-area-inset-top, 0px) + 24px)',
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

      <div className="login-card">
        
        {/* Provider Logo Header */}
        <div className="login-logo" style={{ marginBottom: '24px' }}>
          {providerInfo?.logo_url ? (
            <img src={providerInfo.logo_url} alt={providerInfo.name} style={{ height: 72, objectFit: 'contain', marginBottom: 16 }} />
          ) : (
            <h1 style={{ marginBottom: 16 }}>{providerInfo?.name || 'Company Portal'}</h1>
          )}
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

            {/* Install-as-app affordance — renders only when installable and
                not already running as an installed PWA. Hidden while the Start
                Shift wizard is open so the portaled icon doesn't float over it. */}
            <InstallAppButton hidden={showShiftForm} />

          </div>

      </div>

      {/* ── START SHIFT WIZARD MODAL ── */}
      {showShiftForm && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 100,
          background: 'rgba(0,0,0,0.35)', backdropFilter: 'blur(8px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 16,
        }}>
          <div style={{
            background: '#fff',
            borderRadius: '16px',
            width: '100%',
            maxWidth: '460px',
            boxShadow: '0 24px 48px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.08)',
            overflow: 'hidden',
            animation: 'fadeInUp 0.25s ease-out',
            display: 'flex', flexDirection: 'column',
            maxHeight: '85vh'
          }}>
            {/* Header */}
            <div style={{
              padding: '20px 24px 16px', borderBottom: '1px solid #f0f0f0',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}>
              <div>
                <div style={{ fontSize: '0.95rem', fontWeight: 600, color: '#111827', letterSpacing: '-0.01em' }}>
                  {shiftStep === 1 ? 'Select Ambulance' : 'Select Crew'}
                </div>
                <div style={{ fontSize: '0.78rem', color: '#9ca3af', marginTop: 2, fontWeight: 400 }}>
                  {shiftStep === 1 ? 'Choose the vehicle for this shift' : 'Tap to select crew on this vehicle'}
                </div>
              </div>
              <button onClick={() => { setShowShiftForm(false); setShiftStep(1); setSelectedVehicleId(''); setSelectedCrewIds([]); }} aria-label="Close" style={{
                width: 30, height: 30, background: 'transparent', border: '1px solid #e5e7eb',
                color: '#9ca3af', cursor: 'pointer', fontSize: '1.1rem', lineHeight: 1,
                borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: 0, transition: 'all 0.15s',
              }}>×</button>
            </div>
            
            {/* Body */}
            <div style={{ padding: '20px 24px', overflowY: 'auto' }}>
              {shiftError && <div className="login-error" style={{ marginBottom: '14px', fontSize: '0.8rem' }}>{shiftError}</div>}
              
              {shiftStep === 1 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {vehicleList.map(v => (
                    <button
                      key={v.id}
                      type="button"
                      onClick={() => { setSelectedVehicleId(v.id); setShiftStep(2); }}
                      style={{
                        padding: '14px 16px', borderRadius: '10px', border: '1px solid #e5e7eb',
                        background: '#fff',
                        textAlign: 'left', cursor: 'pointer', transition: 'all 0.15s',
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 600, fontSize: '0.88rem', color: '#1f2937' }}>{v.callsign}</div>
                        <div style={{ fontSize: '0.72rem', color: '#9ca3af', marginTop: 1 }}>{v.registration_number}</div>
                      </div>
                      <span style={{ color: '#d1d5db', fontSize: '1rem' }}>›</span>
                    </button>
                  ))}
                  {vehicleList.length === 0 && (
                    <div style={{ textAlign: 'center', padding: '32px 16px', color: '#9ca3af', fontSize: '0.85rem' }}>
                      No vehicles available
                    </div>
                  )}
                </div>
              )}

              {shiftStep === 2 && (
                <form onSubmit={handleStartShift}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '20px' }}>
                    {crewList.map(c => {
                      const isSelected = selectedCrewIds.includes(c.id);
                      return (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => toggleCrewSelection(c.id)}
                          style={{
                            padding: '12px 14px', borderRadius: '10px',
                            border: '1px solid',
                            borderColor: isSelected ? 'var(--brand-teal)' : '#e5e7eb',
                            background: isSelected ? 'rgba(20,184,166,0.06)' : '#fff',
                            textAlign: 'left', cursor: 'pointer', transition: 'all 0.15s',
                            display: 'flex', alignItems: 'center', gap: 10,
                          }}
                        >
                          <div style={{
                            width: 18, height: 18, borderRadius: '4px', border: '1.5px solid',
                            borderColor: isSelected ? 'var(--brand-teal)' : '#d1d5db',
                            background: isSelected ? 'var(--brand-teal)' : '#fff',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            flexShrink: 0, transition: 'all 0.15s',
                          }}>
                            {isSelected && <span style={{ color: '#fff', fontSize: '12px', lineHeight: 1 }}>✓</span>}
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontWeight: 500, fontSize: '0.85rem', color: '#1f2937' }}>{c.full_name}</div>
                            <div style={{ fontSize: '0.7rem', color: '#9ca3af', marginTop: 1 }}>{c.qualification}</div>
                          </div>
                        </button>
                      );
                    })}
                  </div>

                  <div style={{ display: 'flex', gap: '10px', borderTop: '1px solid #f0f0f0', paddingTop: '16px' }}>
                    <button
                      type="button"
                      onClick={() => setShiftStep(1)}
                      className="btn btn-lg"
                      style={{
                        flex: '0 0 auto', padding: '10px 20px',
                        background: '#fff', color: '#6b7280', border: '1px solid #e5e7eb',
                        fontSize: '0.82rem', fontWeight: 500,
                      }}
                    >
                      Back
                    </button>
                    <button type="submit" className="btn btn-accent btn-lg" style={{ flex: 1, fontSize: '0.82rem', fontWeight: 600 }} disabled={shiftLoading || selectedCrewIds.length === 0}>
                      {shiftLoading ? 'Starting...' : `Start Shift · ${selectedCrewIds.length} selected`}
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
