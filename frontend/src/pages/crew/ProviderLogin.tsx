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
import { useParams, useNavigate } from 'react-router-dom';
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

export default function ProviderLogin() {
  const { providerSlug } = useParams<{ providerSlug: string }>();
  const navigate = useNavigate();

  // Step management
  const [step, setStep] = useState<'login' | 'crew-shift'>('login');
  const [providerInfo, setProviderInfo] = useState<ProviderInfo | null>(null);

  // Single Login fields
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Crew shift start
  const [crewList, setCrewList] = useState<CrewOption[]>([]);
  const [selectedCrewId, setSelectedCrewId] = useState('');
  const [selectedPartnerId, setSelectedPartnerId] = useState('');
  const [shiftLoading, setShiftLoading] = useState(false);
  const [shiftError, setShiftError] = useState('');

  // On mount — pre-load provider logo/name for branding
  useEffect(() => {
    axios.get('/api/providers/public')
      .then(res => {
        const p = res.data.find((p: any) => p.slug === providerSlug);
        if (p) setProviderInfo({ name: p.name, slug: p.slug, logo_url: p.logo_url, pr_number: null });
      }).catch(() => {});
  }, [providerSlug]);

  // Load crew list when reaching the crew-shift step
  useEffect(() => {
    if (step !== 'crew-shift' || !providerSlug) return;
    axios.get(`/api/providers/${providerSlug}/public-crew`)
      .then(res => setCrewList(res.data))
      .catch(() => {});
  }, [step, providerSlug]);

  // ── Unified Login Handler ──────────────────────────────────
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    // Attempt 1: Try Admin Login first
    try {
      const res = await axios.post('/api/crew/login', {
        email: username.trim().toLowerCase(),
        password: password,
      });
      const data = res.data;
      
      // If it's an admin login, ensure they are logging into the correct portal
      if (data.provider_slug !== providerSlug) {
        throw new Error('Invalid provider');
      }

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
      return; // Success, we are done!
    } catch (err: any) {
      // If it's a hard server error, stop. If it's a 401 or invalid provider, fall through to try company login.
      if (err.response?.status && err.response.status !== 401 && err.message !== 'Invalid provider') {
        setError('Server error. Please try again later.');
        setLoading(false);
        return;
      }
    }

    // Attempt 2: Try Company Shared Login
    try {
      const res = await axios.post(`/api/providers/${providerSlug}/portal-login`, {
        username: username.trim(),
        password: password,
      });
      setProviderInfo(res.data);
      setStep('crew-shift');
    } catch (err: any) {
      setError('Invalid username or password');
    }
    setLoading(false);
  };

  // ── Crew Shift Start ──────────────────────────────
  const handleStartShift = async () => {
    if (!selectedCrewId) { setShiftError('Please select your name.'); return; }
    setShiftError('');
    setShiftLoading(true);
    try {
      const partnerName = crewList.find(c => c.id === selectedPartnerId)?.full_name || '';
      const res = await axios.post('/api/crew/shift-start-by-id', {
        crew_id: selectedCrewId,
        provider_slug: providerSlug,
        partner_name: partnerName || undefined,
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

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: '#f8fafc', padding: '24px 20px', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>
      
      {step === 'crew-shift' && (
        <button onClick={() => setStep('login')} style={{ position: 'absolute', top: 20, left: 20, background: '#f1f5f9', border: `1px solid ${B}`, borderRadius: 8, padding: '7px 14px', color: M, fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer' }}>
          ← Back
        </button>
      )}

      <LogoBlock />

      {step === 'login' && (
        <>
          <p style={{ color: M, fontSize: '0.8rem', margin: '0 0 28px', textAlign: 'center', fontWeight: 500, letterSpacing: '0.02em' }}>
            Enter your company access credentials
          </p>

          <div style={{ width: '100%', maxWidth: 360, background: '#fff', border: `1px solid ${B}`, borderRadius: 18, padding: '32px 28px', boxShadow: '0 4px 24px rgba(0,0,0,0.05)' }}>
            {error && (
              <div style={{ padding: '11px 14px', borderRadius: 8, marginBottom: 16, background: '#fef2f2', border: '1px solid #fecaca', color: RED, fontSize: '0.83rem', fontWeight: 600 }}>
                {error}
              </div>
            )}
            <form onSubmit={handleLogin} autoComplete="off">
              <label style={{ display: 'block', fontSize: '0.7rem', fontWeight: 700, color: M, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 7 }}>
                Username / Admin Email
              </label>
              <input
                type="text" value={username}
                onChange={e => setUsername(e.target.value)}
                placeholder="e.g. JEMS@EMSMCA"
                required autoComplete="off" data-lpignore="true" data-form-type="other"
                autoFocus spellCheck={false}
                style={fieldStyle} onFocus={onFocus} onBlur={onBlur}
              />
              <label style={{ display: 'block', fontSize: '0.7rem', fontWeight: 700, color: M, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 7 }}>
                Password
              </label>
              <input
                type="password" value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="••••••••" required autoComplete="new-password"
                data-lpignore="true" data-form-type="other"
                style={{ ...fieldStyle, marginBottom: 24 }} onFocus={onFocus} onBlur={onBlur}
              />
              <button type="submit" disabled={loading} style={{ width: '100%', padding: '13px', background: loading ? '#94a3b8' : `linear-gradient(135deg, ${G}, ${GD})`, color: '#fff', border: 'none', borderRadius: 10, fontSize: '0.95rem', fontWeight: 700, cursor: loading ? 'wait' : 'pointer', transition: 'all 0.2s' }}>
                {loading ? 'Verifying…' : 'Access Portal →'}
              </button>
            </form>
          </div>
        </>
      )}

      {step === 'crew-shift' && (
        <>
          <p style={{ color: M, fontSize: '0.8rem', margin: '0 0 28px', textAlign: 'center', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
            Crew Shift Registration
          </p>
          <div style={{ width: '100%', maxWidth: 400, background: '#fff', border: `1px solid ${B}`, borderRadius: 18, padding: '28px 26px', boxShadow: '0 4px 24px rgba(0,0,0,0.05)' }}>
            <div style={{ fontSize: '0.7rem', fontWeight: 800, color: '#2563eb', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 16 }}>🚑 Start Shift</div>
            
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
              style={{ ...fieldStyle, marginBottom: 20 }}
              onFocus={onFocus} onBlur={onBlur}
            >
              <option value="">— Select partner (optional) —</option>
              {crewList.filter(c => c.id !== selectedCrewId).map(c => (
                <option key={c.id} value={c.id}>{c.full_name} ({c.qualification})</option>
              ))}
            </select>

            <button
              onClick={handleStartShift}
              disabled={shiftLoading || !selectedCrewId}
              style={{ width: '100%', padding: '13px', background: (!selectedCrewId || shiftLoading) ? '#94a3b8' : 'linear-gradient(135deg, #2563eb, #1d4ed8)', color: '#fff', border: 'none', borderRadius: 10, fontSize: '0.92rem', fontWeight: 700, cursor: (!selectedCrewId || shiftLoading) ? 'not-allowed' : 'pointer', transition: 'all 0.2s', boxShadow: selectedCrewId ? '0 3px 10px rgba(37,99,235,0.3)' : 'none' }}
            >
              {shiftLoading ? 'Starting Shift…' : 'Start Digital Shift'}
            </button>
          </div>
        </>
      )}

      <p style={{ color: '#94a3b8', fontSize: '0.72rem', marginTop: 32, textAlign: 'center', fontWeight: 500 }}>
        EMS Claims Portal • Secure Access
      </p>
    </div>
  );
}
