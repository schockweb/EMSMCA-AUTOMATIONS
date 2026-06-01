/**
 * CrewDashboard — Mobile-first shift screen.
 * Flow: Select Vehicle → Enter Crew 1 + Crew 2 HPCSA → Personal Dashboard
 * New PRF is created from the dashboard (not immediately after login).
 */
import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import axios from 'axios';

const G = '#10b981';
const GD = '#059669';
const T = '#0f172a';
const M = '#475569';
const BL = '#f8fafc';
const B = '#e2e8f0';

interface Vehicle {
  id: string;
  callsign: string;
  registration: string;
  vehicle_type: string;
}

type Step = 'vehicle' | 'crew' | 'supervisor' | 'loading' | null;

// HPCSA category considered Basic Life Support (BAA). Two-BAA crew composition
// requires an independent supervising practitioner per HPCSA General Board
// Rulings (June 2017 §2.1) — captured in the `'supervisor'` shift-start step.
const BLS_CATEGORIES = ['BAA', 'BLS'];

interface ShiftSupervisor {
  id: string;
  name: string;
  hpcsa_number: string;
  qualification: string;
}

/** Offline sync status bar — shows when PRFs are queued in the local outbox. */
function OfflineSyncBar() {
  const [count, setCount] = useState(0);
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  const refreshCount = async () => {
    try {
      const { getCount } = await import('../../services/offlineDb');
      setCount(await getCount());
    } catch { setCount(0); }
  };

  useEffect(() => {
    refreshCount();
    const onOutboxChange = () => refreshCount();
    const onOnline = () => { setIsOnline(true); refreshCount(); };
    const onOffline = () => setIsOnline(false);
    window.addEventListener('outbox-change', onOutboxChange);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('outbox-change', onOutboxChange);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  if (count === 0 && isOnline) return null;

  const handleRetry = async () => {
    try {
      const { startSync } = await import('../../services/syncEngine');
      await startSync();
    } catch { /* silent */ }
  };

  const bg = !isOnline ? '#fef2f2' : count > 0 ? '#fffbeb' : '#f0fdf4';
  const border = !isOnline ? '#fecaca' : count > 0 ? '#fcd34d' : '#bbf7d0';
  const textColor = !isOnline ? '#b91c1c' : count > 0 ? '#92400e' : '#166534';
  const icon = !isOnline ? '📵' : count > 0 ? '📤' : '✅';
  const label = !isOnline
    ? 'You are offline — changes are saved locally'
    : count > 0
    ? `${count} PRF${count > 1 ? 's' : ''} pending upload`
    : 'All synced';

  return (
    <div style={{
      marginBottom: 18, padding: '12px 16px', borderRadius: 12,
      background: bg, border: `1px solid ${border}`,
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: 12, transition: 'all 0.3s',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: '1.1rem' }}>{icon}</span>
        <div>
          <div style={{ fontSize: '0.82rem', fontWeight: 700, color: textColor }}>{label}</div>
          {!isOnline && count > 0 && (
            <div style={{ fontSize: '0.72rem', color: '#6b7280', marginTop: 2 }}>
              {count} item{count > 1 ? 's' : ''} will sync when you're back online
            </div>
          )}
        </div>
      </div>
      {isOnline && count > 0 && (
        <button
          onClick={handleRetry}
          style={{
            padding: '6px 14px', borderRadius: 8, fontSize: '0.75rem', fontWeight: 700,
            border: `1px solid ${border}`, background: '#fff', color: textColor,
            cursor: 'pointer', whiteSpace: 'nowrap', transition: 'all 0.15s',
          }}
        >
          Sync now
        </button>
      )}
    </div>
  );
}

export default function CrewDashboard() {
  const navigate = useNavigate();
  const { providerSlug } = useParams<{ providerSlug: string }>();

  const token = localStorage.getItem('crew_token');
  const profile = (() => { try { return JSON.parse(localStorage.getItem('crew_profile') || '{}'); } catch { return {}; } })();
  const savedVehicle = (() => { try { return JSON.parse(localStorage.getItem('active_vehicle') || 'null'); } catch { return null; } })();
  const initialExtraCrews = (() => {
    try {
      const raw = JSON.parse(localStorage.getItem('extra_crew_profiles') || 'null');
      if (Array.isArray(raw)) return raw;
    } catch { /* ignore */ }
    // Back-compat: an existing single crew2_profile becomes the first entry.
    try {
      const c2 = JSON.parse(localStorage.getItem('crew2_profile') || 'null');
      if (c2 && c2.id) return [c2];
    } catch { /* ignore */ }
    return [];
  })();

  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [vehiclesLoading, setVehiclesLoading] = useState(true);
  const [vehiclesError, setVehiclesError] = useState<string | null>(null);
  const [vehicleSearch, setVehicleSearch] = useState('');
  const [step, setStep] = useState<Step>(token ? null : 'vehicle');
  const [selectedVehicle, setSelectedVehicle] = useState<Vehicle | null>(savedVehicle);

  // Crew roster for the name-dropdown. Populated from
  // /api/providers/{slug}/public-crew when the dashboard mounts so the
  // crew picks themselves by name instead of typing an HPCSA number.
  // The HPCSA number is still the value stored in `crew1Hpcsa` and
  // `extraCrewHpcsa`, so the existing lookup-hpcsa shift-start flow
  // works unchanged.
  const [crewRoster, setCrewRoster] = useState<Array<{
    id: string; full_name: string; hpcsa_number: string; qualification: string;
  }>>([]);

  const [crew1Hpcsa, setCrew1Hpcsa] = useState('');
  const [extraCrewHpcsa, setExtraCrewHpcsa] = useState<string[]>([]);
  // Multi-select crew picker state
  const [crewPickerOpen, setCrewPickerOpen] = useState(false);
  const [selectedCrewHpcsas, setSelectedCrewHpcsas] = useState<string[]>([]);
  const [crewPickerSearch, setCrewPickerSearch] = useState('');
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [newPrfError, setNewPrfError] = useState('');
  const [endingShift, setEndingShift] = useState(false);
  const [drafts, setDrafts] = useState<any[]>([]);

  // Live list of additional crew shown on the personal dashboard. Mirrors
  // localStorage so refreshes don't drop the roster.
  const [dashboardExtraCrews, setDashboardExtraCrews] = useState<any[]>(initialExtraCrews);
  const [addCrewInput, setAddCrewInput] = useState<string | null>(null); // null = hidden
  const [addCrewBusy, setAddCrewBusy] = useState(false);
  const [addCrewError, setAddCrewError] = useState('');

  // Supervising practitioner — only captured when every crew member on the
  // shift is BAA (BLS only). Hydrated from localStorage so a page refresh
  // mid-shift doesn't re-prompt. Cleared on logout / shift end.
  const initialShiftSupervisor = (() => {
    try { return JSON.parse(localStorage.getItem('shift_supervisor') || 'null') as ShiftSupervisor | null; }
    catch { return null; }
  })();
  const [shiftSupervisor, setShiftSupervisor] = useState<ShiftSupervisor | null>(initialShiftSupervisor);
  const [pendingSupervisorHpcsa, setPendingSupervisorHpcsa] = useState('');
  const [supervisorError, setSupervisorError] = useState('');

  const persistExtraCrews = (list: any[]) => {
    setDashboardExtraCrews(list);
    if (list.length === 0) {
      localStorage.removeItem('extra_crew_profiles');
      localStorage.removeItem('crew2_profile');
    } else {
      localStorage.setItem('extra_crew_profiles', JSON.stringify(list));
      localStorage.setItem('crew2_profile', JSON.stringify(list[0]));
    }
  };

  const handleAddCrewFromDashboard = async (hpcsaOverride?: string) => {
    const hpcsa = (typeof hpcsaOverride === 'string' ? hpcsaOverride : addCrewInput || '').trim();
    if (!hpcsa) { setAddCrewError('HPCSA number is required.'); return; }
    setAddCrewBusy(true);
    setAddCrewError('');
    try {
      const r = await axios.post('/api/crew/lookup-hpcsa', {
        hpcsa_number: hpcsa,
        provider_slug: providerSlug,
      });
      const newProfile = {
        id: r.data.crew_id,
        name: r.data.full_name,
        hpcsa_number: r.data.hpcsa_number,
        qualification: r.data.qualification,
      };
      if (dashboardExtraCrews.some(c => c.id === newProfile.id) || newProfile.id === profile.id) {
        setAddCrewError('That crew member is already on this shift.');
      } else {
        persistExtraCrews([...dashboardExtraCrews, newProfile]);
        setAddCrewInput(null);
      }
    } catch (err: any) {
      setAddCrewError(err.response?.data?.detail || 'HPCSA number not found.');
    }
    setAddCrewBusy(false);
  };

  // Wipe every piece of crew session data from localStorage. Called when the
  // shift token is rejected (expired / revoked) so the dashboard doesn't keep
  // showing a stale "Maria · ALPHA 1" header backed by an unusable token.
  // After this fires, the dashboard navigates back to the provider login so
  // the crew can HPCSA-verify again — same crew row means their draft PRFs
  // reappear on the next dashboard mount.
  const clearCrewSession = () => {
    localStorage.removeItem('crew_token');
    localStorage.removeItem('crew_profile');
    localStorage.removeItem('crew2_profile');
    localStorage.removeItem('extra_crew_profiles');
    localStorage.removeItem('active_vehicle');
    localStorage.removeItem('last_prf_id');
    localStorage.removeItem('shift_supervisor');
    setShiftSupervisor(null);
  };

  const loadDrafts = (tkn: string) => {
    axios.get('/api/digital-prf', { headers: { Authorization: `Bearer ${tkn}` } })
      .then(res => setDrafts(res.data.filter((d: any) => d.status === 'draft')))
      .catch(err => {
        // 401 → shift token expired (12h cap) or revoked. Without this, the
        // dashboard would silently render an empty drafts list and the crew
        // would think their in-progress PRF disappeared.
        if (err?.response?.status === 401) {
          clearCrewSession();
          navigate(`/${providerSlug}/login`, { replace: true });
        }
      });
  };

  useEffect(() => {
    setVehiclesError(null);
    axios.get(`/api/providers/${providerSlug}/public-vehicles`)
      .then(res => setVehicles(res.data))
      .catch(err => {
        // Distinguish "couldn't reach server" from "no vehicles exist".
        // 404 means the provider slug is wrong; anything else (network
        // error, 500, etc.) means the API is down or unreachable.
        if (err?.response?.status === 404) {
          setVehiclesError('Provider not found. Check the URL.');
        } else {
          setVehiclesError('Could not reach the server. Check your connection and try again.');
        }
      })
      .finally(() => setVehiclesLoading(false));

    // Crew roster for the name-dropdown. Failures here aren't surfaced as
    // a blocker — the start-shift screen still works if the crew types
    // the HPCSA number directly into the underlying value.
    axios.get(`/api/providers/${providerSlug}/public-crew`)
      .then(res => setCrewRoster(res.data || []))
      .catch(() => { /* silent — dropdown just shows empty list */ });

    if (token) loadDrafts(token);
  }, [providerSlug, token]);

  // Refresh drafts whenever the crew returns to the tab. Closing the laptop
  // lid, switching apps on a phone, or just backgrounding the browser leaves
  // the dashboard component mounted but its drafts list frozen at last load.
  // Re-fetching on visibility / focus keeps the "Active PRFs" list in sync
  // with whatever they just finished on the form (or with drafts the backend
  // cleaned up). Reads the token fresh each time so a logout-elsewhere flow
  // doesn't fire stale auth.
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      const tkn = localStorage.getItem('crew_token');
      if (tkn) loadDrafts(tkn);
    };
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
    };
  // loadDrafts closes over `navigate`/`providerSlug` which are stable for a
  // given route, so an empty dep array is fine here. We intentionally do not
  // re-bind on every render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleLogout = async () => {
    // Re-entrancy guard: ignore double-clicks / repeat taps while a logout
    // is already in flight. Without this, the button looked "stale" because
    // the second click did nothing visible.
    if (endingShift) return;

    const draftCount = drafts.length;
    const warning = draftCount > 0
      ? `End this shift?\n\nThis will permanently DELETE ${draftCount} unfinished draft PRF${draftCount === 1 ? '' : 's'} and sign you out. Submitted PRFs are kept.\n\nOnly press End Shift at the end of your duty. If the tablet is just going to sleep, cancel this.`
      : 'End this shift?\n\nThis will sign you out. Only press End Shift at the end of your duty. If the tablet is just going to sleep, cancel this.';
    if (!window.confirm(warning)) return;

    setEndingShift(true);

    // Server-side cleanup: delete every DRAFT PRF this crew owns.
    // Submitted PRFs are billing records and are never touched.
    // Errors and timeouts are swallowed so a hung request doesn't strand the
    // crew on the dashboard — the local session still gets cleared. An
    // 8-second cap prevents the button from appearing frozen on a dead link.
    if (token) {
      try {
        const res = await axios.post('/api/digital-prf/end-shift', null, {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 8000,
        });
        const n = res.data?.drafts_deleted ?? 0;
        if (n > 0) console.info(`Shift ended — ${n} draft PRF(s) discarded`);
      } catch (err: any) {
        console.warn('Shift cleanup failed (continuing logout):', err?.message);
      }
    }

    localStorage.removeItem('crew_token');
    localStorage.removeItem('crew_profile');
    localStorage.removeItem('crew2_profile');
    localStorage.removeItem('extra_crew_profiles');
    localStorage.removeItem('active_vehicle');
    localStorage.removeItem('shift_supervisor');
    setShiftSupervisor(null);
    navigate(`/${providerSlug}/login`);
  };

  const openVehiclePicker = () => {
    setSelectedVehicle(null);
    setCrew1Hpcsa('');
    setExtraCrewHpcsa([]);
    setSelectedCrewHpcsas([]);
    setCrewPickerOpen(false);
    setCrewPickerSearch('');
    setVehicleSearch('');
    setError('');
    setShiftSupervisor(null);
    setPendingSupervisorHpcsa('');
    setSupervisorError('');
    setStep('vehicle');
  };

  /**
   * Close the shift-start modal.
   *
   * If the crew has not yet authenticated (no token), the personal dashboard
   * underneath would be exposed — bypassing HPCSA verification. So when the
   * user dismisses the modal mid-flow without a valid token, send them back
   * to the provider login page rather than dropping them on the dashboard.
   */
  const closeShiftModal = () => {
    setStep(null);
    if (!localStorage.getItem('crew_token')) {
      navigate(`/${providerSlug}/login`);
    }
  };

  const handleVehicleNext = () => {
    if (!selectedVehicle) { setError('Please select a vehicle to continue.'); return; }
    setError('');
    setStep('crew');
    setCrewPickerOpen(true);
    setCrewPickerSearch('');
  };

  /** Authenticate every crew member, then either start the shift or branch
   *  to the supervisor capture step if every crew on board is BAA. */
  const handleCrewLogin = async () => {
    if (selectedCrewHpcsas.length < 2) { setError('A minimum of 2 crew members is required.'); return; }
    // Derive crew1 (first selected) and extras from the unified selection
    const [derivedCrew1, ...derivedExtras] = selectedCrewHpcsas;
    setCrew1Hpcsa(derivedCrew1);
    setExtraCrewHpcsa(derivedExtras);
    setError('');
    setCreating(true);
    setStep('loading');

    try {
      // Use the derived crew1 / extras (set just above) or fall back to state.
      const c1 = derivedCrew1 ?? crew1Hpcsa;
      const extras = derivedExtras ?? extraCrewHpcsa;

      // Authenticate Crew 1
      const res1 = await axios.post('/api/crew/lookup-hpcsa', {
        hpcsa_number: c1.trim(),
        provider_slug: providerSlug,
      });
      const newToken = res1.data.access_token;
      const crew1Profile = {
        id: res1.data.crew_id,
        name: res1.data.full_name,
        hpcsa_number: res1.data.hpcsa_number,
        qualification: res1.data.qualification,
        provider_id: res1.data.provider_id,
        provider_name: res1.data.provider_name,
        provider_slug: res1.data.provider_slug,
      };
      localStorage.setItem('crew_token', newToken);
      localStorage.setItem('crew_profile', JSON.stringify(crew1Profile));

      // Authenticate additional crew members.
      // The first extra crew is mirrored into crew2_profile for backend
      // compatibility (PRF creation still sends crew_member_2_id); any beyond
      // that are kept in extra_crew_profiles for the UI.
      const lookups = await Promise.all(extras.map(h =>
        axios.post('/api/crew/lookup-hpcsa', {
          hpcsa_number: h.trim(),
          provider_slug: providerSlug,
        })
      ));
      const extraProfiles = lookups.map(r => ({
        id: r.data.crew_id,
        name: r.data.full_name,
        hpcsa_number: r.data.hpcsa_number,
        qualification: r.data.qualification,
      }));
      persistExtraCrews(extraProfiles);

      // Save vehicle for PRF creation
      localStorage.setItem('active_vehicle', JSON.stringify(selectedVehicle));

      // Load Crew 1's existing drafts
      loadDrafts(newToken);

      // HPCSA staffing rule (June 2017 §2.1, DoH EMS Regs 1 Dec 2017 §7.2):
      const allCrew = [crew1Profile, ...extraProfiles];
      const allBaa = allCrew.length > 0 && allCrew.every(c => BLS_CATEGORIES.includes((c.qualification || '').toUpperCase()));
      if (allBaa) {
        setError('Please add another crew member that is higher than BLS qualification.');
        setCrewPickerOpen(false);
        setStep('crew');
      } else {
        localStorage.removeItem('shift_supervisor');
        setShiftSupervisor(null);
        setStep(null);
      }
    } catch (err: any) {
      setError(err.response?.data?.detail || 'HPCSA number not found. Ensure the entered crew member(s) are registered.');
      setCrewPickerOpen(false);
      setStep('crew');
    }
    setCreating(false);
  };

  /** Create a new PRF using the stored vehicle + crew2 (+ supervisor, if BAA-only). */
  const handleNewPRF = async () => {
    const tkn = localStorage.getItem('crew_token');
    const vehicle: Vehicle | null = (() => { try { return JSON.parse(localStorage.getItem('active_vehicle') || 'null'); } catch { return null; } })();
    const crew2: any = (() => { try { return JSON.parse(localStorage.getItem('crew2_profile') || '{}'); } catch { return {}; } })();
    const supervisor: ShiftSupervisor | null = (() => {
      try { return JSON.parse(localStorage.getItem('shift_supervisor') || 'null'); }
      catch { return null; }
    })();

    if (!vehicle || !tkn) { openVehiclePicker(); return; }

    setCreating(true);
    setNewPrfError('');
    try {
      const prfRes = await axios.post('/api/digital-prf', {
        vehicle_id: vehicle.id,
        crew_member_2_id: crew2.id || null,
        // Supervisor only travels with the PRF when the shift was BAA-only.
        // The backend seeds these into form_data so the rules engine (which
        // reads `supervising_practitioner_pr`) sees them on every PRF.
        supervising_practitioner_pr: supervisor?.hpcsa_number || null,
        supervising_practitioner_name: supervisor?.name || null,
        supervising_practitioner_qualification: supervisor?.qualification || null,
      }, { headers: { Authorization: `Bearer ${tkn}` } });
      navigate(`/${providerSlug}/crew/prf/${prfRes.data.id}`);
    } catch (err: any) {
      setCreating(false);
      // Same 401 trap as loadDrafts — silently failing here made the New PRF
      // button "do nothing" when the shift token had expired.
      if (err?.response?.status === 401) {
        clearCrewSession();
        navigate(`/${providerSlug}/login`, { replace: true });
        return;
      }
      setNewPrfError(
        err?.response?.data?.detail ||
        'Could not start a new PRF. Check your connection and try again.'
      );
    }
  };

  // ── Styles ──
  const fieldStyle: React.CSSProperties = {
    width: '100%', padding: '13px 15px', fontSize: '0.93rem',
    borderRadius: 10, border: `1px solid ${B}`,
    background: BL, color: T, outline: 'none',
    boxSizing: 'border-box', marginBottom: 14,
    fontFamily: 'inherit', transition: 'all 0.2s',
  };
  const focusGreen = (e: React.FocusEvent<HTMLInputElement>) => {
    e.currentTarget.style.borderColor = G;
    e.currentTarget.style.background = '#fff';
    e.currentTarget.style.boxShadow = `0 0 0 3px rgba(16,185,129,0.1)`;
  };
  const blurReset = (e: React.FocusEvent<HTMLInputElement>) => {
    e.currentTarget.style.borderColor = B;
    e.currentTarget.style.background = BL;
    e.currentTarget.style.boxShadow = 'none';
  };


  return (
    <div style={{
      minHeight: '100vh', background: BL, color: T,
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    }}>

      {/* ── Header ── */}
      <div style={{
        padding: '14px 20px', background: '#fff', borderBottom: `1px solid ${B}`,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        {providerSlug?.toLowerCase() === 'jems' ? (
          <img src="/jems_logo.png" alt="JEMS Medical Services" style={{ height: 36, width: 'auto' }} />
        ) : (
          <div style={{ fontWeight: 800, fontSize: '1rem', color: T }}>EMS Portal</div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {profile.name && (
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: '0.8rem', fontWeight: 700, color: T }}>{profile.name}</div>
              <div style={{ fontSize: '0.67rem', color: M }}>{profile.qualification} · {profile.hpcsa_number}</div>
            </div>
          )}
          <button onClick={handleLogout} disabled={endingShift} style={{
            padding: '7px 15px', borderRadius: 8, fontSize: '0.78rem', fontWeight: 700,
            border: `1px solid ${B}`, background: '#fff', color: M,
            cursor: endingShift ? 'wait' : 'pointer',
            opacity: endingShift ? 0.6 : 1,
            transition: 'all 0.15s',
          }}
            onMouseEnter={e => { if (!endingShift) { e.currentTarget.style.color = '#b91c1c'; e.currentTarget.style.borderColor = '#fca5a5'; } }}
            onMouseLeave={e => { if (!endingShift) { e.currentTarget.style.color = M; e.currentTarget.style.borderColor = B; } }}
          >
            {endingShift ? 'Ending…' : 'End Shift'}
          </button>
        </div>
      </div>

      {/* ── Body ── */}
      <div style={{ maxWidth: 500, margin: '0 auto', padding: '28px 20px 60px' }}>

        {profile.name ? (
          /* ── Logged-in personal dashboard ── */
          <div style={{ marginBottom: 28 }}>
            <div style={{ fontSize: '0.65rem', fontWeight: 700, color: M, textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 6 }}>
              On Shift
            </div>
            <h1 style={{ fontSize: '1.45rem', fontWeight: 800, color: T, margin: '0 0 14px', letterSpacing: '-0.01em' }}>
              {profile.name}
            </h1>
            <div style={{ display: 'flex', gap: 10, marginBottom: 0, flexWrap: 'wrap' }}>
              {savedVehicle && (
                <div style={{
                  flex: '1 1 140px', minWidth: 140, padding: '11px 14px', borderRadius: 10,
                  background: '#fff', border: `1px solid ${B}`,
                  boxShadow: '0 1px 3px rgba(0,0,0,0.03)',
                }}>
                  <div style={{ fontSize: '0.58rem', fontWeight: 700, color: M, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Vehicle</div>
                  <div style={{ fontWeight: 800, fontSize: '0.88rem', color: T, marginTop: 3 }}>{savedVehicle.callsign}</div>
                  <div style={{ fontSize: '0.7rem', color: M, fontFamily: 'monospace' }}>{savedVehicle.registration}</div>
                </div>
              )}
              {dashboardExtraCrews.map((c, i) => (
                <div key={c.id || i} style={{
                  flex: '1 1 140px', minWidth: 140, padding: '11px 14px', borderRadius: 10,
                  background: '#fff', border: `1px solid ${B}`,
                  boxShadow: '0 1px 3px rgba(0,0,0,0.03)', position: 'relative',
                }}>
                  <button
                    type="button"
                    onClick={() => persistExtraCrews(dashboardExtraCrews.filter((_, idx) => idx !== i))}
                    aria-label="Remove crew member"
                    style={{
                      position: 'absolute', top: 4, right: 6,
                      background: 'none', border: 'none', color: M, cursor: 'pointer',
                      fontSize: '0.95rem', lineHeight: 1, padding: 4, fontWeight: 600,
                    }}
                  >×</button>
                  <div style={{ fontSize: '0.58rem', fontWeight: 700, color: GD, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Crew {i + 2}</div>
                  <div style={{ fontWeight: 800, fontSize: '0.88rem', color: T, marginTop: 3, paddingRight: 14 }}>{c.name}</div>
                  <div style={{ fontSize: '0.7rem', color: M, fontFamily: 'monospace' }}>{c.hpcsa_number}</div>
                </div>
              ))}
              {/* Supervising practitioner card — present only when the shift
                  was captured as BAA-only. Amber accent so it reads as a
                  supervision relationship distinct from on-vehicle crew. */}
              {shiftSupervisor && (
                <div style={{
                  flex: '1 1 140px', minWidth: 140, padding: '11px 14px', borderRadius: 10,
                  background: '#fffbeb', border: '1px solid #fcd34d',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.03)',
                }}>
                  <div style={{ fontSize: '0.58rem', fontWeight: 700, color: '#92400e', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                    Supervisor
                  </div>
                  <div style={{ fontWeight: 800, fontSize: '0.88rem', color: T, marginTop: 3 }}>{shiftSupervisor.name}</div>
                  <div style={{ fontSize: '0.7rem', color: M, fontFamily: 'monospace' }}>
                    {shiftSupervisor.hpcsa_number} · {shiftSupervisor.qualification}
                  </div>
                </div>
              )}
            </div>

            {/* Add crew member — available on dashboard so a logged-in crew
                member can pull a partner onto the shift after the fact. */}
            {addCrewInput === null ? (
              <button
                type="button"
                onClick={() => { setAddCrewInput(''); setAddCrewError(''); }}
                style={{
                  marginTop: 10, padding: '9px 14px',
                  borderRadius: 10, fontSize: '0.78rem', fontWeight: 600,
                  cursor: 'pointer', border: `1px dashed ${B}`,
                  background: '#fff', color: M,
                  display: 'inline-flex', alignItems: 'center', gap: 8,
                  transition: 'all 0.15s',
                }}
                onMouseOver={e => { e.currentTarget.style.borderColor = G; e.currentTarget.style.color = GD; }}
                onMouseOut={e => { e.currentTarget.style.borderColor = B; e.currentTarget.style.color = M; }}
              >
                <span style={{ fontSize: '1rem', fontWeight: 700, lineHeight: 1 }}>+</span>
                Add crew member
              </button>
            ) : (
              <div style={{ marginTop: 10, padding: '12px 14px', background: '#fff', border: `1px solid ${G}`, borderRadius: 14, boxShadow: `0 4px 20px rgba(16,185,129,0.12)` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingBottom: 10, borderBottom: `1px solid ${B}`, marginBottom: 10 }}>
                  <div style={{ fontSize: '0.62rem', fontWeight: 800, color: GD, textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                    Add Crew Member
                  </div>
                  <button
                    type="button"
                    onClick={() => { setAddCrewInput(null); setAddCrewError(''); }}
                    style={{ background: 'none', border: 'none', color: M, cursor: 'pointer', fontSize: '1.2rem', lineHeight: 1 }}
                  >×</button>
                </div>
                <div style={{ position: 'relative', marginBottom: 10 }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={M} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                    style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', opacity: 0.5 }}>
                    <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                  <input
                    value={addCrewInput}
                    onChange={e => setAddCrewInput(e.target.value)}
                    placeholder="Search by name or qualification…"
                    autoComplete="off"
                    autoFocus
                    style={{
                      width: '100%', padding: '9px 10px 9px 32px',
                      fontSize: '0.84rem', borderRadius: 8,
                      border: `1px solid ${B}`, background: '#f8fafc',
                      color: T, outline: 'none', boxSizing: 'border-box',
                      fontFamily: 'inherit',
                    }}
                    onFocus={focusGreen} onBlur={blurReset}
                  />
                </div>
                {addCrewError && (
                  <div style={{ marginBottom: 10, fontSize: '0.78rem', color: '#b91c1c', fontWeight: 600 }}>
                    {addCrewError}
                  </div>
                )}
                <div style={{ maxHeight: 240, overflowY: 'auto' }}>
                  {(() => {
                    const q = addCrewInput.trim().toLowerCase();
                    const filtered = crewRoster.filter(c => 
                      (!q || 
                      c.full_name.toLowerCase().includes(q) || 
                      c.qualification.toLowerCase().includes(q) || 
                      c.hpcsa_number.toLowerCase().includes(q)) &&
                      !(dashboardExtraCrews.some(ext => ext.id === c.id) || profile.id === c.id)
                    );
                    if (filtered.length === 0) return (
                      <div style={{ padding: '24px', textAlign: 'center', color: M, fontSize: '0.84rem' }}>
                        No available crew members found.
                      </div>
                    );
                    return filtered.map((c, idx) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => handleAddCrewFromDashboard(c.hpcsa_number)}
                        disabled={addCrewBusy}
                        style={{
                          width: '100%', padding: '10px 12px',
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          background: '#fff', border: 'none',
                          borderBottom: idx < filtered.length - 1 ? `1px solid ${B}` : 'none',
                          cursor: addCrewBusy ? 'wait' : 'pointer', textAlign: 'left',
                          transition: 'background 0.12s',
                        }}
                        onMouseOver={e => { e.currentTarget.style.background = '#f8fafc'; }}
                        onMouseOut={e => { e.currentTarget.style.background = '#fff'; }}
                      >
                        <div>
                          <div style={{ fontWeight: 700, fontSize: '0.88rem', color: T }}>{c.full_name}</div>
                          <div style={{ fontSize: '0.71rem', color: M, marginTop: 1, fontFamily: 'monospace' }}>
                            {c.hpcsa_number} · {c.qualification}
                          </div>
                        </div>
                        <div style={{ color: G, fontSize: '1.2rem', fontWeight: 300 }}>+</div>
                      </button>
                    ));
                  })()}
                </div>
              </div>
            )}
          </div>
        ) : (
          /* ── Pre-login state ── */
          <div style={{ marginBottom: 28 }}>
            <div style={{ fontSize: '0.65rem', fontWeight: 700, color: M, textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 6 }}>Crew Portal</div>
            <h1 style={{ fontSize: '1.45rem', fontWeight: 800, color: T, margin: '0 0 6px' }}>Start Your Shift</h1>
            <p style={{ color: M, fontSize: '0.88rem', marginBottom: 0, fontWeight: 400 }}>
              Select your vehicle and verify both crew HPCSA numbers to begin.
            </p>
          </div>
        )}

        {/* ── Offline Sync Status Bar ── */}
        <OfflineSyncBar />

        {/* ── Active PRFs (Drafts) ─────────────────────────────────────────
            Rendered ABOVE the New PRF button so a crew member returning
            mid-shift immediately sees the report they were already working
            on, instead of being tempted to start a fresh one. */}
        {drafts.length > 0 && (
          <div style={{ marginBottom: 28 }}>
            <h2 style={{ fontSize: '1rem', fontWeight: 800, color: T, marginBottom: 12 }}>
              Active PRFs
              <span style={{
                marginLeft: 8, background: G, color: '#fff',
                fontSize: '0.68rem', fontWeight: 800, borderRadius: 99, padding: '2px 8px',
              }}>{drafts.length}</span>
            </h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {drafts.map(d => (
                <button key={d.id} onClick={() => navigate(`/${providerSlug}/crew/prf/${d.id}`)} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '14px 18px', borderRadius: 14, textAlign: 'left',
                  border: `1px solid ${B}`, background: '#fff', cursor: 'pointer',
                  boxShadow: '0 1px 4px rgba(0,0,0,0.03)', transition: 'all 0.15s',
                }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = G; e.currentTarget.style.boxShadow = '0 4px 12px rgba(16,185,129,0.08)'; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = B; e.currentTarget.style.boxShadow = '0 1px 4px rgba(0,0,0,0.03)'; }}
                >
                  <div>
                    <div style={{ fontWeight: 800, fontSize: '0.92rem', color: T }}>PRF #{d.prf_number}</div>
                    <div style={{ fontSize: '0.72rem', color: M, marginTop: 3 }}>
                      {d.case_number && <span style={{ marginRight: 8, fontFamily: 'monospace' }}>{d.case_number}</span>}
                      {new Date(d.created_at).toLocaleDateString('en-ZA', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </div>
                  </div>
                  <div style={{ color: G, fontSize: '0.78rem', fontWeight: 700 }}>Resume →</div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ── New PRF primary action ── */}
        <button
          onClick={token && savedVehicle ? handleNewPRF : openVehiclePicker}
          disabled={creating}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            width: '100%', padding: '20px 22px', borderRadius: 16,
            background: creating ? '#94a3b8' : `linear-gradient(135deg, ${G}, ${GD})`,
            border: 'none', cursor: creating ? 'wait' : 'pointer', textAlign: 'left',
            boxShadow: creating ? 'none' : `0 6px 20px rgba(16,185,129,0.22)`,
            transition: 'all 0.15s',
          }}
          onMouseEnter={e => { if (!creating) { e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = `0 10px 28px rgba(16,185,129,0.28)`; } }}
          onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = creating ? 'none' : `0 6px 20px rgba(16,185,129,0.22)`; }}
          onTouchStart={e => { e.currentTarget.style.transform = 'scale(0.98)'; }}
          onTouchEnd={e => { e.currentTarget.style.transform = 'none'; }}
        >
          <div>
            <div style={{ fontSize: '1rem', fontWeight: 800, color: '#fff', marginBottom: 3 }}>
              {creating ? 'Creating PRF...' : 'New PRF'}
            </div>
            <div style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.72)', fontWeight: 400 }}>
              {token && savedVehicle ? `${savedVehicle.callsign} · Start new patient report` : 'Select vehicle and verify crew to begin'}
            </div>
          </div>
          <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: '1.4rem', fontWeight: 300, flexShrink: 0 }}>›</div>
        </button>
        {newPrfError && (
          <div style={{
            marginTop: 12, padding: '10px 14px', borderRadius: 10,
            background: '#fef2f2', border: '1px solid #fecaca',
            color: '#b91c1c', fontSize: '0.83rem', fontWeight: 600,
          }}>
            {newPrfError}
          </div>
        )}
      </div>

      {/* ── Centered Pop-Up Modal ── */}
      {step && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)',
            backdropFilter: 'blur(6px)', zIndex: 400,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 20,
          }}
          onClick={e => { if (e.target === e.currentTarget && step !== 'loading') closeShiftModal(); }}
        >
          <div style={{
            position: 'relative',
            background: '#fff', borderRadius: 18,
            padding: '26px 26px 28px',
            width: '100%', maxWidth: 520, maxHeight: '90vh', overflowY: 'auto',
            boxShadow: '0 24px 60px rgba(0,0,0,0.25), 0 6px 20px rgba(0,0,0,0.12)',
            border: `1px solid ${B}`,
          }}>
            {/* Close × button */}
            {step !== 'loading' && (
              <button onClick={closeShiftModal}
                aria-label="Close"
                style={{
                  position: 'absolute', top: 14, right: 14,
                  width: 30, height: 30, borderRadius: 8,
                  border: `1px solid ${B}`, background: '#fff',
                  color: M, fontSize: '1rem', fontWeight: 700,
                  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  padding: 0, lineHeight: 1,
                }}>×</button>
            )}

            {/* ── Step 1: Select Vehicle ── */}
            {step === 'vehicle' && (
              <>
                <div style={{ fontSize: '1.05rem', fontWeight: 800, color: T, marginBottom: 4 }}>Select Vehicle</div>
                <p style={{ color: M, fontSize: '0.82rem', marginBottom: 20 }}>
                  Choose the vehicle assigned for this shift.
                </p>
                {error && (
                  <div style={{ padding: '10px 14px', borderRadius: 8, background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c', fontSize: '0.83rem', fontWeight: 600, marginBottom: 16 }}>
                    {error}
                  </div>
                )}
                {vehiclesLoading ? (
                  <div style={{ textAlign: 'center', padding: '32px 0', color: M, fontSize: '0.88rem' }}>Loading vehicles...</div>
                ) : vehiclesError ? (
                  <div style={{ padding: '20px', background: '#fef2f2', borderRadius: 12, border: '1px solid #fecaca', color: '#b91c1c', fontSize: '0.86rem', textAlign: 'center', fontWeight: 600 }}>
                    {vehiclesError}
                    <button onClick={() => {
                      setVehiclesLoading(true);
                      setVehiclesError(null);
                      axios.get(`/api/providers/${providerSlug}/public-vehicles`)
                        .then(res => setVehicles(res.data))
                        .catch(err => setVehiclesError(err?.response?.status === 404 ? 'Provider not found. Check the URL.' : 'Could not reach the server. Check your connection and try again.'))
                        .finally(() => setVehiclesLoading(false));
                    }} style={{ display: 'block', margin: '12px auto 0', padding: '8px 16px', borderRadius: 8, fontSize: '0.78rem', fontWeight: 700, border: '1px solid #fca5a5', background: '#fff', color: '#b91c1c', cursor: 'pointer' }}>
                      Retry
                    </button>
                  </div>
                ) : vehicles.length === 0 ? (
                  <div style={{ padding: '20px', background: BL, borderRadius: 12, border: `1px solid ${B}`, color: M, fontSize: '0.86rem', textAlign: 'center' }}>
                    No vehicles registered. Contact your administrator.
                  </div>
                ) : (
                  <>
                    <div style={{ position: 'relative', marginBottom: 14 }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={M} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
                        style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', opacity: 0.45 }}>
                        <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                      </svg>
                      <input
                        value={vehicleSearch}
                        onChange={e => setVehicleSearch(e.target.value)}
                        placeholder="Search callsign or registration"
                        autoComplete="off"
                        style={{
                          width: '100%', padding: '11px 34px', fontSize: '0.88rem', borderRadius: 10,
                          border: `1px solid ${B}`, background: BL, color: T, outline: 'none',
                          boxSizing: 'border-box', fontFamily: 'inherit', transition: 'all 0.2s',
                        }}
                        onFocus={e => { e.currentTarget.style.borderColor = G; e.currentTarget.style.background = '#fff'; e.currentTarget.style.boxShadow = `0 0 0 3px rgba(16,185,129,0.1)`; }}
                        onBlur={e => { e.currentTarget.style.borderColor = B; e.currentTarget.style.background = BL; e.currentTarget.style.boxShadow = 'none'; }}
                      />
                      {vehicleSearch.length > 0 && (
                        <button onClick={() => setVehicleSearch('')}
                          style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', fontSize: '1.1rem', lineHeight: 1 }}>
                          ×
                        </button>
                      )}
                    </div>
                    {(() => {
                      const q = vehicleSearch.trim().toLowerCase();
                      const filtered = q ? vehicles.filter(v => v.callsign.toLowerCase().includes(q) || v.registration.toLowerCase().includes(q)) : vehicles;
                      return filtered.length === 0 ? (
                        <div style={{ padding: '16px', background: BL, borderRadius: 12, border: `1px solid ${B}`, color: M, fontSize: '0.84rem', textAlign: 'center', marginBottom: 20 }}>
                          No vehicles match your search.
                        </div>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 20 }}>
                          {filtered.map(v => (
                            <button key={v.id} onClick={() => setSelectedVehicle(v)} style={{
                              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                              padding: '14px 16px', borderRadius: 12, textAlign: 'left',
                              border: `2px solid ${selectedVehicle?.id === v.id ? G : B}`,
                              background: selectedVehicle?.id === v.id ? 'rgba(16,185,129,0.04)' : '#fff',
                              cursor: 'pointer', transition: 'all 0.15s',
                              boxShadow: selectedVehicle?.id === v.id ? `0 0 0 3px rgba(16,185,129,0.08)` : 'none',
                            }}>
                              <div>
                                <div style={{ fontWeight: 800, fontSize: '0.94rem', color: T }}>{v.callsign}</div>
                                <div style={{ fontSize: '0.76rem', color: M, marginTop: 3, fontFamily: 'monospace', letterSpacing: '0.04em' }}>{v.registration} · {v.vehicle_type}</div>
                              </div>
                              {selectedVehicle?.id === v.id && (
                                <div style={{ width: 22, height: 22, borderRadius: '50%', background: G, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                  <svg width="11" height="8" viewBox="0 0 11 8" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                    <polyline points="1,4 4,7 10,1" />
                                  </svg>
                                </div>
                              )}
                            </button>
                          ))}
                        </div>
                      );
                    })()}
                  </>
                )}
                <button onClick={handleVehicleNext} disabled={!selectedVehicle} style={{
                  width: '100%', padding: '14px',
                  background: selectedVehicle ? `linear-gradient(135deg, ${G}, ${GD})` : '#e2e8f0',
                  color: selectedVehicle ? '#fff' : '#94a3b8',
                  border: 'none', borderRadius: 10, fontSize: '0.95rem', fontWeight: 700,
                  cursor: selectedVehicle ? 'pointer' : 'not-allowed', letterSpacing: '0.02em', transition: 'all 0.2s',
                }}>
                  Continue
                </button>
              </>
            )}

            {/* ── Step 2: Crew Verification ── */}
            {step === 'crew' && (
              <>
                {/* Header */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
                  <button onClick={() => { setStep('vehicle'); setError(''); setCrewPickerOpen(false); setSelectedCrewHpcsas([]); setCrewPickerSearch(''); }} style={{
                    background: 'none', border: 'none', color: GD,
                    fontSize: '1.2rem', cursor: 'pointer', padding: 0, lineHeight: 1, fontWeight: 600,
                  }}>←</button>
                  <div>
                    <div style={{ fontSize: '1.05rem', fontWeight: 800, color: T }}>Crew Verification</div>
                    <div style={{ fontSize: '0.74rem', color: M, marginTop: 2, fontFamily: 'monospace', letterSpacing: '0.04em' }}>
                      {selectedVehicle?.callsign}
                    </div>
                  </div>
                </div>

                {error && selectedCrewHpcsas.length >= 2 && (
                  <div style={{
                    padding: '10px 14px', borderRadius: 8, background: '#fef2f2',
                    border: '1px solid #fecaca', color: '#b91c1c',
                    fontSize: '0.83rem', fontWeight: 600, marginBottom: 16,
                  }}>
                    {error}
                  </div>
                )}

                {/* Selected crew chips */}
                {selectedCrewHpcsas.length > 0 && (
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: '0.62rem', fontWeight: 800, color: M, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8 }}>
                      Attending Crew ({selectedCrewHpcsas.length})
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {selectedCrewHpcsas.map((hpcsa, idx) => {
                        const member = crewRoster.find(c => c.hpcsa_number === hpcsa);
                        return (
                          <div key={hpcsa} style={{
                            display: 'inline-flex', alignItems: 'center', gap: 6,
                            padding: '5px 10px 5px 12px',
                            background: idx === 0 ? 'rgba(16,185,129,0.1)' : '#f1f5f9',
                            border: `1px solid ${idx === 0 ? G : B}`,
                            borderRadius: 99, fontSize: '0.78rem', fontWeight: 700,
                            color: idx === 0 ? GD : T,
                          }}>
                            {idx === 0 && <span style={{ fontSize: '0.6rem', background: G, color: '#fff', borderRadius: 99, padding: '1px 6px', fontWeight: 800, letterSpacing: '0.04em', textTransform: 'uppercase' }}>Primary</span>}
                            {member?.full_name ?? hpcsa}
                            <button
                              type="button"
                              onClick={() => setSelectedCrewHpcsas(prev => prev.filter(h => h !== hpcsa))}
                              style={{
                                background: 'none', border: 'none', cursor: 'pointer',
                                color: idx === 0 ? GD : '#64748b', fontSize: '0.9rem', lineHeight: 1,
                                padding: '0 2px', fontWeight: 700,
                              }}
                              aria-label={`Remove ${member?.full_name ?? hpcsa}`}
                            >×</button>
                          </div>
                        );
                      })}
                    </div>

                  </div>
                )}

                {/* Add Crew Members button / picker panel */}
                {!crewPickerOpen ? (
                  <button
                    type="button"
                    onClick={() => { setCrewPickerOpen(true); setCrewPickerSearch(''); }}
                    style={{
                      width: '100%', padding: '14px 18px', marginBottom: 20,
                      borderRadius: 12, fontSize: '0.9rem', fontWeight: 700,
                      cursor: 'pointer', border: `2px dashed ${G}`,
                      background: 'rgba(16,185,129,0.04)', color: GD,
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
                      transition: 'all 0.15s',
                    }}
                    onMouseOver={e => { e.currentTarget.style.background = 'rgba(16,185,129,0.09)'; e.currentTarget.style.borderColor = GD; }}
                    onMouseOut={e => { e.currentTarget.style.background = 'rgba(16,185,129,0.04)'; e.currentTarget.style.borderColor = G; }}
                  >
                    <span style={{
                      width: 22, height: 22, borderRadius: '50%',
                      background: `linear-gradient(135deg, ${G}, ${GD})`,
                      color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: '1rem', fontWeight: 700, flexShrink: 0, lineHeight: 1,
                    }}>+</span>
                    Add Crew Members
                  </button>
                ) : (
                  <div style={{
                    marginBottom: 20, border: `1px solid ${G}`,
                    borderRadius: 14, overflow: 'hidden',
                    boxShadow: `0 4px 20px rgba(16,185,129,0.12)`,
                  }}>
                    {/* Search */}
                    <div style={{ padding: '10px 14px', background: '#f8fafc', borderBottom: `1px solid ${B}` }}>
                      <div style={{ position: 'relative' }}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={M} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                          style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', opacity: 0.5 }}>
                          <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                        </svg>
                        <input
                          value={crewPickerSearch}
                          onChange={e => setCrewPickerSearch(e.target.value)}
                          placeholder="Search by name or qualification…"
                          autoComplete="off"
                          style={{
                            width: '100%', padding: '9px 10px 9px 32px',
                            fontSize: '0.84rem', borderRadius: 8,
                            border: `1px solid ${B}`, background: '#fff',
                            color: T, outline: 'none', boxSizing: 'border-box',
                            fontFamily: 'inherit',
                          }}
                          onFocus={focusGreen} onBlur={blurReset}
                        />
                      </div>
                    </div>

                    {/* Crew list */}
                    <div style={{ maxHeight: 280, overflowY: 'auto', background: '#fff' }}>
                      {(() => {
                        const q = crewPickerSearch.trim().toLowerCase();
                        const filtered = crewRoster.filter(c =>
                          !q ||
                          c.full_name.toLowerCase().includes(q) ||
                          c.qualification.toLowerCase().includes(q) ||
                          c.hpcsa_number.toLowerCase().includes(q)
                        );
                        if (filtered.length === 0) return (
                          <div style={{ padding: '24px', textAlign: 'center', color: M, fontSize: '0.84rem' }}>
                            No crew members found.
                          </div>
                        );
                        return filtered.map((c, idx) => {
                          const isSelected = selectedCrewHpcsas.includes(c.hpcsa_number);
                          const isPrimary = selectedCrewHpcsas[0] === c.hpcsa_number;
                          return (
                            <button
                              key={c.id}
                              type="button"
                              onClick={() => {
                                setSelectedCrewHpcsas(prev =>
                                  isSelected
                                    ? prev.filter(h => h !== c.hpcsa_number)
                                    : [...prev, c.hpcsa_number]
                                );
                              }}
                              style={{
                                width: '100%', padding: '13px 16px',
                                display: 'flex', alignItems: 'center', gap: 12,
                                background: isSelected ? 'rgba(16,185,129,0.06)' : '#fff',
                                border: 'none',
                                borderBottom: idx < filtered.length - 1 ? `1px solid ${B}` : 'none',
                                cursor: 'pointer', textAlign: 'left',
                                transition: 'background 0.12s',
                              }}
                              onMouseOver={e => { if (!isSelected) e.currentTarget.style.background = '#f8fafc'; }}
                              onMouseOut={e => { if (!isSelected) e.currentTarget.style.background = '#fff'; }}
                            >
                              {/* Checkbox circle */}
                              <div style={{
                                width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
                                border: `2px solid ${isSelected ? G : B}`,
                                background: isSelected ? G : '#fff',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                transition: 'all 0.15s',
                              }}>
                                {isSelected && (
                                  <svg width="10" height="8" viewBox="0 0 10 8" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                    <polyline points="1,4 3.5,6.5 9,1" />
                                  </svg>
                                )}
                              </div>
                              {/* Info */}
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                  <div style={{ fontWeight: 700, fontSize: '0.88rem', color: isSelected ? GD : T, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                    {c.full_name}
                                  </div>
                                  {isPrimary && (
                                    <span style={{ fontSize: '0.58rem', background: G, color: '#fff', borderRadius: 99, padding: '1px 6px', fontWeight: 800, letterSpacing: '0.04em', textTransform: 'uppercase', flexShrink: 0 }}>Primary</span>
                                  )}
                                </div>
                                <div style={{ fontSize: '0.71rem', color: M, marginTop: 1, fontFamily: 'monospace' }}>
                                  {c.hpcsa_number} · {c.qualification}
                                </div>
                              </div>
                            </button>
                          );
                        });
                      })()}
                    </div>

                  </div>
                )}

                {/* Confirm Crew Members → starts shift */}
                {selectedCrewHpcsas.length > 0 && (
                  <button
                    onClick={handleCrewLogin}
                    style={{
                      width: '100%', padding: '15px',
                      background: `linear-gradient(135deg, ${G}, ${GD})`,
                      color: '#fff',
                      border: 'none', borderRadius: 12, fontSize: '0.97rem', fontWeight: 800,
                      cursor: 'pointer',
                      letterSpacing: '0.02em', transition: 'all 0.2s',
                      boxShadow: `0 4px 16px rgba(16,185,129,0.22)`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                    }}
                    onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = `0 8px 24px rgba(16,185,129,0.3)`; }}
                    onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = `0 4px 16px rgba(16,185,129,0.22)`; }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                      <circle cx="9" cy="7" r="4" />
                      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                    </svg>
                    Confirm Crew Members &amp; Start Shift
                  </button>
                )}
                {/* Soft warning — only shown after a failed confirmation attempt */}
                {error && selectedCrewHpcsas.length < 2 && (
                  <div style={{
                    marginTop: 10, padding: '10px 14px', borderRadius: 10,
                    background: '#fffbeb', border: '1px solid #fcd34d',
                    color: '#92400e', fontSize: '0.82rem', fontWeight: 600,
                    display: 'flex', alignItems: 'center', gap: 8,
                  }}>
                    <span style={{ fontSize: '1rem' }}>⚠️</span>
                    {error}
                  </div>
                )}
              </>
            )}



            {/* ── Loading ── */}
            {step === 'loading' && (
              <div style={{ textAlign: 'center', padding: '44px 0' }}>
                <div style={{
                  width: 48, height: 48, borderRadius: '50%',
                  border: `4px solid rgba(16,185,129,0.15)`, borderTopColor: G,
                  animation: 'spin 0.75s linear infinite', margin: '0 auto 20px',
                }} />
                <div style={{ fontWeight: 700, fontSize: '0.95rem', color: T }}>Verifying crew</div>
                <div style={{ fontSize: '0.8rem', color: M, marginTop: 6 }}>Setting up your shift...</div>
                <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
