/**
 * ProviderManagement — Admin page to manage Service Providers, Crew, and Vehicles.
 * Accessible from the admin sidebar.
 */
import { useState, useEffect, useCallback } from 'react';
import api from '../api/client';
import { useScrollLock } from '../hooks/useScrollLock';
import useIsMobile from '../hooks/useIsMobile';
import { LoadErrorPanel, LoadErrorBar } from '../components/LoadError';
import { HPCSA_CATEGORIES, CATEGORY_META } from '../data/hpcsaScope';

// Qualification stores an HPCSA REGISTRATION CATEGORY, never a billing tier.
// This picker previously offered BLS / ILS / ALS as well, which the backend
// silently normalised on save (ALS -> ECP, ILS -> AEA), so an admin's explicit
// choice was rewritten behind their back - and ECT / ECA / ANT could not be
// selected at all. Only the canonical categories are offered now; the tier a
// category bills at is derived downstream (app/utils/hpcsa.py CATEGORY_TIER).
const QUAL_OPTIONS = HPCSA_CATEGORIES.map(code => ({
  value: code as string,
  label: `${code} — ${CATEGORY_META[code].label} (${CATEGORY_META[code].tier})`,
}));

/** A stored value that is not a canonical category (legacy tier / OCR text).
 *  Surfaced in the picker as-is so the admin SEES it and can correct it -
 *  never silently remapped. */
const legacyOption = (v: string | undefined | null) =>
  v && !HPCSA_CATEGORIES.includes(v as never)
    ? [{ value: v, label: `${v} — legacy value, please re-select` }]
    : [];

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
  // PRF outbound email account — the address submitted PRF PDFs are emailed
  // FROM to receiving facilities. Password is write-only (never returned).
  smtp_service?: string | null;
  smtp_email?: string | null;
  smtp_configured?: boolean;
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
const PowerIcon = ({ size = 16 }: IconProps) => (
  <svg {...svgBase(size)}><path d="M18.36 6.64a9 9 0 1 1-12.73 0M12 2v10" /></svg>
);
// Deactivation is visible on the name tag itself, in the client list and the
// crew list, rather than only inside the edit form. A deactivated company that
// looks identical to a working one is how a crew ends up phoning to ask why
// their sign-in stopped.
const DeactivatedBadge = ({ compact = false }: { compact?: boolean }) => (
  <span
    title="Deactivated — cannot sign in"
    style={{
      display: 'inline-flex', alignItems: 'center', flexShrink: 0,
      background: 'rgba(180,83,9,0.12)', color: '#b45309',
      border: '1px solid rgba(180,83,9,0.35)', borderRadius: 999,
      padding: compact ? '1px 7px' : '2px 9px',
      fontSize: compact ? '0.6rem' : '0.65rem', fontWeight: 800,
      textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap',
    }}
  >
    Deactivated
  </span>
);
const SpinnerIcon = ({ size = 16 }: IconProps) => (
  <svg {...svgBase(size)} style={{ animation: 'pm-spin 0.8s linear infinite' }}>
    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
  </svg>
);

interface LockedAccount {
  account_type: 'provider' | 'crew';
  id: string;
  name: string;
  login_email: string | null;
  phone: string | null;
  provider_name: string | null;
  failed_attempts: number;
  locked_until: string | null;
}

/**
 * Exact port of _slugify in backend/app/api/providers.py.
 *
 * The slug is derived from the company name, is globally unique, routes a crew
 * to their tenant AND names the logo file on disk — so a second client whose
 * name reduces to the same slug is refused outright. That refusal is correct,
 * but it used to arrive only after the worker had filled in the whole form and
 * pressed Create. Predicting it as they type turns a lost entry into a rename.
 *
 * If this drifts from the backend the warning is simply wrong, so it is a
 * character-for-character port, pinned in providerOnboardingModal.test.tsx.
 */
