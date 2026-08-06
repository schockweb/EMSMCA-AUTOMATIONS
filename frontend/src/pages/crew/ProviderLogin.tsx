/**
 * ProviderLogin — Company-gated login portal for a service provider.
 * Uses the premium glassmorphism dark-mode global login style.
 *
 * This screen is just: provider branding + the admin login form + a "Start
 * Shift" launcher. The multi-step shift-start flow lives in StartShiftWizard.
 */
import { useState, useEffect } from 'react';
import type { FormEvent } from 'react';
import { useParams, useNavigate } from 'react-router';
// Raw axios — the provider login / shift-start flow issues crew_token requests
// and must not run through the admin api/client interceptor (which would treat a
// wrong-password 401 as an expired admin session and redirect to /login).
import axios from 'axios';
import { useScrollLock } from '../../hooks/useScrollLock';
import InstallAppButton from '../../components/InstallAppButton';
import StartShiftWizard from './StartShiftWizard';
import type { CrewOption, VehicleOption } from './StartShiftWizard';
import { saveAdminSession, ensureProviderSession } from '../../utils/crewSession';
import { getPortalGrant, savePortalGrant, grantHeaders } from '../../utils/portalGrant';
import { reportSuccess, reportFailure } from '../../services/serverHealth';
import {
  cacheCrewRoster, getCachedCrewRoster,
  cacheVehicles, getCachedVehicles,
  isUsableOffline,
} from '../../services/offlineShiftCache';

interface ProviderInfo {
  name: string;
  slug: string;
  logo_url: string | null;
  pr_number: string | null;
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

  // Crew + vehicle lists feed the Start-Shift wizard.
  const [crewList, setCrewList] = useState<CrewOption[]>([]);
  const [vehicleList, setVehicleList] = useState<VehicleOption[]>([]);
  const [showShiftForm, setShowShiftForm] = useState(false);

  // ── Device unlock ──────────────────────────────────────────────────────
  // The crew/vehicle lists and the shift-start endpoints now require proof the
  // company password was entered on this device. Without it anyone could post a
  // crew UUID and receive a 12-hour patient-record token.
  // Unlocked means "this device holds a grant that is STILL VALID", not merely
  // "a grant is present". Presence alone let an expired grant render the crew
  // picker, and the failure then surfaced as an unexplained 401 at the moment
  // of starting a shift. Offline that is worse: with no server to answer, the
  // device would sit on a picker that could never work. Checking `exp` locally
  // re-prompts for the company password while the crew can still do something
  // about it.
  const [unlocked, setUnlocked] = useState<boolean>(
    () => isUsableOffline(getPortalGrant(providerSlug)),
  );
  const [unlockPassword, setUnlockPassword] = useState('');
  const [unlockError, setUnlockError] = useState('');
  const [unlockLoading, setUnlockLoading] = useState(false);

  const handleUnlock = async (e: FormEvent) => {
    e.preventDefault();
    if (!providerSlug) return;
    setUnlockError('');
    setUnlockLoading(true);
    try {
      const res = await axios.post('/api/crew/portal-unlock', {
        provider_slug: providerSlug,
        password: unlockPassword,
      });
      savePortalGrant(providerSlug, res.data.grant);
      setUnlockPassword('');
      setUnlocked(true);
    } catch (err: any) {
      setUnlockError(err.response?.data?.detail || 'Incorrect company password');
    }
    setUnlockLoading(false);
  };

  // Freeze background scroll for the whole full-screen portal using the shared
  // iOS-safe (position:fixed) lock. Because the page stays locked the entire
  // time it is mounted, the Start-Shift wizard modal is covered too — no
  // separate modal-only lock is needed.
  useScrollLock();

