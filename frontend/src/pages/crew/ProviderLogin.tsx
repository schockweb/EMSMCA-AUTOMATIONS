/**
 * ProviderLogin — Company-gated login portal for a service provider.
 *
 * Flow:
 *   Step 1 — Company Login: all staff enter the shared EMSMCA Client Login credentials
 *            (portal_login_email / portal_login_password stored on ServiceProvider).
 *   Step 2 — Portal: branded page showing two access paths:
 *            a) Admin Login  → email + password → /{slug}/admin/dashboard
 *            b) Start Shift  → crew picks their name + partner → /{slug}/crew/dashboard
 */
import { useState, useEffect } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import axios from 'axios';

const G   = '#10b981';
const GD  = '#059669';
const T   = '#0f172a';
const M   = '#475569';
const B   = '#e2e8f0';
const RED = '#b91c1c';

type Step = 'company-login' | 'portal';

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
  const location = useLocation();

  // Step management
  const [step, setStep] = useState<Step>(location.state?.bypassedStep1 ? 'portal' : 'company-login');
  const [providerInfo, setProviderInfo] = useState<ProviderInfo | null>(location.state?.providerInfo || null);

  // Company login fields
  const [companyUsername, setCompanyUsername] = useState('');
  const [companyPassword, setCompanyPassword] = useState('');
  const [companyError, setCompanyError] = useState('');
  const [companyLoading, setCompanyLoading] = useState(false);

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
  const [showShiftPanel, setShowShiftPanel] = useState(false);

  // On mount — pre-load provider logo/name for step 1 branding
  useEffect(() => {
    axios.get('/api/providers/public')
      .then(res => {
        const p = res.data.find((p: any) => p.slug === providerSlug);
        if (p) setProviderInfo({ name: p.name, slug: p.slug, logo_url: p.logo_url, pr_number: null });
      }).catch(() => {});
  }, [providerSlug]);

  // Load crew and vehicle list when portal step opens
  useEffect(() => {
    if (step !== 'portal' || !providerSlug) return;
    axios.get(`/api/providers/${providerSlug}/public-crew`)
      .then(res => setCrewList(res.data))
      .catch(() => {});
    axios.get(`/api/providers/${providerSlug}/public-vehicles`)
      .then(res => setVehicleList(res.data))
      .catch(() => {});
  }, [step, providerSlug]);

  // ── Step 1: Company Login ──────────────────────────────────
  const handleCompanyLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setCompanyError('');
    setCompanyLoading(true);
    try {
      const res = await axios.post(`/api/providers/${providerSlug}/portal-login`, {
        username: companyUsername.trim(),
        password: companyPassword,
      });
      setProviderInfo(res.data);
      setStep('portal');
    } catch (err: any) {
      setCompanyError(err.response?.data?.detail || 'Invalid username or password');
    }
    setCompanyLoading(false);
  };

  // ── Step 2a: Admin Login ───────────────────────────────────
  const handleAdminLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setAdminError('');
    setAdminLoading(true);
    try {
      const res = await axios.post('/api/crew/login', {
        email: adminEmail.trim().toLowerCase(),
        password: adminPassword,
      });
      const data = res.data;
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
      if (data.role === 'admin') {
        navigate(`/${data.provider_slug}/admin/dashboard`);
      } else {
        navigate(`/${data.provider_slug}/crew/dashboard`);
      }
    } catch (err: any) {
      setAdminError(err.response?.data?.detail || 'Login failed. Check your credentials.');
    }
    setAdminLoading(false);
  };

  // ── Step 2b: Crew Shift Start ──────────────────────────────
  const handleStartShift = async () => {
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

  // ── Styles ────────────────────────────────────────────────
  const fieldStyle: React.CSSProperties = {
    width: '100%', padding: '13px 16px', fontSize: '0.94rem',
    borderRadius: 10, border: `1px solid ${B}`,
    background: '#ffffff', color: T, fontWeight: 500,
    marginBottom: 16, outline: 'none', boxSizing: 'border-box', transition: 'all 0.2s',
    fontFamily: 'inherit',
  };
  const onFocus = (e: React.FocusEvent<HTMLInputElement | HTMLSelectElement>) => {
    e.currentTarget.style.borderColor = G;
    e.currentTarget.style.boxShadow = `0 0 0 3px rgba(16,185,129,0.12)`;
  };
  const onBlur = (e: React.FocusEvent<HTMLInputElement | HTMLSelectElement>) => {
    e.currentTarget.style.borderColor = B;
    e.currentTarget.style.boxShadow = 'none';
  };

  const LogoBlock = () => (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: 24 }}>
      {providerInfo?.logo_url ? (
        <img src={providerInfo.logo_url} alt={providerInfo.name} style={{ maxWidth: 220, maxHeight: 90, objectFit: 'contain', marginBottom: 8 }} />
      ) : (
        <>
          <div style={{ width: 68, height: 68, borderRadius: 16, background: `linear-gradient(135deg, ${G}, ${GD})`, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 10, boxShadow: `0 8px 24px rgba(16,185,129,0.2)`, fontSize: '1.7rem', fontWeight: 800, color: '#fff' }}>
            {(providerInfo?.name || providerSlug || '?')[0].toUpperCase()}
          </div>
          <h1 style={{ color: T, fontSize: '1.4rem', fontWeight: 800, margin: 0, textAlign: 'center', letterSpacing: '-0.02em' }}>
            {providerInfo?.name || providerSlug?.toUpperCase()}
          </h1>
        </>
      )}
    </div>
  );

  // ═══════════════════════════════════════════════════════════
  // STEP 1 — Company Login
  // ═══════════════════════════════════════════════════════════
  if (step === 'company-login') {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: '#f8fafc', padding: '24px 20px', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>
        <button onClick={() => navigate('/login')} style={{ position: 'absolute', top: 20, left: 20, background: '#f1f5f9', border: `1px solid ${B}`, borderRadius: 8, padding: '7px 14px', color: M, fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer' }}>
          ← Back
        </button>

        <LogoBlock />

        <p style={{ color: M, fontSize: '0.8rem', margin: '0 0 28px', textAlign: 'center', fontWeight: 500, letterSpacing: '0.02em' }}>
          Enter your company access credentials
        </p>

        <div style={{ width: '100%', maxWidth: 360, background: '#fff', border: `1px solid ${B}`, borderRadius: 18, padding: '32px 28px', boxShadow: '0 4px 24px rgba(0,0,0,0.05)' }}>
          {companyError && (
            <div style={{ padding: '11px 14px', borderRadius: 8, marginBottom: 16, background: '#fef2f2', border: '1px solid #fecaca', color: RED, fontSize: '0.83rem', fontWeight: 600 }}>
              {companyError}
            </div>
          )}
          <form onSubmit={handleCompanyLogin} autoComplete="off">
            <label style={{ display: 'block', fontSize: '0.7rem', fontWeight: 700, color: M, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 7 }}>
              Username
            </label>
            <input
              type="text" inputMode="email" value={companyUsername}
              onChange={e => setCompanyUsername(e.target.value)}
              placeholder="e.g. JEMS@EMSMCA"
              required autoComplete="off" data-lpignore="true" data-form-type="other"
              autoFocus spellCheck={false}
              style={fieldStyle} onFocus={onFocus} onBlur={onBlur}
            />
            <label style={{ display: 'block', fontSize: '0.7rem', fontWeight: 700, color: M, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 7 }}>
              Password
            </label>
            <input
              type="password" value={companyPassword}
              onChange={e => setCompanyPassword(e.target.value)}
              placeholder="••••••••" required autoComplete="new-password"
              data-lpignore="true" data-form-type="other"
              style={{ ...fieldStyle, marginBottom: 24 }} onFocus={onFocus} onBlur={onBlur}
            />
            <button type="submit" disabled={companyLoading} style={{ width: '100%', padding: '13px', background: companyLoading ? '#94a3b8' : `linear-gradient(135deg, ${G}, ${GD})`, color: '#fff', border: 'none', borderRadius: 10, fontSize: '0.95rem', fontWeight: 700, cursor: companyLoading ? 'wait' : 'pointer', transition: 'all 0.2s' }}>
              {companyLoading ? 'Verifying…' : 'Access Portal →'}
            </button>
          </form>
        </div>

        <p style={{ color: '#94a3b8', fontSize: '0.72rem', marginTop: 32, textAlign: 'center', fontWeight: 500 }}>
          EMS Claims Portal • Secure Access
        </p>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════
  // STEP 2 — Provider Portal (Admin Login + Crew Start Shift)
  // ═══════════════════════════════════════════════════════════
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: '#f8fafc', padding: '32px 20px', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>
      <button onClick={() => setStep('company-login')} style={{ position: 'absolute', top: 20, left: 20, background: '#f1f5f9', border: `1px solid ${B}`, borderRadius: 8, padding: '7px 14px', color: M, fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer' }}>
        ← Back
      </button>

      <LogoBlock />

      <p style={{ color: M, fontSize: '0.8rem', margin: '0 0 28px', textAlign: 'center', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
        Administration Portal
      </p>

      <div style={{ width: '100%', maxWidth: 400 }}>
        {/* ── Admin Login Card ── */}
        <div style={{ background: '#fff', border: `1px solid ${B}`, borderRadius: 18, padding: '28px 26px', boxShadow: '0 4px 24px rgba(0,0,0,0.05)', marginBottom: 16 }}>
          <div style={{ fontSize: '0.7rem', fontWeight: 800, color: G, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 16 }}>🔐 Admin Login</div>
          {adminError && (
            <div style={{ padding: '10px 13px', borderRadius: 8, marginBottom: 14, background: '#fef2f2', border: '1px solid #fecaca', color: RED, fontSize: '0.82rem', fontWeight: 600 }}>
              {adminError}
            </div>
          )}
          <form onSubmit={handleAdminLogin} autoComplete="off">
            <input
              type="email" value={adminEmail} onChange={e => setAdminEmail(e.target.value)}
              placeholder="Admin email address"
              required autoComplete="off" data-lpignore="true" data-form-type="other"
              style={fieldStyle} onFocus={onFocus} onBlur={onBlur}
            />
            <input
              type="password" value={adminPassword} onChange={e => setAdminPassword(e.target.value)}
              placeholder="••••••••" required autoComplete="new-password"
              data-lpignore="true" data-form-type="other"
              style={{ ...fieldStyle, marginBottom: 20 }} onFocus={onFocus} onBlur={onBlur}
            />
            <button type="submit" disabled={adminLoading} style={{ width: '100%', padding: '12px', background: adminLoading ? '#94a3b8' : `linear-gradient(135deg, ${G}, ${GD})`, color: '#fff', border: 'none', borderRadius: 10, fontSize: '0.92rem', fontWeight: 700, cursor: adminLoading ? 'wait' : 'pointer', transition: 'all 0.2s' }}>
              {adminLoading ? 'Signing In…' : 'Sign In as Admin'}
            </button>
          </form>
        </div>

        {/* ── Divider ── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '4px 0' }}>
          <div style={{ flex: 1, height: 1, background: B }} />
          <span style={{ fontSize: '0.68rem', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Crew Access</span>
          <div style={{ flex: 1, height: 1, background: B }} />
        </div>

        {/* ── Start Shift Panel ── */}
        <div style={{ background: '#fff', border: `1px solid ${B}`, borderRadius: 18, padding: '22px 26px', boxShadow: '0 4px 24px rgba(0,0,0,0.05)', marginTop: 16 }}>
          <div style={{ fontSize: '0.7rem', fontWeight: 800, color: '#2563eb', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 14 }}>🚑 Start Shift</div>

          {!showShiftPanel ? (
            <button
              onClick={() => setShowShiftPanel(true)}
              style={{ width: '100%', padding: '13px', background: '#f8fafc', border: `1px solid ${B}`, borderRadius: 10, color: GD, fontSize: '0.92rem', fontWeight: 700, cursor: 'pointer', letterSpacing: '0.02em', transition: 'all 0.2s' }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = G; e.currentTarget.style.background = '#f0fdf4'; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = B; e.currentTarget.style.background = '#f8fafc'; }}
            >
              Start New Shift →
            </button>
          ) : (
            <>
              {shiftError && (
                <div style={{ padding: '10px 13px', borderRadius: 8, marginBottom: 12, background: '#fef2f2', border: '1px solid #fecaca', color: RED, fontSize: '0.82rem', fontWeight: 600 }}>
                  {shiftError}
                </div>
              )}

              <label style={{ display: 'block', fontSize: '0.7rem', fontWeight: 700, color: M, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 7 }}>
                Your Name *
              </label>
              <select
                value={selectedCrewId}
                onChange={e => setSelectedCrewId(e.target.value)}
                style={{ ...fieldStyle, marginBottom: 14 }}
                onFocus={onFocus} onBlur={onBlur}
              >
                <option value="">— Select your name —</option>
                {crewList.map(c => (
                  <option key={c.id} value={c.id}>{c.full_name} ({c.qualification})</option>
                ))}
              </select>

              <label style={{ display: 'block', fontSize: '0.7rem', fontWeight: 700, color: M, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 7 }}>
                Person Assisting (Partner)
              </label>
              <select
                value={selectedPartnerId}
                onChange={e => setSelectedPartnerId(e.target.value)}
                style={{ ...fieldStyle, marginBottom: 14 }}
                onFocus={onFocus} onBlur={onBlur}
              >
                <option value="">— Select partner (optional) —</option>
                {crewList.filter(c => c.id !== selectedCrewId).map(c => (
                  <option key={c.id} value={c.id}>{c.full_name} ({c.qualification})</option>
                ))}
              </select>

              <label style={{ display: 'block', fontSize: '0.7rem', fontWeight: 700, color: M, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 7 }}>
                Ambulance *
              </label>
              <select
                value={selectedVehicleId}
                onChange={e => setSelectedVehicleId(e.target.value)}
                style={{ ...fieldStyle, marginBottom: 20 }}
                onFocus={onFocus} onBlur={onBlur}
              >
                <option value="">— Select ambulance —</option>
                {vehicleList.map(v => (
                  <option key={v.id} value={v.id}>{v.callsign} ({v.registration_number})</option>
                ))}
              </select>

              <button
                onClick={handleStartShift}
                disabled={shiftLoading || !selectedCrewId || !selectedVehicleId}
                style={{ width: '100%', padding: '13px', background: (!selectedCrewId || !selectedVehicleId || shiftLoading) ? '#94a3b8' : 'linear-gradient(135deg, #2563eb, #1d4ed8)', color: '#fff', border: 'none', borderRadius: 10, fontSize: '0.92rem', fontWeight: 700, cursor: (!selectedCrewId || !selectedVehicleId || shiftLoading) ? 'not-allowed' : 'pointer', transition: 'all 0.2s', boxShadow: (selectedCrewId && selectedVehicleId) ? '0 3px 10px rgba(37,99,235,0.3)' : 'none' }}
              >
                {shiftLoading ? 'Starting Shift…' : '🚑 Start Shift'}
              </button>
            </>
          )}
        </div>
      </div>

      <p style={{ color: '#94a3b8', fontSize: '0.72rem', marginTop: 32, textAlign: 'center', fontWeight: 500 }}>
        EMS Claims Portal • Secure Access
      </p>
    </div>
  );
}