export function slugifyProviderName(name: string): string {
  return name.toLowerCase().trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

/** Inline warning shown under a field whose value would be refused on save. */
function FieldWarning({ children }: { children: React.ReactNode }) {
  return (
    <div role="alert" style={{
      display: 'flex', alignItems: 'flex-start', gap: 7,
      margin: '6px 0 2px', padding: '8px 10px', borderRadius: 8,
      background: '#fffbeb', border: '1px solid #f59e0b',
      fontSize: '0.76rem', lineHeight: 1.45, color: '#78350f',
    }}>
      <span style={{ flexShrink: 0, marginTop: 1 }}><WarnIcon size={14} /></span>
      <span>{children}</span>
    </div>
  );
}

export default function ProviderManagement() {
  const isMobile = useIsMobile();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [locked, setLocked] = useState<LockedAccount[]>([]);
  const [unlockingId, setUnlockingId] = useState<string | null>(null);

  // Modal states
  const [showAddProvider, setShowAddProvider] = useState(false);
  const [addingProvider, setAddingProvider] = useState(false);

  // Onboarding is a repetitive job — an admin worker enters ~100 clients in one
  // sitting — so the modal MUST start empty every time. The reset used to live
  // only at the end of a fully successful create, which meant Cancel, the ×, or
  // any failure left the previous client's logo file, portal password, admin
  // password and Gmail app password sitting in state. The next client created
  // then silently inherited another company's credentials and logo. Opening and
  // closing both clear it, so there is no path that carries data across.
  const blankProvider = () => ({ name: '', phone: '', email: '', prNumber: '', ptyRegNumber: '', prfName: '', address: '', prfNumber: '', clientEmail: '', clientPassword: '', adminEmail: '', adminPassword: '', smtpService: 'gmail', smtpEmail: '', smtpPassword: '' });
  const openAddProvider = () => {
    setNewProvider(blankProvider());
    setLogoFile(null);
    setShowAddProvider(true);
  };
  const closeAddProvider = () => {
    setShowAddProvider(false);
    setNewProvider(blankProvider());
    setLogoFile(null);
  };
  const [selectedProvider, setSelectedProvider] = useState<Provider | null>(null);
  const [activeTab, setActiveTab] = useState<'crew' | 'vehicles'>('crew');

  // Edit client modal state
  const [showEditClient, setShowEditClient] = useState(false);
  const [editForm, setEditForm] = useState({ name: '', pr_number: '', prf_name: '', phone: '', email: '', address: '', is_active: true, portal_username: '', portal_password: '', admin_email: '', admin_password: '', prfNumber: '', smtp_service: 'gmail', smtp_email: '', smtp_password: '' });
  const [editSaving, setEditSaving] = useState(false);
  // Deactivate, not delete. A client cannot be removed: their crew are named on
  // submitted PRFs and on the record of who opened which patient's file, and
  // both have to be retained. See the danger-zone panel below.
  const [showDeactivateConfirm, setShowDeactivateConfirm] = useState(false);
  const [togglingActive, setTogglingActive] = useState(false);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  // A logo_url can outlive the file it points at — the row lives in the
  // database while the image lives in the uploads volume, so a restore, a
  // rebuilt volume or a failed upload leaves the URL pointing at nothing.
  // Without an onError the browser paints its broken-image glyph, which is
  // what "the logo is showing blank" looks like. Falling back to the initial
  // tile keeps the row readable. Same fix PRFView's ProviderLogo already has.
  const [logoFailed, setLogoFailed] = useState<Set<string>>(new Set());
  const [logoPreviewFailed, setLogoPreviewFailed] = useState(false);
  const [logoUploading, setLogoUploading] = useState(false);

  // Crew/Vehicle lists for selected provider
  const [crew, setCrew] = useState<CrewMember[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [crewLoading, setCrewLoading] = useState(false);

  // Add forms
  const [newProvider, setNewProvider] = useState({ name: '', phone: '', email: '', prNumber: '', ptyRegNumber: '', prfName: '', address: '', prfNumber: '', clientEmail: '', clientPassword: '', adminEmail: '', adminPassword: '', smtpService: 'gmail', smtpEmail: '', smtpPassword: '' });

  // Live clashes against the clients already loaded on this page. The server
  // still enforces all three — this only moves the discovery earlier.
  const typedSlug = slugifyProviderName(newProvider.name);
  const slugClash = newProvider.name.trim() && typedSlug
    ? providers.find(p => p.slug === typedSlug)
    : undefined;
  // A name of only punctuation reduces to nothing, and the server rejects an
  // empty slug — with a message about slugs, which means nothing to a worker.
  const nameHasNoUsableCharacters = !!newProvider.name.trim() && !typedSlug;
  const norm = (v?: string | null) => (v || '').trim().toLowerCase();
  const portalClash = norm(newProvider.clientEmail)
    ? providers.find(p => norm(p.portal_login_username) === norm(newProvider.clientEmail))
    : undefined;
  const adminClash = norm(newProvider.adminEmail)
    ? providers.find(p => norm(p.admin_email) === norm(newProvider.adminEmail))
    : undefined;
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [newCrew, setNewCrew] = useState({ full_name: '', email: '', initials: '', hpcsa_number: '', qualification: 'AEA', phone: '' });
  const [newVehicle, setNewVehicle] = useState({ callsign: '', registration: '', vehicle_type: 'Ambulance' });
  const [showAddCrew, setShowAddCrew] = useState(false);
  const [showAddVehicle, setShowAddVehicle] = useState(false);

  const [showEditVehicle, setShowEditVehicle] = useState(false);
  const [editingVehicleId, setEditingVehicleId] = useState<string | null>(null);
  const [editVehicleForm, setEditVehicleForm] = useState({ callsign: '', registration: '', vehicle_type: 'Ambulance' });
  const [editVehicleSaving, setEditVehicleSaving] = useState(false);
  
  const [showEditCrew, setShowEditCrew] = useState(false);
  const [editingCrewId, setEditingCrewId] = useState<string | null>(null);
  const [editCrewForm, setEditCrewForm] = useState({ full_name: '', email: '', initials: '', hpcsa_number: '', qualification: 'AEA', phone: '' });
  const [editCrewSaving, setEditCrewSaving] = useState(false);

  // Lock the background page while any pop-up on this screen is open.
  useScrollLock(showAddProvider || showEditClient || showAddCrew || showEditCrew || showAddVehicle || showEditVehicle);
  const [tempPassword, setTempPassword] = useState('');

  // Failed load ≠ no clients — without this an unreachable backend rendered
  // "No service providers yet" over a full client list.
  const [loadError, setLoadError] = useState(false);

  const fetchProviders = useCallback(async () => {
    setLoading(true);
    try {
      // Revalidate rather than reading the browser's 60s copy — see
      // fetchProviderDetails. This list carries the Deactivated badge.
      const res = await api.get('/api/providers', {
        headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
      });
      setProviders(res.data);
      setLoadError(false);
    } catch { setLoadError(true); }
    setLoading(false);
  }, []);

  useEffect(() => { fetchProviders(); }, [fetchProviders]);

  // ── Locked-account awareness ──────────────────────────────────────────────
  // Providers (or their crew) locked out after too many failed logins surface
  // at the TOP of the list with a red/amber "!" — hover explains, and an
  // Unlock button clears the lock once the admin has verified by phone.
  const fetchLocked = useCallback(async () => {
    try {
      const res = await api.get('/api/account-security/locked');
      const data = res.data || [];
      setLocked(data);
      // Keep the Clients nav-tab badge in sync (updates it instantly after an
      // unlock instead of waiting for its own 60s poll).
      window.dispatchEvent(new CustomEvent('locked-accounts-changed', { detail: { count: data.length } }));
    } catch { /* ignore — indicators just won't show */ }
  }, []);
  useEffect(() => {
    fetchLocked();
    const t = setInterval(fetchLocked, 60000);
    return () => clearInterval(t);
  }, [fetchLocked]);

  // Locked accounts belonging to a provider: its own portal login (matched by
  // id) plus any of its crew (matched by provider name).
  const lockedFor = (p: Provider): LockedAccount[] => locked.filter(a =>
    (a.account_type === 'provider' && a.id === p.id) ||
    (a.account_type === 'crew' && a.provider_name === p.name)
  );

  const lockTooltip = (accts: LockedAccount[]): string => {
    const lines = accts.map(a => {
      const when = a.locked_until
        ? new Date(a.locked_until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : '';
      const who = a.account_type === 'provider' ? 'Portal login' : `Crew: ${a.name}`;
      return `• ${who} — ${a.failed_attempts} failed attempts${when ? `, locked until ${when}` : ''}`;
    });
    return `Locked out — too many failed login attempts:\n${lines.join('\n')}\n\nPhone the client to confirm it was really them, then Unlock.`;
  };

  const unlockProvider = async (p: Provider, accts: LockedAccount[], e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm(`Unlock ${p.name}? Only do this once you've confirmed by phone that it was genuinely them.`)) return;
    setUnlockingId(p.id);
    try {
      for (const a of accts) {
        await api.post('/api/account-security/unlock', { account_type: a.account_type, id: a.id });
      }
      await fetchLocked();
    } catch (err: any) {
      alert(err?.response?.data?.detail || 'Unlock failed.');
    } finally {
      setUnlockingId(null);
    }
  };

  // Locked clients float to the top of the list.
  const sortedProviders = [...providers].sort(
    (a, b) => (lockedFor(b).length ? 1 : 0) - (lockedFor(a).length ? 1 : 0)
  );

  const fetchProviderDetails = async (provider: Provider) => {
    setSelectedProvider(provider);
    setCrewLoading(true);
    try {
      // Ask the BROWSER to revalidate. /api/providers is served with
      // `Cache-Control: private, max-age=60`, so after deactivating a client —
      // or adding, editing or removing a crew member — this refetch was
      // answered out of the browser's own cache and the table kept showing the
      // pre-change state for up to a minute. Purging the server-side cache
      // (which the write already does) cannot reach that copy.
      const fresh = { headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' } };
      const [crewRes, vehicleRes] = await Promise.all([
        api.get(`/api/providers/${provider.id}/crew`, fresh),
        api.get(`/api/providers/${provider.id}/vehicles`, fresh),
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
      // PRF sending account — service + email prefill; app password is
      // write-only (blank = keep the stored one).
      smtp_service: selectedProvider.smtp_service || 'gmail',
      smtp_email: selectedProvider.smtp_email || '',
      smtp_password: '',
    });
    setLogoPreview(selectedProvider.logo_url || null);
    setLogoPreviewFailed(false);
    setShowEditClient(true);
    setShowDeactivateConfirm(false);
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
        // is_active is NOT sent from this form. Activation is a lifecycle
        // action with a crew cascade behind it — /deactivate and /reactivate,
        // below — and saving contact details must never move it.
        // Credential fields — only send if user typed something
        portal_login_username: editForm.portal_username.trim() || undefined,
        portal_login_password: editForm.portal_password.trim() || undefined,
        admin_email: editForm.admin_email.trim() || undefined,
        admin_password: editForm.admin_password.trim() || undefined,
        // PRF baseline — only sent when the admin typed a value, so a blank
        // field leaves the existing counter untouched. Sent as-typed; the
        // backend extracts the digits (JEM0690 → 690).
        current_prf_number: editForm.prfNumber.trim() || undefined,
        // PRF sending account — email always sent (empty string clears the
        // account); password only when typed (blank keeps the stored one).
        smtp_email: editForm.smtp_email.trim(),
        smtp_service: editForm.smtp_service || undefined,
        smtp_password: editForm.smtp_password.trim() || undefined,
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

  const handleToggleActive = async (activate: boolean) => {
    if (!selectedProvider) return;
    setTogglingActive(true);
    try {
      const res = await api.post(
        `/api/providers/${selectedProvider.id}/${activate ? 'reactivate' : 'deactivate'}`,
      );
      const updated = { ...selectedProvider, is_active: activate };
      setEditForm(f => ({ ...f, is_active: activate }));
      setShowDeactivateConfirm(false);
      setShowEditClient(false);
      // Refetch with the UPDATED provider, not the one still in state.
      // fetchProviderDetails re-seeds selectedProvider from its argument, so
      // passing the stale object put the old is_active straight back and the
      // badge did not appear until the page was reloaded.
      fetchProviderDetails(updated);
      fetchProviders();
      alert(res.data?.message || (activate ? 'Client reactivated' : 'Client deactivated'));
    } catch (e: any) {
      alert(e.response?.data?.detail || `Failed to ${activate ? 'reactivate' : 'deactivate'} client`);
    }
    setTogglingActive(false);
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
      setLogoPreviewFailed(false);
      setLogoFailed(prev => { const n = new Set(prev); n.delete(selectedProvider.id); return n; });
      fetchProviders();
    } catch (err: any) {
      alert(err.response?.data?.detail || 'Failed to upload logo');
    }
    setLogoUploading(false);
  };

  const handleAddProvider = async () => {
    if (addingProvider) return;          // double-click / slow network
    // Every early return must happen BEFORE the in-flight flag is set. The
    // flag is only cleared in the finally of the try below, so a validation
    // return after setting it left the button disabled until a page reload —
    // which, on a blank Company Name, is a certainty rather than an edge case.
    if (!newProvider.name.trim()) {
      alert('Company Name is required');
      return;
    }
    setAddingProvider(true);
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
        // PRF sending account (Gmail/Outlook + app password) — optional at
        // onboarding; can be added later via Edit Client Settings.
        smtp_service: newProvider.smtpEmail.trim() ? newProvider.smtpService : undefined,
        smtp_email: newProvider.smtpEmail.trim() || undefined,
        smtp_password: newProvider.smtpPassword.trim() || undefined,
      };
      const res = await api.post('/api/providers', payload);
      const providerId = res.data.id;

      // The logo is a SECOND request, and the client is already committed by
      // now. A failure here must not be reported as "Failed to create client":
      // that sent workers back to re-enter a client that already existed, and
      // the second attempt then failed on the duplicate slug. Report what
      // actually happened and let them add the logo from Edit Client Settings.
      if (logoFile && providerId) {
        try {
          const formData = new FormData();
          formData.append('file', logoFile);
          await api.post(`/api/providers/${providerId}/logo`, formData, {
            headers: { 'Content-Type': 'multipart/form-data' },
          });
        } catch (logoErr: any) {
          alert(
            `${newProvider.name} was created successfully, but its logo was not uploaded: ` +
            `${logoErr.response?.data?.detail || 'upload failed'}

` +
            `Add the logo later from the client's Edit Client Settings — do not create the client again.`
          );
        }
      }

      setShowAddProvider(false);
      setNewProvider({ name: '', phone: '', email: '', prNumber: '', ptyRegNumber: '', prfName: '', address: '', prfNumber: '', clientEmail: '', clientPassword: '', adminEmail: '', adminPassword: '', smtpService: 'gmail', smtpEmail: '', smtpPassword: '' });
      setLogoFile(null);
      fetchProviders();
    } catch (e: any) {
      alert(e.response?.data?.detail || 'Failed to create client');
    } finally {
      setAddingProvider(false);
    }
  };

  const handleAddCrew = async () => {
    if (!selectedProvider) return;
    try {
      const res = await api.post(`/api/providers/${selectedProvider.id}/crew`, newCrew);
      setTempPassword(res.data.temp_password);
      setNewCrew({ full_name: '', email: '', initials: '', hpcsa_number: '', qualification: 'AEA', phone: '' });
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
    setNewCrew({ full_name: '', email: '', initials: '', hpcsa_number: '', qualification: 'AEA', phone: '' });
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
      qualification: member.qualification || 'AEA',
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
          <button style={btnPrimary} onClick={openAddProvider}>+ Add Provider</button>
        </div>

        {/* Add Provider Modal */}
        {showAddProvider && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000 }}>
            <div style={{ ...cardStyle, maxWidth: 600, width: isMobile ? '94%' : '90%', padding: isMobile ? 18 : 32, maxHeight: isMobile ? '92vh' : '85vh', overflowY: 'auto', position: 'relative' }}>
              <button onClick={closeAddProvider} style={{ position: 'absolute', top: 12, right: 16, background: 'none', border: 'none', fontSize: '1.3rem', cursor: 'pointer', color: 'var(--text-muted)' }}>&times;</button>
              <h3 style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: 16, color: teal }}>Add New Client</h3>
              
              <div style={{ display: 'grid', gap: 16 }}>
                <div>
                  <label style={labelStyle}>Company Name *</label>
                  <input style={{ ...inputStyle, borderColor: (slugClash || nameHasNoUsableCharacters) ? '#f59e0b' : (inputStyle.borderColor as string) }} maxLength={255} value={newProvider.name} onChange={e => setNewProvider({ ...newProvider, name: e.target.value })} />
                  {slugClash && (
                    <FieldWarning>
                      This name produces the web address <strong>/{typedSlug}</strong>, which
                      <strong> {slugClash.name}</strong> already uses. Each company needs its own —
                      it is how their crews reach the right PRFs. Change the name (add the branch or
                      town, e.g. “{newProvider.name.trim()} Durban”) before creating this client.
                    </FieldWarning>
                  )}
                  {nameHasNoUsableCharacters && (
                    <FieldWarning>
                      This name has no letters or numbers in it, so no web address can be made from
                      it. Add at least one letter or number.
                    </FieldWarning>
                  )}
                </div>

                {/* Company details — auto-filled into the top-left corner of every PDF PRF (mirrors Company Settings). */}
                <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12 }}>
                  <div>
                    <label style={labelStyle}>Phone Number</label>
                    <input style={inputStyle} maxLength={20} value={newProvider.phone} onChange={e => setNewProvider({ ...newProvider, phone: e.target.value })} />
                  </div>
                  <div>
                    <label style={labelStyle}>Email Address</label>
                    <input style={inputStyle} type="email" value={newProvider.email} onChange={e => setNewProvider({ ...newProvider, email: e.target.value })} />
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12 }}>
                  <div>
                    <label style={labelStyle}>PR Number</label>
                    <input style={inputStyle} maxLength={50} value={newProvider.prNumber} onChange={e => setNewProvider({ ...newProvider, prNumber: e.target.value })} />
                  </div>
                  <div>
                    <label style={labelStyle}>PTY Reg Number</label>
                    <input style={inputStyle} maxLength={50} value={newProvider.ptyRegNumber} onChange={e => setNewProvider({ ...newProvider, ptyRegNumber: e.target.value })} />
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
                    maxLength={100}
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
                  <input type="file" style={{ ...inputStyle, padding: '8px' }} accept="image/png,image/jpeg,image/svg+xml,image/webp" onChange={e => setLogoFile(e.target.files?.[0] || null)} />
                </div>

                <div style={{ background: 'var(--surface-50)', padding: 16, borderRadius: 8, border: '1px solid var(--surface-100)' }}>
                  <h4 style={{ fontSize: '0.9rem', fontWeight: 700, marginBottom: 12, color: 'var(--text)' }}>EMSMCA Client Login</h4>
                  <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12 }}>
                    <div>
                      <label style={labelStyle}>Username *</label>
                      <input style={inputStyle} value={newProvider.clientEmail}
                        onChange={e => setNewProvider({ ...newProvider, clientEmail: e.target.value })}
                        autoComplete="off" data-lpignore="true" data-form-type="other" />
                      {portalClash && (
                        <FieldWarning>
                          <strong>{portalClash.name}</strong> already signs in with this username.
                          Give this client their own, or their staff would be sent to the wrong
                          company's portal.
                        </FieldWarning>
                      )}
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
                  <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12 }}>
                    <div>
                      <label style={labelStyle}>Admin Email</label>
                      <input style={inputStyle} type="email" value={newProvider.adminEmail}
                        onChange={e => setNewProvider({ ...newProvider, adminEmail: e.target.value })}
                        autoComplete="off" data-lpignore="true" data-form-type="other" />
                      {adminClash && (
                        <FieldWarning>
                          This admin email already belongs to <strong>{adminClash.name}</strong>.
                          One email can only administer one client.
                        </FieldWarning>
                      )}
                    </div>
                    <div>
                      <label style={labelStyle}>Admin Password</label>
                      <input style={inputStyle} type="password" value={newProvider.adminPassword}
                        onChange={e => setNewProvider({ ...newProvider, adminPassword: e.target.value })}
                        autoComplete="new-password" data-lpignore="true" data-form-type="other" />
                    </div>
                  </div>
                </div>

                {/* PRF sending account — submitted PRF PDFs are emailed to the
                    receiving facility FROM this address. */}
                <div style={{ background: 'var(--surface-50)', padding: 16, borderRadius: 8, border: '1px solid var(--surface-100)' }}>
                  <h4 style={{ fontSize: '0.9rem', fontWeight: 700, marginBottom: 12, color: 'var(--text)' }}>PRF Sending Email</h4>
                  <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12 }}>
                    <div>
                      <label style={labelStyle}>Email Service</label>
                      <select style={inputStyle} value={newProvider.smtpService}
                        onChange={e => setNewProvider({ ...newProvider, smtpService: e.target.value })}>
                        <option value="gmail">Gmail</option>
                        <option value="outlook">Outlook</option>
                      </select>
                    </div>
                    <div>
                      <label style={labelStyle}>Sending Email Address</label>
                      <input style={inputStyle} type="email" value={newProvider.smtpEmail}
                        onChange={e => setNewProvider({ ...newProvider, smtpEmail: e.target.value })}
                        autoComplete="off" data-lpignore="true" data-form-type="other" />
                    </div>
                  </div>
                  <div style={{ marginTop: 12 }}>
                    <label style={labelStyle}>App Password</label>
                    <input style={inputStyle} type="password" value={newProvider.smtpPassword}
                      onChange={e => setNewProvider({ ...newProvider, smtpPassword: e.target.value })}
                      autoComplete="new-password" data-lpignore="true" data-form-type="other" />
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8, marginTop: 24, justifyContent: 'flex-end' }}>
                <button style={{ ...btnPrimary, background: 'var(--surface-200)', color: 'var(--text)' }} onClick={closeAddProvider}>Cancel</button>
                <button
                  style={{ ...btnPrimary, opacity: addingProvider ? 0.6 : 1, cursor: addingProvider ? 'wait' : 'pointer' }}
                  disabled={addingProvider}
                  onClick={handleAddProvider}
                >{addingProvider ? 'Creating…' : 'Create Client'}</button>
              </div>
            </div>
          </div>
        )}

        {loading ? (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>Loading providers...</div>
        ) : loadError && providers.length === 0 ? (
          /* Fetch failed with nothing loaded — explicit error, not "no clients yet" */
          <LoadErrorPanel what="service providers" onRetry={fetchProviders} />
        ) : providers.length === 0 ? (
          <div style={{ ...cardStyle, textAlign: 'center', padding: 40 }}>
            <p style={{ fontSize: '1rem', color: 'var(--text-muted)' }}>No service providers yet</p>
            <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>Click "Add Provider" to onboard your first EMS company.</p>
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 12 }}>
            {sortedProviders.map(p => {
              const lk = lockedFor(p);
              const isLocked = lk.length > 0;
              return (
              <div key={p.id} style={{ ...cardStyle, cursor: 'pointer', transition: 'border-color 0.15s', marginBottom: 0, ...(isLocked ? { borderColor: '#f59e0b', boxShadow: '0 0 0 1px rgba(245,158,11,0.45)' } : {}) }} onClick={() => fetchProviderDetails(p)}
                onMouseEnter={e => (e.currentTarget.style.borderColor = isLocked ? '#f59e0b' : teal)}
                onMouseLeave={e => (e.currentTarget.style.borderColor = isLocked ? '#f59e0b' : 'var(--surface-100)')}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    {p.logo_url && !logoFailed.has(p.id) ? (
                      <img src={p.logo_url} alt={p.name}
                        onError={() => setLogoFailed(prev => new Set(prev).add(p.id))}
                        style={{ width: 36, height: 36, objectFit: 'contain', borderRadius: 6, border: '1px solid var(--surface-100)', background: '#fff', padding: 2 }} />
                    ) : (
                      <div style={{ width: 36, height: 36, borderRadius: 6, background: `rgba(8,131,149,0.1)`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1rem', fontWeight: 800, color: teal }}>
                        {p.name[0]?.toUpperCase()}
                      </div>
                    )}
                    <div>
                      <div style={{ fontSize: '1.05rem', fontWeight: 700, color: p.is_active ? 'var(--text)' : 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        {p.name}
                        {!p.is_active && <DeactivatedBadge />}
                        {isLocked && (
                          <span title={lockTooltip(lk)} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, borderRadius: 10, background: '#dc2626', color: '#fff', fontSize: '0.8rem', fontWeight: 900, cursor: 'help', flexShrink: 0 }}>!</span>
                        )}
                      </div>
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
                    {isLocked && (
                      <button
                        onClick={(e) => unlockProvider(p, lk, e)}
                        disabled={unlockingId === p.id}
                        title={lockTooltip(lk)}
                        style={{ background: '#dc2626', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 14px', fontSize: '0.75rem', fontWeight: 800, cursor: 'pointer', opacity: unlockingId === p.id ? 0.6 : 1, whiteSpace: 'nowrap' }}
                      >
                        {unlockingId === p.id ? 'Unlocking…' : 'Unlock'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
              );
            })}
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
          <div style={{ ...cardStyle, maxWidth: 560, width: isMobile ? '94%' : '90%', padding: isMobile ? 18 : 32, maxHeight: '90vh', overflowY: 'auto', position: 'relative' }}>
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
                    {logoPreview && !logoPreviewFailed ? (
                      <img src={logoPreview} alt="logo preview"
                        onError={() => setLogoPreviewFailed(true)}
                        style={{ width: '100%', height: '100%', objectFit: 'contain', padding: 4 }} />
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
              <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12 }}>
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
              {/* The "Client is Active" checkbox used to live here. It flipped
                  the same flag as Deactivate but without the crew cascade, so
                  unticking it hid the company while its paramedics could still
                  sign in. One control, at the bottom of this dialog. */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 8, background: 'var(--surface-100)', border: '1px solid var(--surface-200)' }}>
                <span style={{ width: 9, height: 9, borderRadius: '50%', flexShrink: 0, background: editForm.is_active ? '#16a34a' : '#9ca3af' }} />
                <span style={{ fontSize: '0.83rem', fontWeight: 600, color: 'var(--text)' }}>
                  {editForm.is_active ? 'Client is active' : 'Client is deactivated'}
                </span>
              </div>

              {/* ── EMSMCA Client Login ── */}
              <div style={{ background: 'var(--surface-50)', padding: '14px 16px', borderRadius: 10, border: '1px solid var(--surface-200)' }}>
                <div style={{ fontSize: '0.7rem', fontWeight: 800, color: teal, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>EMSMCA Client Login</div>
                <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 10 }}>
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
                <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 10 }}>
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

              {/* ── PRF Sending Email — submitted PRF PDFs are emailed to the
                    receiving facility FROM this account. App password is
                    write-only: blank keeps the stored one. ── */}
              <div style={{ background: 'var(--surface-50)', padding: '14px 16px', borderRadius: 10, border: '1px solid var(--surface-200)' }}>
                <div style={{ fontSize: '0.7rem', fontWeight: 800, color: teal, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
                  PRF Sending Email{selectedProvider?.smtp_configured ? ' — configured' : ''}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 10 }}>
                  <div>
                    <label style={labelStyle}>Email Service</label>
                    <select
                      style={inputStyle}
                      value={editForm.smtp_service}
                      onChange={e => setEditForm({ ...editForm, smtp_service: e.target.value })}
                    >
                      <option value="gmail">Gmail</option>
                      <option value="outlook">Outlook</option>
                    </select>
                  </div>
                  <div>
                    <label style={labelStyle}>Sending Email Address</label>
                    <input
                      style={inputStyle}
                      type="email"
                      value={editForm.smtp_email}
                      onChange={e => setEditForm({ ...editForm, smtp_email: e.target.value })}
                      autoComplete="off" data-lpignore="true" data-form-type="other"
                    />
                  </div>
                </div>
                <div style={{ marginTop: 10 }}>
                  <label style={labelStyle}>App Password</label>
                  <input
                    style={inputStyle}
                    type="password"
                    value={editForm.smtp_password}
                    onChange={e => setEditForm({ ...editForm, smtp_password: e.target.value })}
                    autoComplete="new-password" data-lpignore="true" data-form-type="other"
                  />
                </div>
              </div>
            </div>

            <div style={{ marginTop: 24 }}>
              {!showDeactivateConfirm ? (
                <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}>
                  {selectedProvider?.is_active ? (
                    <button
                      onClick={() => setShowDeactivateConfirm(true)}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 7, background: 'none', border: '1px solid #b45309', borderRadius: 8, color: '#b45309', padding: '8px 14px', fontSize: '0.78rem', fontWeight: 700, cursor: 'pointer' }}
                    >
                      <PowerIcon size={14} /> Deactivate Client
                    </button>
                  ) : (
                    <button
                      onClick={() => handleToggleActive(true)}
                      disabled={togglingActive}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 7, background: 'none', border: `1px solid ${teal}`, borderRadius: 8, color: teal, padding: '8px 14px', fontSize: '0.78rem', fontWeight: 700, cursor: 'pointer', opacity: togglingActive ? 0.6 : 1 }}
                    >
                      <PowerIcon size={14} /> {togglingActive ? 'Reactivating…' : 'Reactivate Client'}
                    </button>
                  )}
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button style={{ ...btnPrimary, background: 'var(--surface-200)', color: 'var(--text)' }} onClick={() => setShowEditClient(false)}>Cancel</button>
                    <button style={{ ...btnPrimary, opacity: editSaving ? 0.6 : 1 }} onClick={handleSaveClient} disabled={editSaving}>
                      {editSaving ? 'Saving…' : 'Save Changes'}
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{ background: 'rgba(180,83,9,0.06)', border: '1px solid rgba(180,83,9,0.3)', borderRadius: 10, padding: '16px' }}>
                  <p style={{ display: 'flex', alignItems: 'flex-start', gap: 7, fontSize: '0.82rem', fontWeight: 700, color: '#b45309', margin: '0 0 8px' }}>
                    <span style={{ flexShrink: 0, marginTop: 1 }}><WarnIcon size={15} /></span>
                    Deactivate {selectedProvider?.name}?
                  </p>
                  <ul style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '0 0 12px', paddingLeft: 18, lineHeight: 1.7 }}>
                    <li>{crew.length} crew member{crew.length === 1 ? ' is' : 's are'} signed out and blocked from starting a shift.</li>
                    <li>The company disappears from the ePRF sign-in list.</li>
                    <li>Nothing is deleted — PRFs, cases and claims stay exactly as they are.</li>
                    <li>You can reactivate at any time, and the same crew come back.</li>
                  </ul>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      onClick={() => handleToggleActive(false)}
                      disabled={togglingActive}
                      style={{ ...btnPrimary, background: '#b45309', color: '#fff', opacity: togglingActive ? 0.6 : 1 }}
                    >
                      {togglingActive ? 'Deactivating…' : 'Deactivate Client'}
                    </button>
                    <button style={{ ...btnPrimary, background: 'var(--surface-200)', color: 'var(--text)' }} onClick={() => setShowDeactivateConfirm(false)}>Cancel</button>
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <h1 style={{ fontSize: '1.3rem', fontWeight: 800, margin: 0, color: selectedProvider.is_active ? 'var(--text)' : 'var(--text-muted)' }}>{selectedProvider.name}</h1>
            {!selectedProvider.is_active && <DeactivatedBadge />}
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
                        {[...legacyOption(newCrew.qualification), ...QUAL_OPTIONS].map(o => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
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
                        {[...legacyOption(editCrewForm.qualification), ...QUAL_OPTIONS].map(o => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
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
            {isMobile ? (
              /* Cards on a phone: a 3-column table at 375px squeezed the name
                 column to a few characters and pushed the delete action to a
                 tap target too small to hit reliably. */
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {crew.map(c => (
                  <div key={c.id} style={{ padding: '13px 14px', borderBottom: '1px solid var(--surface-100)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
                      <span style={{
                        width: 38, height: 38, borderRadius: '50%', flexShrink: 0,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: 'rgba(8,131,149,0.1)', color: teal,
                        fontSize: '0.82rem', fontWeight: 800,
                      }}>
                        {(c.initials || c.full_name.split(' ').map(p => p[0]).join('').slice(0, 2) || '—').toUpperCase()}
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 700, fontSize: '0.92rem', color: c.is_active ? 'var(--text)' : 'var(--text-muted)', wordBreak: 'break-word', display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                          {c.full_name}
                          {!c.is_active && <DeactivatedBadge compact />}
                        </div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 2 }}>
                          {c.hpcsa_number ? `HPCSA ${c.hpcsa_number}` : 'No HPCSA number'}
                          {c.phone ? ` · ${c.phone}` : ''}
                        </div>
                      </div>
                      <button
                        onClick={() => handleDeleteCrew(c.id)}
                        aria-label={`Delete ${c.full_name}`}
                        style={{
                          flexShrink: 0, minWidth: 44, minHeight: 44, borderRadius: 9,
                          border: '1px solid var(--surface-200)', background: 'var(--surface-0)',
                          color: rose, cursor: 'pointer',
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        }}
                      >
                        <TrashIcon size={16} />
                      </button>
                    </div>
                  </div>
                ))}
                {crew.length === 0 && (
                  <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>No crew members yet</div>
                )}
              </div>
            ) : (
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
                          <div style={{ fontWeight: 700, color: c.is_active ? 'var(--text)' : 'var(--text-muted)', fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                            {c.full_name}
                            {!c.is_active && <DeactivatedBadge compact />}
                          </div>
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
            )}
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
            {isMobile ? (
              /* Cards on a phone — a 4-column table cannot show callsign,
                 registration, type AND two actions in 375px. */
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {vehicles.map(v => (
                  <div key={v.id} style={{ padding: '13px 14px', borderBottom: '1px solid var(--surface-100)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
                      <span style={{
                        width: 38, height: 38, borderRadius: 10, flexShrink: 0,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: 'rgba(230,81,0,0.1)', color: '#E65100',
                      }}>
                        <AmbulanceIcon size={20} />
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 700, fontSize: '0.92rem', color: 'var(--text)', wordBreak: 'break-word' }}>{v.callsign}</div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 2, fontFamily: 'monospace' }}>
                          {v.registration}{v.vehicle_type ? ` · ${v.vehicle_type}` : ''}
                        </div>
                      </div>
                      <button
                        onClick={() => openEditVehicle(v)}
                        aria-label={`Edit ${v.callsign}`}
                        style={{
                          flexShrink: 0, minWidth: 44, minHeight: 44, borderRadius: 9,
                          border: '1px solid var(--surface-200)', background: 'var(--surface-0)',
                          color: teal, cursor: 'pointer',
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        }}
                      >
                        <EditIcon size={16} />
                      </button>
                    </div>
                  </div>
                ))}
                {vehicles.length === 0 && (
                  <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>No vehicles yet</div>
                )}
              </div>
            ) : (
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
            )}
          </div>
        </>
      )}
    </div>
  );
}