  // ── Tenant guard: landing on THIS provider's login page wipes any session
  // belonging to a DIFFERENT provider. Prevents a leftover Provider-A login
  // from leaking into Provider B's portal (or teleporting the user back to
  // A's pages after they deliberately opened B's login).
  useEffect(() => {
    ensureProviderSession(providerSlug);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerSlug]);

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
    if (!providerSlug || !unlocked) return;
    const cfg = { headers: grantHeaders(providerSlug) };
    axios.get(`/api/providers/${providerSlug}/public-crew`, cfg)
      .then(res => {
        const data = res.data;
        const list = Array.isArray(data) ? data : [];
        setCrewList(list);
        reportSuccess();
        // Cache so this device can still present the picker during an outage.
        cacheCrewRoster(providerSlug, list as any);
      })
      .catch(err => {
        // Grant expired or rejected — fall back to the unlock prompt. This is
        // an ANSWER from the server, so it is authoritative and must still be
        // honoured; only a transport failure means "unreachable".
        if (err?.response?.status === 401 || err?.response?.status === 403) {
          setUnlocked(false);
          return;
        }
        reportFailure(err);
        // Unreachable — show what this device last saw rather than an empty list.
        const cached = getCachedCrewRoster(providerSlug);
        if (cached && cached.length) setCrewList(cached as any);
      });
    // Vehicles get the same treatment as the crew roster above. They did not
    // before: the failure was swallowed whole, so an offline device showed an
    // empty vehicle picker and the shift could not be started even though the
    // crew list had come back from cache. Half a cached shift-start flow is no
    // shift-start flow.
    axios.get(`/api/providers/${providerSlug}/public-vehicles`, cfg)
      .then(res => {
        const data = res.data;
        const list = Array.isArray(data) ? data : [];
        setVehicleList(list);
        cacheVehicles(providerSlug, list as any);
      })
      .catch(err => {
        // A 401/403 is the server ANSWERING that the grant is no longer good;
        // the crew-roster handler above already drops back to the unlock
        // prompt, so do not paper over it with a cached list here.
        if (err?.response?.status === 401 || err?.response?.status === 403) return;
        const cached = getCachedVehicles(providerSlug);
        if (cached && cached.length) setVehicleList(cached as any);
      });
  }, [providerSlug, unlocked]);

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
      // Persist crew_token + crew_profile via the shared helper so the shape
      // stays in sync with what ProviderAdminDashboard reads.
      saveAdminSession(res.data);
      navigate(`/${providerSlug}/admin/dashboard`);
    } catch (err: any) {
      setAdminError(err.response?.data?.detail || 'Invalid admin credentials');
    }
    setAdminLoading(false);
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

            {/* Start Shift Button — deliberately the same btn-primary teal as
                "Sign In as Admin" above it, so the two entry points read as one
                system rather than two different actions. */}
            {/* Device unlock — one company password per device per shift.
                Selecting a name from a dropdown identifies a crew member; it
                does not authenticate them, so the shift-start endpoints require
                this first. */}
            {!unlocked ? (
              <form onSubmit={handleUnlock}>
                <label
                  htmlFor="portal-unlock"
                  style={{ display: 'block', fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', marginBottom: 6 }}
                >
                  Company password
                </label>
                <input
                  id="portal-unlock"
                  type="password"
                  className="input"
                  autoComplete="current-password"
                  placeholder="Unlock this device"
                  value={unlockPassword}
                  onChange={e => setUnlockPassword(e.target.value)}
                  style={{ width: '100%', marginBottom: 10 }}
                />
                {unlockError && (
                  <div style={{ color: '#f87171', fontSize: '0.8rem', marginBottom: 10 }}>{unlockError}</div>
                )}
                <button
                  type="submit"
                  disabled={unlockLoading || !unlockPassword}
                  className="btn btn-primary btn-lg"
                  style={{ width: '100%' }}
                >
                  {unlockLoading ? 'Unlocking…' : 'Unlock to Start Shift'}
                </button>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 8, textAlign: 'center' }}>
                  Ask your manager for the company password. You only need it once on this device.
                </div>
              </form>
            ) : (
            <div>
              <button
                type="button"
                onClick={() => setShowShiftForm(true)}
                className="btn btn-primary btn-lg"
                style={{ width: '100%' }}
              >
                Start Shift
              </button>
            </div>
            )}

            {/* Install-as-app affordance — renders only when installable and
                not already running as an installed PWA. Hidden while the Start
                Shift wizard is open so the portaled icon doesn't float over it. */}
            <InstallAppButton hidden={showShiftForm} />

          </div>

      </div>

      {/* ── START SHIFT WIZARD MODAL ── */}
      {showShiftForm && (
        <StartShiftWizard
          providerSlug={providerSlug}
          crewList={crewList}
          vehicleList={vehicleList}
          onClose={() => setShowShiftForm(false)}
        />
      )}
    </div>
  );
}
