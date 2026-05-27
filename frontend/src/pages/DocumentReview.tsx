/**
 * Document Review Page — Human-in-the-loop (HITL) interface for reviewing OCR extraction.
 */
import React, { useState, useEffect, useRef } from "react";
import {
  useParams,
  useNavigate,
  useSearchParams,
  useLocation,
} from "react-router-dom";
import { TransformWrapper, TransformComponent } from "react-zoom-pan-pinch";
import api from "../api/client";

interface DocumentDetail {
  id: string;
  original_filename: string;
  document_type: string;
  ocr_status: string;
  ocr_confidence_avg: number | null;
  extracted_data: any;
  needs_hitl_review: boolean;
  created_at: string;
}

// const ICD10Badge = ({ code, onRemove }: { code: string, onRemove: () => void }) => (
//   <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'var(--brand-teal)', color: 'white', padding: '2px 8px', borderRadius: 9999, fontSize: '0.75rem', fontWeight: 600 }}>
//     <span>{code}</span>
//     <button onClick={onRemove} style={{ background: 'transparent', border: 'none', color: 'white', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center' }}>✕</button>
//   </div>
// );

const ICD10CodeAdder = ({ onAdd }: { onAdd: (code: string) => void }) => {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<any[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    // Remove the artificial delay to show suggestions immediately while typing!
    api.get(`/api/adjudication/search-codes?q=${encodeURIComponent(query)}`).then(res => {
      setResults(res.data.results || []);
    });
  }, [query]);

  return (
    <div style={{ position: "relative", width: 280 }}>
      <input autoComplete="off"
        className="form-control" 
        placeholder="Type diagnosis or ICD-10 code..." 
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setShowDropdown(true);
        }}
        onFocus={() => setShowDropdown(true)}
        onBlur={() => setTimeout(() => setShowDropdown(false), 200)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && query) {
             onAdd(query.split(" ")[0]); 
             setQuery("");
             setShowDropdown(false);
          }
        }}
      />
      {showDropdown && results.length > 0 && (
        <div style={{
          position: "absolute", top: "100%", left: 0, right: 0, marginTop: 4,
          background: "var(--surface-50)", border: "1px solid var(--surface-200)",
          borderRadius: 8, boxShadow: "0 4px 12px rgba(0,0,0,0.1)", zIndex: 50,
          maxHeight: 200, overflowY: "auto"
        }}>
          {results.map((r, i) => (
            <div 
              key={i}
              style={{
                padding: "8px 12px", borderBottom: "1px solid var(--surface-100)",
                cursor: "pointer", display: "flex", flexDirection: "column", gap: 2
              }}
              onMouseDown={() => {
                onAdd(r.code);
                setQuery("");
                setShowDropdown(false);
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                 <span style={{ fontWeight: 600, fontSize: "0.85rem", color: "var(--text-main)" }}>{r.code}</span>
                 {r.is_pmb && <span style={{ fontSize: "0.6rem", background: "var(--brand-teal)", color: "white", padding: "2px 6px", borderRadius: 4, fontWeight: "bold" }}>PMB</span>}
              </div>
              <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>{r.description}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};


const Sec = ({ num, title, color }: { num: string; title: string; color: string }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, marginTop: 4 }}>
    <div style={{ width: 3, height: 16, borderRadius: 2, background: color, flexShrink: 0 }} />
    <span style={{ fontSize: '0.68rem', fontWeight: 800, color, letterSpacing: '0.1em', textTransform: 'uppercase' }}>{num}</span>
    <span style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.01em' }}>{title}</span>
  </div>
);

const G2 = ({ children }: { children: React.ReactNode }) => (
  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '7px 12px' }}>{children}</div>
);
const G3 = ({ children }: { children: React.ReactNode }) => (
  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '7px 12px' }}>{children}</div>
);
const G4 = ({ children }: { children: React.ReactNode }) => (
  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '7px 12px' }}>{children}</div>
);

const HR = () => <div style={{ height: 1, background: 'var(--surface-100)', margin: '10px 0' }} />;

// const SigToggle = ({ label, fieldKey, data, onChange }: { label: string; fieldKey: string; data: any; onChange: (key: string, val: boolean) => void }) => {
//   const val = !!data[fieldKey];
//   return (
//     <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 10px', background: val ? 'rgba(22,163,74,0.05)' : 'transparent', border: `1px solid ${val ? 'rgba(22,163,74,0.2)' : 'var(--surface-200)'}`, borderRadius: 7, cursor: 'pointer', transition: 'all 0.15s' }}
//       onClick={() => onChange(fieldKey, !val)}>
//       <span style={{ fontSize: '0.8rem', color: val ? '#16a34a' : 'var(--text-secondary)', fontWeight: 500 }}>{label}</span>
//       <span style={{ fontSize: '0.68rem', fontWeight: 700, padding: '2px 8px', borderRadius: 99, background: val ? 'rgba(22,163,74,0.1)' : 'var(--surface-100)', color: val ? '#16a34a' : 'var(--text-muted)' }}>{val ? 'OBTAINED' : 'PENDING'}</span>
//     </div>
//   );
// };

/**
 * PlacesAutocomplete — Google Maps Places Autocomplete (SA only).
 *
 * Features:
 *  - Restricts suggestions to South Africa (`za`)
 *  - Uses AutocompleteSessionToken to batch keystrokes into a single billing event
 *  - Extracts formatted_address, lat, lng on selection
 *  - Blocks form submission via Enter if no valid place has been selected
 *  - Falls back to plain text input if the Google Maps API hasn't loaded yet
 */
const PlacesAutocomplete = ({
  label,
  value,
  onChange,
  onLocationSelect,
  placeholder,
  hint,
}: {
  label: string;
  value: string;
  onChange: (val: string) => void;
  /** Called when the user picks a place — passes address, lat, lng */
  onLocationSelect?: (address: string, lat: number, lng: number) => void;
  placeholder?: string;
  hint?: string;
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const autocompleteRef = useRef<any>(null);
  const sessionTokenRef = useRef<any>(null);
  const placeSelectedRef = useRef<boolean>(false);
  const [inputValue, setInputValue] = useState(value || '');

  // Sync external value → local state (e.g. when the document loads)
  useEffect(() => { setInputValue(value || ''); }, [value]);

  // Initialise Google Maps Autocomplete once the input mounts
  useEffect(() => {
    if (!inputRef.current) return;

    // Wait for the Google Maps API to be available (loaded async via index.html)
    const init = () => {
      if (!(window as any).google?.maps?.places) return;

      const autocomplete = new (window as any).google.maps.places.Autocomplete(
        inputRef.current,
        {
          componentRestrictions: { country: 'za' },   // South Africa only
          fields: ['formatted_address', 'geometry'],   // Only fetch what we need (cost control)
          types: ['geocode', 'establishment'],          // Addresses + businesses
        }
      );
      autocompleteRef.current = autocomplete;

      // Attach the place_changed listener
      autocomplete.addListener('place_changed', () => {
        const place = autocomplete.getPlace();
        if (!place?.geometry?.location) {
          // User typed something but didn't select from the dropdown
          return;
        }

        const address  = place.formatted_address || (inputRef.current?.value || '');
        const lat      = place.geometry.location.lat();
        const lng      = place.geometry.location.lng();

        placeSelectedRef.current = true;            // Mark as validated
        setInputValue(address);
        onChange(address);
        onLocationSelect?.(address, lat, lng);

        // Reset session token after a selection (start fresh for next search)
        sessionTokenRef.current = null;
      });
    };

    // If Maps is already loaded synchronously, init immediately
    if ((window as any).google?.maps?.places) {
      init();
    } else {
      // Poll until the async script finishes loading (max ~3 s)
      const poll = setInterval(() => {
        if ((window as any).google?.maps?.places) {
          clearInterval(poll);
          init();
        }
      }, 150);
      return () => clearInterval(poll);
    }
  }, []);                                             // eslint-disable-line react-hooks/exhaustive-deps

  // Generate a new session token when the user starts typing
  const handleFocus = () => {
    if (!(window as any).google?.maps?.places) return;
    if (!sessionTokenRef.current) {
      sessionTokenRef.current = new (window as any).google.maps.places.AutocompleteSessionToken();
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    placeSelectedRef.current = false;               // Typing again invalidates the last selection
    setInputValue(e.target.value);
    onChange(e.target.value);                        // Keep parent state in sync as user types
  };

  // Prevent accidental form submission if no suggestion was clicked
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      if (!placeSelectedRef.current) {
        e.preventDefault();
        e.stopPropagation();
        // Gentle nudge — no modal, just a border flash
        if (inputRef.current) {
          inputRef.current.style.border = '1.5px solid #e11d48';
          setTimeout(() => {
            if (inputRef.current) inputRef.current.style.border = '';
          }, 1200);
        }
      }
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, position: 'relative' }}>
      <label style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </label>
      <div style={{ position: 'relative' }}>
        <input
          ref={inputRef}
          id={`gmaps-ac-${label.replace(/\s+/g, '-').toLowerCase()}`}
          className="form-control"
          style={{ fontSize: '0.84rem' }}
          value={inputValue}
          placeholder={placeholder || 'Start typing an address…'}
          autoComplete="off"             /* disable browser autocomplete — Maps handles it */
          onChange={handleChange}
          onFocus={handleFocus}
          onKeyDown={handleKeyDown}
        />
      </div>
      {hint && (
        <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: -2 }}>
          {hint}
        </span>
      )}
    </div>
  );
};



export default function DocumentReview() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  // Focus Mode state
  const isFocusMode = (location.state as any)?.isFocusMode || false;
  const focusQueue = (location.state as any)?.focusQueue || [];
  const totalInFocus = (location.state as any)?.totalInFocus || 0;
  const aliasMap: Record<string, string> = {
    "preauth_number": "authorization_number",
    "provider_practice_number": "bhf_practice_number",
    "icd10_primary": "primary_icd10",
    "cpt_code": "tariff_codes",
    "nappi_code": "tariff_codes",
    "scheme_name": "medical_scheme",
    "patient_signature": "patient_signature_present",
    "MISSING_PREAUTH": "authorization_number",
    "INVALID_ICD10": "primary_icd10",
    "INVALID_CPT": "tariff_codes",
    "MISSING_PATIENT_ID": "patient_id_number",
    "adjudication_status": "none" // Prevents invalid references
  };

  const incomingFlaggedFields: string[] = ((location.state as any)?.flaggedFields || [])
    .map((f: string) => aliasMap[f] || f)
    .filter((f: string) => f !== "none");

  const [doc, setDoc] = useState<DocumentDetail | null>(null);
  const [editedFilename, setEditedFilename] = useState("");
  const [loading, setLoading] = useState(true);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [splitOffset, setSplitOffset] = useState(() => {
    const saved = localStorage.getItem("docReviewSplitOffset");
    return saved ? parseInt(saved, 10) : 500;
  });

  const [isExpandedWidth, setIsExpandedWidth] = useState(() => {
    return localStorage.getItem("docReviewFullWidth") === "true";
  });

  useEffect(() => {
    localStorage.setItem("docReviewSplitOffset", splitOffset.toString());
  }, [splitOffset]);

  useEffect(() => {
    localStorage.setItem("docReviewFullWidth", isExpandedWidth ? "true" : "false");
  }, [isExpandedWidth]);
  const [searchParams] = useSearchParams();
  const [highlightedFields, setHighlightedFields] = useState<string[]>(
    searchParams.get("highlight")
      ? [aliasMap[searchParams.get("highlight") as string] || searchParams.get("highlight") as string].filter((f: string) => f !== "none")
      : incomingFlaggedFields,
  );


  // formCategories is only used for field initialisation defaults — rendering is done in renderFormView
  const [formCategories] = useState<{ title: string; keys: string[] }[]>([
    {
      title: "Patient & Victim Details",
      keys: ["patient_name", "patient_id_number", "patient_dob", "gender", "patient_phone", "patient_address", "patient_relationship"],
    },
    {
      title: "Authorization & Medical Scheme Details",
      keys: ["medical_scheme", "scheme_option", "main_member_name", "main_member_id", "member_number", "dependent_code", "authorization_number"],
    },
    {
      title: "Provider & Crew Information",
      keys: ["service_provider_name", "service_provider_contact", "bhf_practice_number", "vehicle_registration", "vehicle_callsign",
        "crew_member_1_name", "crew_member_1_initials", "crew_member_1_qualification", "crew_member_1_hpcsa",
        "crew_member_2_name", "crew_member_2_initials", "crew_member_2_qualification", "crew_member_2_hpcsa"],
    },
    {
      title: "Incident Logistics & Timestamps",
      keys: ["incident_date", "incident_type", "multiple_patient_indicator", "level_of_care_dispatched", "level_of_care",
        "incident_location", "receiving_facility",
        "call_received_time", "dispatch_time", "on_scene_time", "departure_from_scene_time", "hospital_arrival_time", "handover_complete_time",
        "odometer_dispatch", "odometer_at_scene", "odometer_departure", "odometer_destination", "odometer_rtb"],
    },
    {
      title: "Clinical Assessment & Interventions",
      keys: ["chief_complaint", "ample_history", "primary_secondary_survey", "vital_signs", "procedures", "medications_given",
        "primary_diagnosis", "primary_icd10", "external_cause_code", "icd10_codes"],
    },
    {
      title: "Billing & Invoice Summary",
      keys: ["invoice_number", "invoice_date", "tariff_codes", "units_claimed", "total_claimed_amount"],
    },
  ]);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);

  const [editedData, setEditedData] = useState<string>("");
  const [viewMode, setViewMode] = useState<"form" | "json">("form");
  // Frozen snapshot of the raw AI extraction — never overwritten by draft saves.
  // Used as baseline for self-learning correction comparison.
  const originalAiDataRef = useRef<Record<string, any> | null>(null);

  // Once document data finishes loading, if we came from a red-flagged row
  // activate all flagged fields and scroll to the topmost one.
  const flagsInjectedRef = useRef(false);
  useEffect(() => {
    if (!loading && incomingFlaggedFields.length > 0 && !flagsInjectedRef.current) {
      flagsInjectedRef.current = true;
      
      // let dataToCheck: any = {};
      // const dataToCheck = {...parsedData, ...tempData}; } catch(e) {}
      
      // Delay filtering slightly to allow React to paint the entire form View so getElementById works reliably
      setTimeout(() => {
        // Filter out non-existent fields AND deduplicate exact matches (e.g. if alias map creates duplicates)
        const validFields = incomingFlaggedFields.filter(f => !!document.getElementById(`field-${f}`));
        const filteredFlags = Array.from(new Set(validFields));

        setHighlightedFields(filteredFlags);
        
        if (filteredFlags.length > 0) {
          const firstEl = document.getElementById(`field-${filteredFlags[0]}`);
          if (firstEl) {
            firstEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            firstEl.focus({ preventScroll: true });
          }
        }
      }, 150);
    }
  }, [loading, incomingFlaggedFields, editedData]);

  // Bundle (document group) state
  const [groupedDocs, setGroupedDocs] = useState<any[]>([]);
  const [showReextractPicker, setShowReextractPicker] = useState(false);

  // §08 Pre-Authorization state
  const [authReferringPr, setAuthReferringPr] = useState('');
  const [authMotivation, _setAuthMotivation] = useState('');
  const [authRequestSending, setAuthRequestSending] = useState(false);
  const [authRequestToast, setAuthRequestToast] = useState('');
  const [authPopupOpen, setAuthPopupOpen] = useState(false);
  // No-scheme action modal (shown after successful verify when scheme is blank)
  const [noSchemeModal, setNoSchemeModal] = useState<{ caseId: string; pendingNavigate: () => void } | null>(null);
  const [noSchemeAction, setNoSchemeAction] = useState('proceed');

  // §01 Patient lookup state
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupResult, setLookupResult] = useState<Record<string, string> | null>(null);
  const [profileExpanded, setProfileExpanded] = useState(false);

  const handleFieldChange = (key: string, value: any) => {
    try {
      const parsed = JSON.parse(editedData);
      parsed[key] = value;
      setEditedData(JSON.stringify(parsed, null, 2));
    } catch (e) {
      /* ignore if invalid parse */
    }
  };

  // PRF Name template from settings
  const [prfNameTemplate, setPrfNameTemplate] = useState<string[]>([
    "provider_practice_number",
    "prf_number",
    "medical_scheme",
  ]);
  const nameSeparator = localStorage.getItem("prf_name_separator") || " . ";

  /** Build the PRF display name using the configurable template */
  const getPrfDisplayName = (): string => {
    try {
      const data = JSON.parse(editedData);
      const parts = prfNameTemplate
        .map((key) => (data[key] || "").trim())
        .filter(Boolean);
      if (parts.length === 0) return "Untitled PRF";
      return parts.join(nameSeparator);
    } catch {
      return "Untitled PRF";
    }
  };

  const F = (label: string, key: string, data: any, opts?: { full?: boolean; textarea?: boolean; hint?: string }) => {
    const isHighlighted = highlightedFields.includes(key);
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, gridColumn: opts?.full ? '1 / -1' : undefined }}>
        <label style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'flex', justifyContent: 'space-between' }}>
          <span>{label}</span>
          {opts?.hint && <span style={{ fontWeight: 400, textTransform: 'none', color: 'var(--text-muted)', opacity: 0.65, letterSpacing: 0 }}>{opts.hint}</span>}
        </label>
        {opts?.textarea ? (
          <textarea id={`field-${key}`} className={`form-control ${isHighlighted ? 'pulsate-red' : ''}`}
            style={{ minHeight: 80, fontSize: '0.84rem', resize: 'vertical', borderRadius: 8 }}
            value={data[key] || ''} onChange={e => handleFieldChange(key, e.target.value)}
            onFocus={() => isHighlighted && setHighlightedFields(p => p.filter(f => f !== key))} />
        ) : (
          <input autoComplete="off" id={`field-${key}`} className={`form-control ${isHighlighted ? 'pulsate-red' : ''}`}
            style={{ fontSize: '0.84rem', padding: '7px 12px', borderRadius: 8, height: 36 }}
            value={data[key] ?? ''} onChange={e => handleFieldChange(key, e.target.value)}
            onFocus={() => isHighlighted && setHighlightedFields(p => p.filter(f => f !== key))} />
        )}
      </div>
    );
  };
  const renderFormView = () => {
    try {
      const data = JSON.parse(editedData);
      const teal = '#088395', purple = '#7c3aed', amber = '#d97706', rose = '#e11d48';

      const renderCrewRow = (num: number, nameKey: string, initKey: string, qualKey: string, hpcsaKey: string) => (
        <div key={num}>
          <div style={{ fontSize: '0.62rem', fontWeight: 800, color: purple, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 5 }}>Crew {num}</div>
          <G4>
            {F('Full Name', nameKey, data)}
            {F('Initials', initKey, data)}
            {F('Qualification', qualKey, data)}
            {F('HPCSA No.', hpcsaKey, data)}
          </G4>
        </div>
      );

      return (
        <div style={{ padding: '12px 14px', overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 1 }}>
          <style>{`
            .prf-s { padding: 12px 14px; border-bottom: 1px solid var(--surface-100); }
            .prf-s:last-child { border-bottom: none; }
            .prf-ti td { padding: 3px 4px !important; }
            .prf-ti td:first-child { font-size: 0.72rem; color: var(--text-muted); font-weight: 500; padding-right: 8px; white-space: nowrap; width: 55%; }
          `}</style>

          {/* ── Flagged Review Banner ── shown when opened from red Review button ── */}
          {incomingFlaggedFields.length > 0 && highlightedFields.length > 0 && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '9px 14px', borderRadius: 8, marginBottom: 4,
              background: 'rgba(194,24,91,0.07)',
              border: '1px solid rgba(194,24,91,0.2)',
            }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#C2185B" strokeWidth="2.5" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              <span style={{ fontSize: '0.78rem', fontWeight: 700, color: '#C2185B' }}>
                {highlightedFields.length} field{highlightedFields.length !== 1 ? 's' : ''} flagged for review
              </span>
              <span style={{ fontSize: '0.75rem', color: '#9F1239', fontWeight: 500 }}>
                — pulsing red below. Click any field to dismiss its flag.
              </span>
              <button
                onClick={() => setHighlightedFields([])}
                style={{ marginLeft: 'auto', fontSize: '0.72rem', fontWeight: 700, padding: '2px 10px', borderRadius: 99,
                  border: '1px solid rgba(194,24,91,0.3)', background: 'transparent', color: '#C2185B', cursor: 'pointer' }}
              >
                Dismiss All
              </button>
            </div>
          )}

          {(() => {
            const scheme = (data.medical_scheme || '').toString().trim();
            const memberNo = (data.member_number || '').toString().trim();
            const depCode  = (data.dependent_code || '00').toString().trim();
            const isGems   = scheme.toLowerCase().includes('gems');
            const hasSchemeAndMember = scheme.length > 0 && memberNo.length > 0;
            const isVerified = !!lookupResult;

            const handleLookup = async () => {
              if (!memberNo) return;
              setLookupLoading(true);
              try {
                const encodedScheme = isGems ? 'gems' : encodeURIComponent(scheme.toLowerCase().replace(/\s+/g, '_'));
                const res = await api.get(`/api/member-lookup/${encodedScheme}/${encodeURIComponent(memberNo)}`, {
                  params: { dependent_code: depCode },
                });
                const result = res.data;
                if (result.found) {
                  // Force-fill ALL returned fields — scheme data is authoritative
                  if (result.patient_name)      handleFieldChange('patient_name', result.patient_name);
                  if (result.patient_id_number) handleFieldChange('patient_id_number', result.patient_id_number);
                  if (result.patient_dob)       handleFieldChange('patient_dob', result.patient_dob);
                  if (result.patient_phone)     handleFieldChange('patient_phone', result.patient_phone);
                  if (result.main_member_phone) handleFieldChange('main_member_phone', result.main_member_phone);
                  if (result.scheme_option)     handleFieldChange('scheme_option', result.scheme_option);
                  if (result.main_member_name)  handleFieldChange('main_member_name', result.main_member_name);
                  setLookupResult(result);
                } else {
                  alert(result.message || `No details found for member ${memberNo} on ${scheme}.`);
                }
              } catch {
                alert('Could not reach the member lookup service. Check that the backend is running.');
              } finally {
                setLookupLoading(false);
              }
            };

            /* ── GEMS Profile Card (inline expandable) ── rendered when lookup succeeded ── */
            const GemsProfileCard = () => {
              if (!isVerified || !lookupResult) return null;

              /* Build the full data set to display when expanded */
              const verifiedFields: { icon: string; label: string; value: string; highlight?: boolean }[] = [
                { icon: '👤', label: 'Patient Name',       value: lookupResult.patient_name || '—',       highlight: true },
                { icon: '🪪', label: 'ID Number',          value: lookupResult.patient_id_number || '—'  },
                { icon: '🎂', label: 'Date of Birth',      value: lookupResult.patient_dob || '—'         },
                { icon: '📞', label: 'Patient Phone',      value: lookupResult.patient_phone || '—'       },
                { icon: '👪', label: 'Main Member',        value: lookupResult.main_member_name || '—'    },
                { icon: '📲', label: 'Main Member Phone',  value: lookupResult.main_member_phone || '—'   },
                { icon: '🏥', label: 'Scheme Option',      value: lookupResult.scheme_option || '—'       },
                { icon: '🔢', label: 'Member Number',      value: memberNo,                               highlight: true },
                { icon: '#️⃣', label: 'Dependant Code',     value: depCode                                 },
                { icon: '🔗', label: 'Source',             value: lookupResult.source || scheme           },
              ];

              const GEMS_TEAL    = '#00897B';
              const GEMS_TEAL_BG = 'rgba(0,137,123,0.06)';
              const GEMS_BORDER  = 'rgba(0,137,123,0.2)';
              const GEMS_ACCENT  = 'rgba(0,137,123,0.12)';

              return (
                <div style={{
                  marginBottom: 10,
                  borderRadius: 10,
                  border: `1px solid ${GEMS_BORDER}`,
                  background: GEMS_TEAL_BG,
                  overflow: 'hidden',
                  transition: 'box-shadow 0.2s',
                  boxShadow: profileExpanded ? '0 4px 20px rgba(0,137,123,0.12)' : 'none',
                }}>
                  {/* ── Collapsed Tag Row ── */}
                  <button
                    onClick={() => setProfileExpanded(p => !p)}
                    style={{
                      width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                      padding: '7px 11px', background: 'transparent', border: 'none', cursor: 'pointer',
                      textAlign: 'left',
                    }}
                  >
                    {/* GEMS shield icon */}
                    <div style={{
                      width: 26, height: 26, borderRadius: 6,
                      background: `linear-gradient(135deg, ${GEMS_TEAL} 0%, #00695C 100%)`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      flexShrink: 0, boxShadow: '0 2px 6px rgba(0,137,123,0.35)',
                    }}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round">
                        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                      </svg>
                    </div>

                    {/* Verified checkmark */}
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={GEMS_TEAL} strokeWidth="3" strokeLinecap="round" style={{ flexShrink: 0 }}>
                      <polyline points="20 6 9 17 4 12"/>
                    </svg>

                    {/* Patient name pill */}
                    <span style={{
                      fontSize: '0.79rem', fontWeight: 800, color: '#004D40',
                      letterSpacing: '-0.01em', lineHeight: 1.2,
                      maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {lookupResult.patient_name || 'Patient'}
                    </span>

                    {/* Divider */}
                    <span style={{ width: 1, height: 12, background: GEMS_BORDER, flexShrink: 0 }} />

                    {/* Member number chip */}
                    <span style={{
                      fontSize: '0.68rem', fontWeight: 700, color: GEMS_TEAL,
                      background: GEMS_ACCENT, border: `1px solid ${GEMS_BORDER}`,
                      padding: '1px 7px', borderRadius: 99, letterSpacing: '0.04em',
                      fontFamily: 'monospace',
                    }}>
                      {memberNo}
                    </span>

                    {/* GEMS badge */}
                    <span style={{
                      fontSize: '0.58rem', fontWeight: 800, color: GEMS_TEAL,
                      textTransform: 'uppercase', letterSpacing: '0.12em', opacity: 0.75,
                    }}>
                      GEMS Verified
                    </span>

                    {/* Expand chevron */}
                    <svg
                      width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={GEMS_TEAL}
                      strokeWidth="2.5" strokeLinecap="round"
                      style={{
                        marginLeft: 'auto', flexShrink: 0,
                        transform: profileExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                        transition: 'transform 0.2s',
                      }}
                    >
                      <polyline points="6 9 12 15 18 9"/>
                    </svg>
                  </button>

                  {/* ── Expanded Panel ── */}
                  {profileExpanded && (
                    <div style={{
                      borderTop: `1px solid ${GEMS_BORDER}`,
                      background: 'var(--surface-0)',
                      padding: '10px 12px 12px',
                    }}>
                      {/* Source watermark */}
                      <div style={{
                        display: 'flex', alignItems: 'center', gap: 5, marginBottom: 8,
                        fontSize: '0.62rem', color: GEMS_TEAL, fontWeight: 700,
                        textTransform: 'uppercase', letterSpacing: '0.1em', opacity: 0.8,
                      }}>
                        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                        </svg>
                        Authoritative data from {lookupResult.source || scheme} API
                      </div>

                      {/* Two-column grid for space efficiency */}
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 16px' }}>
                        {verifiedFields.map(({ icon, label, value, highlight }) => (
                          <div key={label} style={{
                            display: 'flex', flexDirection: 'column', gap: 1,
                            padding: '5px 7px', borderRadius: 6,
                            background: highlight ? GEMS_ACCENT : 'transparent',
                            border: highlight ? `1px solid ${GEMS_BORDER}` : '1px solid transparent',
                          }}>
                            <span style={{
                              fontSize: '0.58rem', fontWeight: 700, color: 'var(--text-muted)',
                              textTransform: 'uppercase', letterSpacing: '0.08em', display: 'flex', alignItems: 'center', gap: 3,
                            }}>
                              <span style={{ fontSize: '0.65rem' }}>{icon}</span>
                              {label}
                            </span>
                            <span style={{
                              fontSize: '0.78rem', fontWeight: highlight ? 700 : 500,
                              color: highlight ? '#004D40' : 'var(--text-primary)',
                              lineHeight: 1.3,
                              maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            }}>
                              {value}
                            </span>
                          </div>
                        ))}
                      </div>

                      {/* Footer note */}
                      <div style={{
                        marginTop: 9, padding: '5px 7px', borderRadius: 6,
                        background: 'rgba(0,137,123,0.04)', border: `1px solid ${GEMS_BORDER}`,
                        display: 'flex', alignItems: 'center', gap: 5,
                      }}>
                        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke={GEMS_TEAL} strokeWidth="2.5" strokeLinecap="round">
                          <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                        </svg>
                        <span style={{ fontSize: '0.62rem', color: GEMS_TEAL, fontWeight: 600 }}>
                          All data above has been auto-filled into the form. Scheme data is authoritative.
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              );
            };

            return (
              <>
                <div className="prf-s">
                  {/* ── GEMS Patient Profile Card (inline, shown when verified) ── */}
                  <GemsProfileCard />

                  {/* ── Tile header ── */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, marginTop: isVerified ? 4 : 4 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ width: 3, height: 16, borderRadius: 2, background: '#2563eb', flexShrink: 0 }} />
                      <span style={{ fontSize: '0.68rem', fontWeight: 800, color: '#2563eb', letterSpacing: '0.1em', textTransform: 'uppercase' }}>01</span>
                      <span style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.01em' }}>Patient &amp; Victim Details</span>
                    </div>

                    {/* Right side: lookup button or no-api pill — only shown before verification */}
                    {!isVerified && hasSchemeAndMember && (
                      isGems ? (
                        <button
                          onClick={handleLookup}
                          disabled={lookupLoading}
                          title={`Look up patient from ${scheme} API`}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 5,
                            fontSize: '0.68rem', fontWeight: 700,
                            padding: '4px 11px', borderRadius: 99,
                            border: '1px solid rgba(124,58,237,0.35)',
                            background: lookupLoading ? 'rgba(124,58,237,0.04)' : 'rgba(124,58,237,0.08)',
                            color: '#7c3aed', cursor: lookupLoading ? 'wait' : 'pointer',
                            transition: 'all 0.15s', letterSpacing: '0.02em',
                            opacity: lookupLoading ? 0.7 : 1,
                          }}>
                          {lookupLoading
                            ? <><div style={{ width: 10, height: 10, border: '1.5px solid rgba(124,58,237,0.3)', borderTopColor: '#7c3aed', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} /> Looking up…</>
                            : <><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg> {scheme} Patient Lookup</>
                          }
                        </button>
                      ) : (
                        <div
                          title={`No patient lookup API is linked for ${scheme} yet. Enter patient details manually.`}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 5,
                            fontSize: '0.67rem', fontWeight: 700,
                            padding: '4px 11px', borderRadius: 99,
                            border: '1px solid rgba(156,163,175,0.4)',
                            background: 'rgba(156,163,175,0.07)',
                            color: 'var(--text-muted)', cursor: 'default',
                          }}>
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                          {scheme} — No API linked
                        </div>
                      )
                    )}
                  </div>

                  <G2>
                    {F('Full Name & Surname', 'patient_name', data)}
                    {F('Patient ID Number', 'patient_id_number', data)}
                    {F('Gender', 'gender', data)}
                    {/* smart phone field */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <label style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span>Contact Number</span>
                        {!data.patient_phone && data.main_member_phone && (
                          <button
                            onClick={() => handleFieldChange('patient_phone', data.main_member_phone)}
                            title="Fill from main member's number"
                            style={{ fontSize: '0.62rem', fontWeight: 700, padding: '1px 7px', borderRadius: 99, border: '1px solid rgba(8,131,149,0.35)', background: 'rgba(8,131,149,0.07)', color: '#088395', cursor: 'pointer', lineHeight: 1.6 }}>
                            ← copy from main member
                          </button>
                        )}
                      </label>
                      <input autoComplete="off"
                        id="field-patient_phone"
                        className={`form-control ${highlightedFields.includes('patient_phone') ? 'pulsate-red' : ''}`}
                        style={{ fontSize: '0.84rem', padding: '7px 12px', borderRadius: 8, height: 36, borderColor: !data.patient_phone && data.main_member_phone ? 'rgba(8,131,149,0.4)' : undefined }}
                        value={data.patient_phone ?? ''}
                        onChange={e => handleFieldChange('patient_phone', e.target.value)}
                        placeholder={!data.patient_phone && data.main_member_phone ? `Main member: ${data.main_member_phone}` : ''}
                      />
                      {!data.patient_phone && data.main_member_phone && (
                        <span style={{ fontSize: '0.63rem', color: '#088395', fontWeight: 500 }}>ℹ Dependant patient — main member's number available</span>
                      )}
                    </div>
                    {F('Medical Scheme Relationship', 'patient_relationship', data)}
                  </G2>
                  {F('Scene Address / Residential', 'patient_address', data, { full: true })}
                </div>
              </>
            );
          })()}

          {/* ── §02 Authorization & Medical Scheme (+ Pre-Auth) ── */}
          {(() => {
            const authNum     = (data.authorization_number || '').toString().trim();
            const hasAuth     = !!authNum;
            const schemeName  = (data.medical_scheme || '').toString().trim() || 'scheme';
            const memberNo    = (data.member_number || '').toString().trim();
            const isIFT       = (data.incident_type || '').toLowerCase().includes('ift') ||
                                (data.incident_type || '').toLowerCase().includes('inter');
            const oS  = parseFloat(String(data.odometer_dispatch    || '').replace(/[^\d.]/g, ''));
            const oE  = parseFloat(String(data.odometer_destination || '').replace(/[^\d.]/g, ''));
            const dist = (!isNaN(oS) && !isNaN(oE)) ? Math.max(0, oE - oS) : null;

            /* Chip style for the summary popup rows */
            const chip = (val: string): React.CSSProperties => ({
              display: 'inline-flex', alignItems: 'center',
              padding: '2px 10px', borderRadius: 99, fontSize: '0.74rem', fontWeight: 600,
              background: val ? 'rgba(8,131,149,0.07)' : 'rgba(245,124,0,0.09)',
              color: val ? '#088395' : '#b45309',
              border: `1px solid ${val ? 'rgba(8,131,149,0.18)' : 'rgba(245,124,0,0.22)'}`,
              maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            });

            /* Auth summary popup */
            const AuthPopup = () => {
              if (!authPopupOpen) return null;
              const rows: [string, string][] = [
                ['Medical Scheme',   schemeName],
                ['Scheme Option',    data.scheme_option   || ''],
                ['Membership #',     memberNo],
                ['Dependant Code',   data.dependent_code  || ''],
                ['Patient ID',       data.patient_id_number || ''],
                ['Date of Incident', data.incident_date   || ''],
                ['Incident Type',    data.incident_type   || ''],
                ['Level of Care',    data.level_of_care   || ''],
                ['Transport From',   data.incident_location || ''],
                ['Transport To',     data.receiving_facility || ''],
                ['Distance (km)',    dist !== null ? `${dist} km` : ''],
                ['ICD-10',          data.primary_icd10 || (Array.isArray(data.icd10_codes) ? data.icd10_codes[0] : '') || ''],
                ['Primary Diagnosis',data.primary_diagnosis || ''],
                ['Procedures',       Array.isArray(data.procedures) ? data.procedures.join(', ') : (data.procedures || '')],
                ['BHF Practice #',   data.bhf_practice_number || ''],
                ['HPCSA #',          data.crew_member_1_hpcsa || ''],
                ['Auth / Ref No.',   authNum || 'Not yet obtained'],
              ];
              return (
                <>
                  <div onClick={() => setAuthPopupOpen(false)}
                    style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 1200, backdropFilter: 'blur(2px)' }} />
                  <div style={{
                    position: 'fixed', top: '50%', left: '50%',
                    transform: 'translate(-50%,-50%)',
                    zIndex: 1201, width: 430, maxHeight: '80vh',
                    borderRadius: 14, overflow: 'hidden',
                    background: 'var(--surface-0)',
                    border: `1px solid ${hasAuth ? 'rgba(22,163,74,0.25)' : 'rgba(245,124,0,0.3)'}`,
                    boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
                    display: 'flex', flexDirection: 'column',
                  }}>
                    {/* Header */}
                    <div style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      background: hasAuth ? 'rgba(22,163,74,0.08)' : 'rgba(245,124,0,0.07)',
                      borderBottom: `1px solid ${hasAuth ? 'rgba(22,163,74,0.15)' : 'rgba(245,124,0,0.18)'}` }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {hasAuth
                          ? <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2.8" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                          : <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2.5" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                        }
                        <span style={{ fontSize: '0.88rem', fontWeight: 700, color: hasAuth ? '#15803d' : '#92400e' }}>
                          {hasAuth ? `Authorised — ${schemeName}` : `Pre-Auth Summary — ${schemeName}`}
                        </span>
                      </div>
                      <button onClick={() => setAuthPopupOpen(false)}
                        style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '1.1rem', lineHeight: 1, padding: '0 2px' }}>✕</button>
                    </div>
                    {/* Rows */}
                    <div style={{ padding: '14px 18px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {rows.map(([label, value]) => (
                        <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                          <span style={{ fontSize: '0.67rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap', flexShrink: 0 }}>{label}</span>
                          <span style={chip(value)}>{value || <em style={{ opacity: 0.55 }}>missing</em>}</span>
                        </div>
                      ))}
                    </div>
                    <div style={{ padding: '10px 18px', background: 'var(--surface-50)', borderTop: '1px solid var(--surface-100)' }}>
                      <p style={{ fontSize: '0.67rem', color: 'var(--text-muted)', margin: 0 }}>
                        {hasAuth
                          ? 'This claim is authorised. The auth number will be included on the Pro-Forma Invoice.'
                          : 'No auth number is recorded. On confirm, a pre-authorisation request will be submitted to the scheme.'}
                      </p>
                    </div>
                  </div>
                </>
              );
            };

            return (
              <>
                <AuthPopup />
                <div className="prf-s">

                  {/* ── Tile header ── */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, marginTop: 4 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ width: 3, height: 16, borderRadius: 2, background: teal, flexShrink: 0 }} />
                      <span style={{ fontSize: '0.68rem', fontWeight: 800, color: teal, letterSpacing: '0.1em', textTransform: 'uppercase' }}>02</span>
                      <span style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.01em' }}>Authorization &amp; Medical Scheme</span>
                    </div>

                    {/* Auth status badge — always shown once scheme is identified */}
                    {schemeName !== 'scheme' && (
                      <button
                        onClick={() => setAuthPopupOpen(true)}
                        title={hasAuth ? 'Click to view authorisation details' : 'Click to review pre-auth summary'}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 6,
                          padding: '5px 12px', borderRadius: 99, cursor: 'pointer',
                          border: `1px solid ${hasAuth ? 'rgba(22,163,74,0.35)' : 'rgba(245,124,0,0.45)'}`,
                          background: hasAuth ? 'rgba(22,163,74,0.09)' : 'rgba(245,124,0,0.09)',
                          transition: 'all 0.15s',
                        }}>
                        {hasAuth ? (
                          <>
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="3" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                            <span style={{ fontSize: '0.68rem', fontWeight: 800, color: '#15803d', letterSpacing: '0.02em' }}>Authorised</span>
                            <span style={{ width: 1, height: 12, background: 'rgba(22,163,74,0.3)', flexShrink: 0 }} />
                            <span style={{ fontSize: '0.65rem', fontWeight: 600, color: '#16a34a', opacity: 0.85, maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{authNum}</span>
                            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2.5" strokeLinecap="round"><polyline points="6 9 12 15 18 9"/></svg>
                          </>
                        ) : (
                          <>
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2.5" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                            <span style={{ fontSize: '0.68rem', fontWeight: 800, color: '#b45309', letterSpacing: '0.02em' }}>Auth Pending</span>
                            <span style={{ width: 1, height: 12, background: 'rgba(245,124,0,0.35)', flexShrink: 0 }} />
                            <span style={{ fontSize: '0.65rem', fontWeight: 600, color: '#d97706', opacity: 0.85 }}>{schemeName}</span>
                            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2.5" strokeLinecap="round"><polyline points="6 9 12 15 18 9"/></svg>
                          </>
                        )}
                      </button>
                    )}
                  </div>

                  {/* ── Scheme fields section removed ── */}
                  {/* ── Authorization Number (Standard style) ── */}
                  <div style={{ marginTop: 8 }}>
                    <label style={{ fontSize: '0.62rem', fontWeight: 800, color: teal, textTransform: 'uppercase', letterSpacing: '0.08em', display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                      Authorization / Reference No.
                    </label>
                    <input autoComplete="off" id="field-authorization_number" className={`form-control ${highlightedFields.includes('authorization_number') ? 'pulsate-red' : ''}`} style={{ fontSize: '0.88rem', fontWeight: 700, height: 34, letterSpacing: '0.04em', borderColor: teal }}
                      value={data.authorization_number ?? ''} onChange={e => handleFieldChange('authorization_number', e.target.value)} />
                  </div>

                  {/* ── Additional fields shown only when auth is MISSING ── */}
                  {!hasAuth && (
                    <>
                      <HR />
                      <div style={{ fontSize: '0.62rem', fontWeight: 800, color: teal, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Pre-Authorization Details</div>
                      
                      {isIFT && (
                        <div style={{ marginBottom: 6 }}>
                          <label style={{ fontSize: '0.62rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                            Referring Doctor PR #
                          </label>
                          <input autoComplete="off" className="form-control" placeholder="e.g. PR0001234" value={authReferringPr} onChange={e => setAuthReferringPr(e.target.value)} style={{ fontSize: '0.84rem', padding: '7px 12px', borderRadius: 8, height: 36 }} />
                        </div>
                      )}
                      
                      {/* Sending indicator / toast */}
                      {authRequestSending && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.8rem', color: teal, fontWeight: 600, marginTop: 4 }}>
                          <div style={{ width: 13, height: 13, border: '2px solid rgba(8,131,149,0.25)', borderTopColor: teal, borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
                          Sending pre-auth request to {schemeName}…
                        </div>
                      )}
                      {authRequestToast && !authRequestSending && (
                        <div style={{ padding: '8px 12px', borderRadius: 8, background: 'rgba(8,131,149,0.08)', border: '1px solid rgba(8,131,149,0.2)', fontSize: '0.78rem', color: teal, fontWeight: 600, marginTop: 4 }}>
                          ✓ {authRequestToast}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </>
            );
          })()}

          {/* ── §3 Provider & Crew ── */}
          <div className="prf-s">
            <Sec num="03" title="Provider & Crew" color={purple} />
            <G2>
              {F('Service Provider', 'service_provider_name', data)}
              {F('Vehicle Registration', 'vehicle_registration', data)}
              {F('Call Sign', 'vehicle_callsign', data)}
            </G2>
            <HR />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {renderCrewRow(1, 'crew_member_1_name', 'crew_member_1_initials', 'crew_member_1_qualification', 'crew_member_1_hpcsa')}
              {renderCrewRow(2, 'crew_member_2_name', 'crew_member_2_initials', 'crew_member_2_qualification', 'crew_member_2_hpcsa')}
            </div>
          </div>

          {/* ── §4 Incident Logistics & Timestamps ── */}
          <div className="prf-s">
            <Sec num="04" title="Incident Logistics & Timestamps" color={amber} />
            <G3>
              {F('Date of Service', 'incident_date', data)}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <label style={{ fontSize: '0.62rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Incident Type</label>
                <select className="form-control" style={{ fontSize: '0.8rem', height: 32 }}
                  value={data.incident_type ?? ''} onChange={e => handleFieldChange('incident_type', e.target.value)}>
                  <option value="">—</option>
                  <option value="Primary">Primary</option>
                  <option value="Inter-Facility Transfer">IFT</option>
                </select>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <label style={{ fontSize: '0.62rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Multi-Patient <span style={{ color: amber }}>150%</span></label>
                <select className="form-control" style={{ fontSize: '0.8rem', height: 32 }}
                  value={data.multiple_patient_indicator ?? ''} onChange={e => handleFieldChange('multiple_patient_indicator', e.target.value)}>
                  <option value="">Single</option>
                  <option value="Patient 1 of 2">1 of 2</option>
                  <option value="Patient 2 of 2">2 of 2</option>
                  <option value="Patient 1 of 3">1 of 3</option>
                  <option value="Patient 2 of 3">2 of 3</option>
                  <option value="Patient 3 of 3">3 of 3</option>
                </select>
              </div>
            </G3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '7px 12px', marginTop: 7 }}>
              {F('LOC Dispatched', 'level_of_care_dispatched', data)}
              {F('LOC Rendered', 'level_of_care', data)}
              <PlacesAutocomplete
                label="Scene Address / GPS"
                value={data.incident_location || ''}
                onChange={val => handleFieldChange('incident_location', val)}
                onLocationSelect={(address, lat, lng) => {
                  handleFieldChange('incident_location', address);
                  handleFieldChange('scene_lat', String(lat));
                  handleFieldChange('scene_lng', String(lng));
                }}
                placeholder="Start typing scene address…"
              />
              <PlacesAutocomplete
                label="Receiving Facility"
                value={data.receiving_facility || ''}
                onChange={val => handleFieldChange('receiving_facility', val)}
                onLocationSelect={(address, lat, lng) => {
                  handleFieldChange('receiving_facility', address);
                  handleFieldChange('dest_lat', String(lat));
                  handleFieldChange('dest_lng', String(lng));
                }}
                placeholder="Hospital or facility name…"
                hint="Type hospital name or address"
              />

            </div>
            <HR />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div>
                <div style={{ fontSize: '0.62rem', fontWeight: 800, color: amber, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>Times (24h)</div>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <tbody>
                    {[
                      ['Call Dispatched', 'dispatch_time'],
                      ['Arrival at Scene', 'on_scene_time'],
                      ['Departure Scene', 'departure_from_scene_time'],
                      ['Arrival Destination', 'hospital_arrival_time'],
                      ['Handover Complete', 'handover_complete_time'],
                    ].map(([label, key]) => (
                      <tr key={key} className="prf-ti">
                        <td>{label}</td>
                        <td><input autoComplete="off" id={`field-${key}`} className={`form-control ${highlightedFields.includes(key) ? 'pulsate-red' : ''}`} style={{ fontSize: '0.78rem', padding: '3px 6px', height: 28, fontWeight: 700, letterSpacing: '0.04em' }}
                          value={data[key] ?? ''} onChange={e => handleFieldChange(key, e.target.value)} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div>
                {/* ── Odometer header + prefix badge ── */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  <div style={{ fontSize: '0.62rem', fontWeight: 800, color: amber, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Odometers (km)</div>
                  {data.odometer_prefix_detected && (
                    <div title="System detected a common prefix across all odometer readings and used it to anchor/correct values" style={{
                      display: 'flex', alignItems: 'center', gap: 5,
                      fontSize: '0.65rem', fontWeight: 700,
                      padding: '2px 9px', borderRadius: 99,
                      border: '1px solid rgba(8,131,149,0.3)',
                      background: 'rgba(8,131,149,0.07)',
                      color: '#088395', cursor: 'default',
                    }}>
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                      Prefix: <strong style={{ letterSpacing: '0.06em' }}>{data.odometer_prefix_detected}…</strong>
                    </div>
                  )}
                </div>

                {/* ── Odometer table with validity indicators ── */}
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <tbody>
                    {([
                      ['Dispatch',          'odometer_dispatch'],
                      ['At Scene',          'odometer_at_scene'],
                      ['Departure Scene',   'odometer_departure'],
                      ['At Destination',    'odometer_destination'],
                      ['Return to Base ★',  'odometer_rtb'],
                    ] as [string, string][]).map(([label, key]) => {
                      const rawVal: string = String(data[key] ?? '');
                      const isAutoCorrected  = rawVal.startsWith('*');
                      const isSequenceError  = rawVal.startsWith('!');
                      const isMissing        = !rawVal;
                      const displayVal       = rawVal.replace(/^[*!]/, '');

                      const isFlagged = Array.isArray(data.odometer_flagged_keys)
                        ? data.odometer_flagged_keys.includes(key)
                        : false;
                      const wasCorrected = Array.isArray(data.odometer_corrections)
                        ? data.odometer_corrections.includes(key)
                        : false;

                      // Colour logic: red = missing/sequence error, amber = auto-corrected, green = ok
                      const dotColor = (isMissing || isSequenceError || isFlagged)
                        ? '#ef4444'
                        : (isAutoCorrected || wasCorrected)
                          ? '#f59e0b'
                          : data.odometer_prefix_detected
                            ? '#22c55e'
                            : 'var(--text-muted)';

                      const prefix = data.odometer_prefix_detected as string | undefined;
                      const canFix = prefix && displayVal && !displayVal.startsWith(prefix);

                      return (
                        <tr key={key} className="prf-ti">
                          <td style={{ paddingRight: 6 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                              {/* Validity dot */}
                              <div title={
                                (isMissing || isFlagged) ? 'Missing or sequence error — manual fix needed'
                                : (isAutoCorrected || wasCorrected) ? 'Auto-corrected by prefix anchoring — verify'
                                : 'OK'
                              } style={{
                                width: 7, height: 7, borderRadius: '50%',
                                background: dotColor, flexShrink: 0,
                                border: `1px solid ${dotColor}`,
                              }} />
                              <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 500 }}>{label}</span>
                              {(isAutoCorrected || wasCorrected) && (
                                <span title="Value was auto-corrected by prefix anchoring" style={{
                                  fontSize: '0.58rem', fontWeight: 800, letterSpacing: '0.04em',
                                  color: '#f59e0b', background: 'rgba(245,158,11,0.1)',
                                  padding: '1px 5px', borderRadius: 4,
                                }}>FIXED</span>
                              )}
                            </div>
                          </td>
                          <td>
                            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                              <input autoComplete="off"
                                id={`field-${key}`}
                                className={`form-control ${highlightedFields.includes(key) ? 'pulsate-red' : ''}`}
                                style={{
                                  fontSize: '0.78rem', padding: '3px 6px', height: 28, fontWeight: 700,
                                  borderColor: (isMissing || isFlagged) ? 'rgba(239,68,68,0.5)'
                                    : (isAutoCorrected || wasCorrected) ? 'rgba(245,158,11,0.45)'
                                    : undefined,
                                }}
                                value={displayVal}
                                onChange={e => handleFieldChange(key, e.target.value)}
                              />
                              {/* One-click re-apply prefix button */}
                              {canFix && (
                                <button
                                  title={`Prepend prefix '${prefix}' to this reading`}
                                  onClick={() => handleFieldChange(key, prefix + displayVal)}
                                  style={{
                                    flexShrink: 0, height: 28, padding: '0 7px',
                                    borderRadius: 6, border: '1px solid rgba(8,131,149,0.4)',
                                    background: 'rgba(8,131,149,0.08)', color: '#088395',
                                    cursor: 'pointer', fontSize: '0.68rem', fontWeight: 800,
                                    whiteSpace: 'nowrap',
                                  }}
                                >
                                  ← {prefix}
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>

                {/* ── Trip distance row ── */}
                {(() => {
                  const s  = parseFloat(String(data.odometer_dispatch    || '').replace(/[^\d.]/g, ''));
                  const e2 = parseFloat(String(data.odometer_destination || '').replace(/[^\d.]/g, ''));
                  const dist = (!isNaN(s) && !isNaN(e2)) ? Math.max(0, e2 - s) : null;
                  const isUnusual = dist !== null && (dist < 0 || dist > 150);
                  return (
                    <div style={{ marginTop: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', gap: 8 }}>
                      <span style={{ fontSize: '0.68rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Trip Distance</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {isUnusual && (
                          <span title="Distance seems unusual — check odometer readings" style={{
                            display: 'flex', alignItems: 'center', gap: 4,
                            fontSize: '0.62rem', fontWeight: 700, color: '#b45309',
                            background: 'rgba(245,124,0,0.09)', border: '1px solid rgba(245,124,0,0.25)',
                            padding: '2px 7px', borderRadius: 99,
                          }}>
                            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                            Unusual
                          </span>
                        )}
                        <span style={{ fontSize: '0.92rem', fontWeight: 800, color: isUnusual ? '#f59e0b' : amber }}>
                          {dist !== null ? `${dist} km` : '— km'}
                        </span>
                      </div>
                    </div>
                  );
                })()}
              </div>
            </div>
          </div>

          {/* ── §5 Clinical Assessment ── */}
          <div className="prf-s">
            <Sec num="05" title="Clinical Assessment & Interventions" color={rose} />
            <G2>
              {F('Chief Complaint', 'chief_complaint', data)}
              {F('Primary Diagnosis', 'primary_diagnosis', data)}
            </G2>
            <div style={{ marginTop: 8 }}>
              <G2>
                {F('Primary ICD-10', 'primary_icd10', data)}
              </G2>
            </div>
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: '0.62rem', fontWeight: 800, color: rose, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 5 }}>ICD-10 Search</div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <ICD10CodeAdder onAdd={(code) => handleFieldChange('primary_icd10', code)} />
              </div>
            </div>
          </div>
        </div>
      );
    } catch (e) {
      return (
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--danger)' }}>
          <p>Invalid JSON format. Switch to JSON view to fix.</p>
        </div>
      );
    }
  };

  useEffect(() => {
    if (id) {
      setSaving(false);
      setError("");
      setHighlightedFields([]);
      fetchDocument();
    }
    // Load PRF name template and dynamic fields from settings
    api.get("/api/knowledge-base/extraction-settings").then((res) => {
      if (res.data.prf_name_template) {
        setPrfNameTemplate(res.data.prf_name_template);
      }
      
      if (res.data.fields && res.data.fields.length > 0) {
        const catMap = new Map<string, string[]>();
        res.data.fields.forEach((f: any) => {
          if (!catMap.has(f.category)) {
            catMap.set(f.category, []);
          }
          if (f.key) {
            catMap.get(f.category)!.push(f.key);
          }
        });
        
        // formCategories is now static — rendering done in renderFormView (catMap built above for potential future use)
      }
    });
    api.get(`/api/documents/${id}`).catch(() => {});

    // If a highlight query parameter was loaded, attempt to scroll to it once the render is done.
    if (searchParams.get("highlight")) {
      setTimeout(() => {
        document
          .getElementById(`field-${searchParams.get("highlight")}`)
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 500);
    }
  }, [id, searchParams]);

  useEffect(() => {
    return () => {
      if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    };
  }, [pdfUrl]);

  const fetchDocument = async () => {
    setLoading(true);
    try {
      const res = await api.get(`/api/documents/${id}`);
      setDoc(res.data);
      setEditedFilename(res.data.original_filename);
      let extractionData = res.data.extracted_data || {};

      try {
        const settingsRes = await api.get(
          "/api/knowledge-base/extraction-settings",
        );
        const customFields = settingsRes.data.fields || [];
        if (customFields.length > 0) {
          const catsMap = new Map<string, string[]>();
          customFields.forEach((cf: any) => {
            if (!catsMap.has(cf.category)) catsMap.set(cf.category, []);
            catsMap.get(cf.category)!.push(cf.key);

            if (extractionData[cf.key] === undefined) {
              extractionData[cf.key] = "";
            }
          });

          // ── Ensure mandatory clinical fields always present ──
          const clinicalCatName = ["Clinical Notes", "Clinical Details"].find(n => catsMap.has(n)) || "Clinical Details";
          if (!catsMap.has(clinicalCatName)) catsMap.set(clinicalCatName, []);
          const clinicalKeys = catsMap.get(clinicalCatName)!;
          if (!clinicalKeys.includes("icd10_codes")) {
            clinicalKeys.push("icd10_codes");
          }

          const incidentCatName = ["Incident Details", "Incident details"].find(n => catsMap.has(n)) || "Incident Details";
          if (!catsMap.has(incidentCatName)) catsMap.set(incidentCatName, []);
          const incidentKeys = catsMap.get(incidentCatName)!;
          if (!incidentKeys.includes("level_of_care")) {
            incidentKeys.push("level_of_care");
          }

          if (extractionData.icd10_codes === undefined) extractionData.icd10_codes = [];
          if (extractionData.level_of_care === undefined) extractionData.level_of_care = "";

          // formCategories is static — custom field data is still pre-populated into extractionData above
        } else {
          // No custom settings — inject defaults from the hardcoded formCategories.
          // Use proper types for array and boolean fields so the new renderers work.
          const ARRAY_DEFAULTS: Record<string, any[]> = {
            icd10_codes: [], vital_signs: [], medications_given: [],
            procedures: [], tariff_codes: [],
          };
          const BOOL_DEFAULTS: Record<string, boolean> = {
            treating_practitioner_signature_present: false,
            patient_signature_present: false,
            provider_signature_present: false,
            receiving_facility_signature_present: false,
          };
          formCategories.forEach((c) =>
            c.keys.forEach((k) => {
              if (extractionData[k] === undefined) {
                if (k in ARRAY_DEFAULTS) extractionData[k] = ARRAY_DEFAULTS[k];
                else if (k in BOOL_DEFAULTS) extractionData[k] = BOOL_DEFAULTS[k];
                else extractionData[k] = "";
              }
            }),
          );
        }
      } catch (err) {
        if (extractionData.icd10_codes === undefined) extractionData.icd10_codes = [];
        if (extractionData.level_of_care === undefined) extractionData.level_of_care = "";
      }

      // Auto-correct deprecated BLS to ILS (SA EMS no longer uses BLS)
      if (extractionData.level_of_care) {
        const loc = String(extractionData.level_of_care).trim().toUpperCase();
        if (loc === "BLS" || loc === "BASIC" || loc === "BASIC LIFE SUPPORT") {
          extractionData.level_of_care = "ILS";
        }
      }

      setEditedData(
        JSON.stringify(
          extractionData,
          Object.keys(extractionData).length > 0 ? null : undefined,
          2,
        ) || "{\n  \n}",
      );
      // Freeze the original AI extraction once — never overwrite.
      if (originalAiDataRef.current === null) {
        originalAiDataRef.current = { ...(res.data.extracted_data || {}) };
      }

      // Fetch bundled documents if this doc is in a group
      if (res.data.group_id) {
        try {
          const grpRes = await api.get(`/api/documents/group/${res.data.group_id}`);
          setGroupedDocs(grpRes.data.documents || []);
        } catch {
          setGroupedDocs([]);
        }
      } else {
        setGroupedDocs([]);
      }

    } catch (err) {
      setError("Failed to load document");
    } finally {
      setLoading(false);
    }

    // Fetch the file separately — a missing file should NOT block the review form
    try {
      const fileRes = await api.get(`/api/documents/${id}/download`, {
        responseType: "blob",
      });
      const url = URL.createObjectURL(fileRes.data);
      setPdfUrl(url + "#view=FitH");
    } catch (err) {
      setPdfUrl(null);
    }
  };

  const handleSave = async (clearReviewFlag: boolean) => {
    if (clearReviewFlag) {
      const confirm = window.confirm(
        "Is all the information correct?\n\nThis will verify the folder and push it through the adjudication system.",
      );
      if (!confirm) return;
    }

    setSaving(true);
    setError("");

    try {
      let parsedData;
      try {
        parsedData = JSON.parse(editedData);
      } catch (e) {
        throw new Error(
          "Invalid JSON format. Please check the extracted data.",
        );
      }

      const res = await api.patch(`/api/documents/${id}/review`, {
        extracted_data: parsedData,
        original_filename: editedFilename,
        clear_review_flag: clearReviewFlag,
      });

      // ── Fire-and-forget: log corrections for self-learning ──────────────────
      // Uses originalAiDataRef (frozen on first load) — never poisoned by draft saves.
      if (clearReviewFlag && originalAiDataRef.current) {
        try {
          const original = originalAiDataRef.current;
          const corrections: {field_name: string; ai_value: string | null; corrected_value: string}[] = [];
          // Skip: arrays (complex), booleans (toggled via SigToggle — not text corrections)
          // Also skip patient-specific values (phone numbers) — these should never become universal AI rules
          const SKIP = new Set([
            'vital_signs', 'line_items', 'medications_given', 'procedures', 'icd10_codes', 'tariff_codes',
            'treating_practitioner_signature_present', 'patient_signature_present',
            'receiving_facility_signature_present', 'provider_signature_present',
            'patient_phone', 'main_member_phone',  // patient-specific: don't inject as universal rules
          ]);
          for (const [key, correctedVal] of Object.entries(parsedData)) {
            if (SKIP.has(key)) continue;
            if (typeof correctedVal !== 'string' && typeof correctedVal !== 'number' && correctedVal !== null) continue;
            const aiVal = original[key] ?? null;
            const corrStr = String(correctedVal ?? '').trim();
            const aiStr = String(aiVal ?? '').trim();
            if (aiStr !== corrStr && corrStr !== '') {
              corrections.push({ field_name: key, ai_value: aiStr || null, corrected_value: corrStr });
            }
          }
          if (corrections.length > 0) {
            api.post('/api/corrections/', {
              document_id: id,
              prf_number: parsedData.prf_number || null,
              medical_scheme: parsedData.medical_scheme || null,
              corrections,
            }).catch(() => {}); // fire-and-forget
          }
        } catch { /* non-fatal — never block the confirm flow */ }
      }

      if (clearReviewFlag && res.data.pipeline) {
        if (res.data.pipeline.error) {
          setError(`Pipeline Error: ${res.data.pipeline.error}`);
          setSaving(false);
          return;
        }

        if (res.data.adjudication) {
          if (res.data.adjudication.error) {
            setError(`Adjudication Error: ${res.data.adjudication.error}`);
            setSaving(false);
            return;
          }

          // ── Map backend field keys → actual form field IDs ───────────────
          //
          // The adjudication engine uses its own key names (e.g. "cpt_code",
          // "icd10_primary") which may differ from the PRF form field IDs
          // (e.g. "tariff_codes", "icd10_codes").  This map normalises them.
          const FIELD_KEY_MAP: Record<string, string> = {
            // Billing / tariff
            cpt_code:                    "tariff_codes",
            tariff_code:                 "tariff_codes",
            nappi_code:                  "tariff_codes",
            // ICD-10 / diagnosis
            icd10_primary:               "icd10_codes",
            primary_icd10:               "icd10_codes",
            external_cause_code:         "external_cause_code",
            // Scheme / membership
            member_number:               "member_number",
            medical_scheme:              "medical_scheme",
            scheme_name:                 "medical_scheme",
            dependent_code:              "dependent_code",
            preauth_number:              "preauth_number",
            authorization_number:        "preauth_number",
            // Patient
            patient_id_number:           "patient_id_number",
            patient_name:                "patient_name",
            // Provider / crew
            provider_practice_number:    "provider_practice_number",
            bhf_practice_number:         "bhf_practice_number",
            crew_member_1_hpcsa:         "crew_member_1_hpcsa",
            // Signatures
            patient_signature_present:   "patient_signature_present",
            treating_practitioner_signature_present: "treating_practitioner_signature_present",
          };

          // Map a check_name like "CPT_L3" or "ICD10_L1" to a form field ID
          const checkNameToField = (checkName: string): string | null => {
            const upper = checkName.toUpperCase();
            if (upper.startsWith("CPT"))        return "tariff_codes";
            if (upper.startsWith("ICD10"))      return "icd10_codes";
            if (upper.startsWith("NAPPI"))      return "tariff_codes";
            if (upper.startsWith("XWALK"))      return "icd10_codes";
            if (upper.startsWith("PREAUTH") || upper.includes("PREAUTH")) return "preauth_number";
            if (upper.startsWith("SIGNATURE"))  return "patient_signature_present";
            if (upper.startsWith("PROVIDER") || upper.includes("PROVIDER")) return "provider_practice_number";
            if (upper.startsWith("PATIENT_ID")) return "patient_id_number";
            if (upper.startsWith("SCHEME") || upper.includes("MEMBER")) return "member_number";
            return null;
          };

          // ── Collect all blocking issues ───────────────────────────────────
          const allRfis = res.data.adjudication.rfis || [];
          const allChecks: any[] = res.data.adjudication.checks || [];

          const blockingRfis = allRfis.filter(
            (rfi: any) => rfi.reason_code !== "MISSING_PREAUTH",
          );
          const failedChecks = allChecks.filter(
            (c: any) => !c.passed && c.severity === "error",
          );

          if (blockingRfis.length > 0 || failedChecks.length > 0) {
            const keysToHighlight = new Set<string>();

            // From RFI missing_fields (most reliable — field directly named)
            blockingRfis.forEach((rfi: any) => {
              const fieldsMap = rfi.missing_fields || {};
              Object.keys(fieldsMap).forEach((k) => {
                const mapped = FIELD_KEY_MAP[k] ?? k;
                keysToHighlight.add(mapped);
              });
            });

            // From checks array (catches errors not yet persisted as RFIs)
            failedChecks.forEach((c: any) => {
              const mapped = checkNameToField(c.check_name);
              if (mapped) keysToHighlight.add(mapped);
            });

            const highlightList = Array.from(keysToHighlight);
            if (highlightList.length > 0) {
              setTimeout(() => {
                setHighlightedFields(highlightList);
                // Scroll to the first highlighted field
                const firstEl = document.getElementById(`field-${highlightList[0]}`);
                if (firstEl) {
                  firstEl.scrollIntoView({ behavior: "smooth", block: "center" });
                  firstEl.focus();
                }
              }, 120);
            }

            // Build a human-readable error summary listing every issue
            const allMessages: string[] = [
              ...blockingRfis.map((r: any) =>
                r.description ?? r.reason_description ?? r.message ?? r.reason_code
              ),
              ...failedChecks
                .filter((c: any) => !blockingRfis.some((r: any) =>
                  // deduplicate — skip check messages already covered by an RFI
                  Object.values(r.missing_fields || {}).includes(c.message)
                ))
                .map((c: any) => c.message),
            ].filter(Boolean);

            const errorSummary =
              allMessages.length === 1
                ? `Verification Failed: ${allMessages[0]}`
                : `Verification Failed — ${allMessages.length} issue(s):\n• ${allMessages.join("\n• ")}`;

            setError(errorSummary);
            setSaving(false);
            return;
          }
        }
        
        // SUCCESSFUL VERIFICATION (pipeline succeeded, and either no adjudication or no blocking RFIs)

        // §08 — Fire auth request to scheme (fire-and-forget, never blocks navigation)
        try {
          const parsedForAuth = JSON.parse(editedData);
          const hasAuthNumber = !!(parsedForAuth.authorization_number || '').toString().trim();
          const caseId = res.data?.pipeline?.case_id || res.data?.case_id;
          const schemeName = (parsedForAuth.medical_scheme || '').toString().trim();

          // If no scheme at all — show the no-scheme action modal instead of proceeding silently
          if (!schemeName && caseId) {
            setSaving(false);
            const doNavigate = () => {
              if (isFocusMode && focusQueue.length > 0) {
                navigate(`/review/${focusQueue[0]}`, { state: { isFocusMode: true, focusQueue: focusQueue.slice(1), totalInFocus } });
              } else {
                navigate('/cases');
              }
            };
            setNoSchemeModal({ caseId, pendingNavigate: doNavigate });
            return; // halt here — modal will handle navigation
          }

          if (!hasAuthNumber && caseId && schemeName) {
            setAuthRequestSending(true);
            const odoDispatch = parseFloat(String(parsedForAuth.odometer_dispatch || '').replace(/[^\d.]/g, ''));
            const odoDest    = parseFloat(String(parsedForAuth.odometer_destination || '').replace(/[^\d.]/g, ''));
            const distKm     = (!isNaN(odoDispatch) && !isNaN(odoDest)) ? Math.max(0, odoDest - odoDispatch) : null;
            const memberData = {
              scheme:             schemeName,
              scheme_option:      parsedForAuth.scheme_option || '',
              membership_number:  parsedForAuth.member_number || '',
              dependant_code:     parsedForAuth.dependent_code || '',
              patient_id:         parsedForAuth.patient_id_number || '',
              patient_dob:        parsedForAuth.patient_dob || '',
            };
            const procedures = Array.isArray(parsedForAuth.procedures)
              ? parsedForAuth.procedures.join(', ')
              : (parsedForAuth.procedures || '');
            const icd10 = parsedForAuth.primary_icd10
              || (Array.isArray(parsedForAuth.icd10_codes) ? parsedForAuth.icd10_codes.join(', ') : '');
            const clinicalData = {
              incident_date:       parsedForAuth.incident_date || '',
              incident_type:       parsedForAuth.incident_type || '',
              level_of_care:       parsedForAuth.level_of_care || '',
              transport_from:      parsedForAuth.incident_location || '',
              transport_to:        parsedForAuth.receiving_facility || '',
              distance_km:         distKm !== null ? String(distKm) : '',
              chief_complaint:     parsedForAuth.chief_complaint || '',
              primary_diagnosis:   parsedForAuth.primary_diagnosis || '',
              icd10, procedures,
              referring_doctor_pr: authReferringPr.trim(),
              bhf_practice_number: parsedForAuth.bhf_practice_number || '',
              hpcsa_number:        parsedForAuth.crew_member_1_hpcsa || '',
              motivation:          authMotivation.trim() || 'Emergency medical transport was clinically necessary.',
            };
            // Fire-and-forget — never await-block navigation
            api.post(`/api/authorization/request/${caseId}`, {
              referring_doctor_pr: authReferringPr.trim() || undefined,
              dependant_code:      parsedForAuth.dependent_code || undefined,
              member_data: memberData,
              clinical_data: clinicalData,
            }).then(() => setAuthRequestToast(`Auth request sent to ${schemeName} — awaiting response`))
              .catch(() => setAuthRequestToast('Auth request queued — check Cases for status'))
              .finally(() => setAuthRequestSending(false));
          }
        } catch { /* ignore auth errors — never block navigation */ }

        if (isFocusMode && focusQueue.length > 0) {
          const nextId = focusQueue[0];
          const remaining = focusQueue.slice(1);
          navigate(`/review/${nextId}`, {
            state: {
              isFocusMode: true,
              focusQueue: remaining,
              totalInFocus,
            },
          });
        } else if (isFocusMode) {
          alert(
            `Focus Mode Complete! You have finished reviewing ${totalInFocus} records.`,
          );
          navigate('/cases');
        } else {
          navigate('/cases');
        }
      } else {
        navigate("/verify");
      }
    } catch (err: any) {
      setError(err.message || "Failed to save edits");
      setSaving(false);
    }
  };

  const handleReprocess = async (targetDocId?: string) => {
    if (!window.confirm("Are you sure you want to re-run AI extraction?\nThis will overwrite any manual unsaved changes.")) return;
    const docIdToProcess = targetDocId || id;
    setShowReextractPicker(false);
    setLoading(true);
    try {
      await api.post(`/api/documents/${docIdToProcess}/reprocess?engine=azure`);
      alert("Document sent back to the queue for re-extraction with latest AI settings.");
      navigate("/verify");
    } catch (err: any) {
      setError(err.message || "Failed to re-process document");
      setLoading(false);
    }
  };

  const handleReextractClick = () => {
    if (groupedDocs.length > 1) {
      setShowReextractPicker(true);
    } else {
      handleReprocess();
    }
  };

  if (loading) {
    return (
      <div
        className="page-content"
        style={{ display: "flex", justifyContent: "center", paddingTop: 100 }}
      >
        <div className="spinner" style={{ width: 40, height: 40 }} />
      </div>
    );
  }

  if (!doc) {
    return (
      <div className="page-content">
        <div className="empty-state">
          <h3>Document Not Found</h3>
          <button
            className="btn btn-primary"
            onClick={() => navigate("/verify")}
            style={{ marginTop: 16 }}
          >
            Back to Queue
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="page-content"
      style={{
        maxWidth: "100%",
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        padding: "8px 20px",
        overflow: "hidden",
      }}
    >
      <div className="page-header" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <button
            className="btn btn-secondary"
            onClick={() => navigate("/verify")}
          >
            ← Back
          </button>
          {!isFocusMode && (
            <>
              <div>
                <h1
                  className="page-title"
                  style={{
                    fontSize: "1.4rem",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    margin: 0
                  }}
                >
                  Review: {getPrfDisplayName()}
                </h1>
              </div>
            </>
          )}
          <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
            {!isFocusMode && (
              <button 
                className="btn btn-sm btn-secondary" 
                onClick={() => setIsExpandedWidth(!isExpandedWidth)}
                title={isExpandedWidth ? "Collapse View" : "Expand View Full Width"}
                style={{ display: "flex", alignItems: "center", gap: 6, height: "30px", background: isExpandedWidth ? "rgba(8,131,149,0.1)" : "white", color: isExpandedWidth ? "var(--brand-teal)" : "var(--text-secondary)", border: `1px solid ${isExpandedWidth ? "var(--brand-teal)" : "var(--surface-200)"}` }}
              >
                {isExpandedWidth ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/></svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
                )}
                {isExpandedWidth ? "Collapse" : "Expand"}
              </button>
            )}
            <button 
              className="btn btn-sm" 
              onClick={handleReextractClick}
              style={{ background: "var(--brand-teal)", color: "white", border: "1px solid var(--brand-teal)", display: "flex", alignItems: "center", gap: 6, height: "30px" }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8 M3 3v5h5 M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16 M16 16h5v5"/></svg>
              Re-Extract
            </button>
          </div>
        </div>
      </div>

      {/* Dynamic Style overrides for Full-Width Mode */}
      {(isExpandedWidth || isFocusMode) && (
        <style>{`
          .container-fluid {
            max-width: 100% !important;
            padding-left: 12px !important;
            padding-right: 12px !important;
          }
        `}</style>
      )}

      {/* No-Scheme Action Modal */}
      {noSchemeModal && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            background: 'var(--surface-0, white)', borderRadius: 14,
            padding: '28px 32px', width: 440, boxShadow: '0 24px 64px rgba(0,0,0,0.22)',
            display: 'flex', flexDirection: 'column', gap: 16,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              <span style={{ fontWeight: 700, fontSize: '1rem', color: 'var(--text-primary)' }}>No Medical Scheme Connected</span>
            </div>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>
              The document was verified successfully, but no medical scheme was detected on the PRF.
              Please select how you would like to proceed:
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {[
                { val: 'proceed',  label: '🏥  Proceed to Cases (await manual scheme assignment)' },
                { val: 'private',  label: '💵  Mark as Private / Cash (no scheme billing)' },
                { val: 'wca',      label: '⚖️  Mark as IOD / Third Party' },
                { val: 'reopen',   label: '📝  Go back and add scheme details' },
              ].map(opt => (
                <label key={opt.val} style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
                  borderRadius: 8, cursor: 'pointer',
                  border: `1.5px solid ${noSchemeAction === opt.val ? 'var(--brand-teal, #0883a0)' : 'var(--surface-200)'}`,
                  background: noSchemeAction === opt.val ? 'rgba(8,131,149,0.06)' : 'transparent',
                  transition: 'all 0.12s',
                }}>
                  <input autoComplete="off"
                    type="radio" name="noSchemeAction" value={opt.val}
                    checked={noSchemeAction === opt.val}
                    onChange={() => setNoSchemeAction(opt.val)}
                    style={{ accentColor: 'var(--brand-teal)' }}
                  />
                  <span style={{ fontSize: '0.85rem', color: 'var(--text-primary)' }}>{opt.label}</span>
                </label>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 4 }}>
              <button
                className="btn"
                style={{ background: 'var(--surface-100)', color: 'var(--text-secondary)', padding: '8px 18px' }}
                onClick={() => setNoSchemeModal(null)}
              >Cancel</button>
              <button
                className="btn btn-primary"
                style={{ padding: '8px 22px' }}
                onClick={async () => {
                  if (noSchemeAction === 'reopen') {
                    setNoSchemeModal(null);
                    return;
                  }
                  // Patch the scheme name on the case if needed
                  if (noSchemeAction !== 'proceed') {
                    const schemeLabel = noSchemeAction === 'private' ? 'Private' : 'IOD';
                    try {
                      await api.patch(`/api/cases/${noSchemeModal.caseId}`, { medical_scheme_name: schemeLabel });
                      handleFieldChange('medical_scheme', schemeLabel);
                    } catch { /* non-critical */ }
                  }
                  noSchemeModal.pendingNavigate();
                  setNoSchemeModal(null);
                }}
              >Confirm & Proceed</button>
            </div>
          </div>
        </div>
      )}

      {error && doc && (
        <div
          style={{
            padding: "12px 16px",
            borderRadius: 8,
            background: "rgba(239,68,68,0.08)",
            color: "var(--error-400)",
            marginBottom: 16,
            fontSize: "0.85rem",
          }}
        >
          {error}
        </div>
      )}

      {/* Split View */}
      <div
        style={{
          display: "flex",
          flex: 1,
          minHeight: 0,
        }}
      >
        {/* Left pane: Document Viewer */}
        <div
          className="card"
          style={{
            flex: 1,
            height: "100%",
            minWidth: "400px",
            minHeight: "400px",
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
            padding: 0,
            position: "relative",
          }}
        >
          <div
            style={{
              padding: "12px 16px",
              borderBottom: "1px solid var(--surface-200)",
              background: "var(--surface-50)",
              fontWeight: 600,
              fontSize: "0.9rem",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span>Original Document</span>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                {doc?.original_filename?.toLowerCase().endsWith(".pdf") ? "Use PDF controls to zoom and scroll" : "Scroll to zoom, drag to pan"}
              </span>
            </div>
          </div>
          {pdfUrl ? (
            (() => {
              const isPdf = doc?.original_filename?.toLowerCase().endsWith(".pdf") ?? true;
              
              if (isPdf) {
                return (
                  <iframe
                    src={pdfUrl}
                    style={{
                      width: "100%",
                      height: "100%",
                      flex: 1,
                      border: "none",
                      background: "#f1f5f9",
                    }}
                    title="Document Viewer"
                  />
                );
              }

              // Fallback for image documents using react-zoom-pan-pinch
              return (
                <TransformWrapper
                  initialScale={1}
                  minScale={0.2}
                  maxScale={8}
                  centerOnInit={true}
                  wheel={{ step: 0.15 }}
                  doubleClick={{ disabled: true }}
                >
                  {({ zoomIn, zoomOut, resetTransform }) => (
                    <div style={{ flex: 1, position: "relative", overflow: "hidden", display: "flex", flexDirection: "column" }}>
                      <div style={{ position: "absolute", bottom: 16, right: 16, zIndex: 10, display: "flex", gap: 6, background: "var(--surface-50)", padding: 4, borderRadius: 8, boxShadow: "0 4px 12px rgba(0,0,0,0.15)", border: "1px solid var(--surface-200)" }}>
                        <button className="btn btn-sm btn-secondary" title="Zoom In" onClick={() => zoomIn()} style={{ padding: "6px", width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", border: "none", background: "transparent" }}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                        </button>
                        <div style={{ width: 1, background: "var(--surface-200)", margin: "4px 2px" }} />
                        <button className="btn btn-sm btn-secondary" title="Zoom Out" onClick={() => zoomOut()} style={{ padding: "6px", width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", border: "none", background: "transparent" }}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2.5" strokeLinecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>
                        </button>
                        <div style={{ width: 1, background: "var(--surface-200)", margin: "4px 2px" }} />
                        <button className="btn btn-sm btn-secondary" title="Reset View" onClick={() => resetTransform()} style={{ padding: "6px", width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", border: "none", background: "transparent" }}>
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
                        </button>
                      </div>
                      <TransformComponent
                        wrapperStyle={{ width: "100%", height: "100%", flex: 1, cursor: "grab" }}
                        contentStyle={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}
                      >
                         <img 
                           src={pdfUrl.split('#')[0]} 
                           alt="Document Viewer" 
                           style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
                           draggable={false}
                         />
                      </TransformComponent>
                    </div>
                  )}
                </TransformWrapper>
              );
            })()
          ) : (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
                alignItems: "center",
                height: "100%",
                gap: 12,
                color: "var(--text-muted)",
              }}
            >
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.4 }}>
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
                <line x1="4" y1="4" x2="20" y2="20"/>
              </svg>
              <span style={{ fontSize: "0.85rem", opacity: 0.6 }}>Document preview unavailable</span>
              <span style={{ fontSize: "0.75rem", opacity: 0.4 }}>The extracted data on the right is still editable</span>
            </div>
          )}

        {/* Bundle Panel — pinned at the bottom of the left pane */}
        {groupedDocs.length > 1 && (
          <div style={{ padding: "10px 14px", background: "var(--surface-50)", borderTop: "1px solid var(--surface-200)", zIndex: 10 }}>
            <div style={{ fontSize: "0.75rem", fontWeight: 700, color: "var(--text-muted)", marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
              <span>📎</span> BUNDLED FILES ({groupedDocs.length})
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {groupedDocs.map((gd: any) => (
                <div
                  key={gd.id}
                  style={{
                    display: "flex", alignItems: "center", gap: 8, padding: "6px 10px",
                    borderRadius: 6, cursor: gd.id !== id ? "pointer" : "default",
                    background: gd.id === id ? "rgba(8,131,149,0.08)" : "transparent",
                    border: gd.id === id ? "1px solid rgba(8,131,149,0.25)" : "1px solid transparent",
                    transition: "all 0.15s ease"
                  }}
                  onClick={() => gd.id !== id && navigate(`/review/${gd.id}`)}
                  onMouseEnter={(e) => { if (gd.id !== id) (e.currentTarget as HTMLElement).style.background = "var(--surface-100)"; }}
                  onMouseLeave={(e) => { if (gd.id !== id) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                >
                  <span style={{ fontSize: "1rem" }}>{gd.is_group_primary ? "📄" : "🔗"}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: "0.8rem", fontWeight: gd.id === id ? 600 : 400, color: "var(--text-main)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {gd.original_filename}
                    </div>
                    <div style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>
                      {gd.is_group_primary ? "Primary PRF" : "Attached Tracker"} • {gd.ocr_status}
                    </div>
                  </div>
                  {gd.id === id && <span style={{ fontSize: "0.7rem", color: "var(--brand-teal)", fontWeight: 600 }}>Viewing</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        </div> {/* End of Left pane */}

        {/* Resizer Handle */}
        <div
          style={{
            width: 16,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "col-resize",
            flexShrink: 0,
          }}
          onMouseDown={(e) => {
            e.preventDefault();
            const startX = e.clientX;
            const startWidth = splitOffset;

            // Direct DOM reference to update width smoothly without React re-renders
            const rightPane = document.getElementById("dynamic-right-pane");
            
            // Temporarily disable iframe pointer events so they don't swallow mouse movements during drag
            const iframes = document.querySelectorAll("iframe");
            iframes.forEach(iframe => iframe.style.pointerEvents = "none");
            document.body.style.cursor = "col-resize";

            const onMouseMove = (moveEvt: MouseEvent) => {
              const deltaX = startX - moveEvt.clientX;
              const newOffset = Math.max(300, Math.min(startWidth + deltaX, window.innerWidth - 400));
              if (rightPane) {
                // Must apply directly to the style to bypass expensive render queue
                rightPane.style.flex = `0 0 ${newOffset}px`;
              }
            };

            const onMouseUp = (upEvt: MouseEvent) => {
              document.removeEventListener("mousemove", onMouseMove);
              document.removeEventListener("mouseup", onMouseUp);
              
              iframes.forEach(iframe => iframe.style.pointerEvents = "");
              document.body.style.cursor = "";

              const deltaX = startX - upEvt.clientX;
              const finalOffset = Math.max(300, Math.min(startWidth + deltaX, window.innerWidth - 400));
              setSplitOffset(finalOffset);
            };

            document.addEventListener("mousemove", onMouseMove);
            document.addEventListener("mouseup", onMouseUp);
          }}
        >
          <div style={{ width: 4, height: 32, background: "var(--surface-300)", borderRadius: 4, transition: "background 0.2s" }} />
        </div>

        {/* Re-Extract File Picker Modal */}
        {showReextractPicker && (
          <div style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center" }}
            onClick={() => setShowReextractPicker(false)}>
            <div style={{ background: "var(--surface-50)", borderRadius: 12, padding: 24, width: 420, boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}
              onClick={e => e.stopPropagation()}>
              <div style={{ fontWeight: 700, fontSize: "1rem", marginBottom: 6 }}>Re-Extract via AI</div>
              <div style={{ fontSize: "0.83rem", color: "var(--text-muted)", marginBottom: 16 }}>Choose which file to send for AI re-extraction:</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 20 }}>
                {groupedDocs.map((gd: any) => (
                  <button
                    key={gd.id}
                    onClick={() => handleReprocess(gd.id)}
                    style={{
                      display: "flex", alignItems: "center", gap: 10, padding: "10px 14px",
                      borderRadius: 8, border: "1px solid var(--surface-200)",
                      background: "var(--surface-100)", cursor: "pointer", textAlign: "left",
                      transition: "all 0.15s ease"
                    }}
                    onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = "rgba(8,131,149,0.08)"}
                    onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = "var(--surface-100)"}
                  >
                    <span style={{ fontSize: "1.2rem" }}>{gd.is_group_primary ? "📄" : "🔗"}</span>
                    <div>
                      <div style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--text-main)" }}>{gd.original_filename}</div>
                      <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>{gd.is_group_primary ? "Primary PRF" : "Attached Tracker"}</div>
                    </div>
                  </button>
                ))}
              </div>
              <button className="btn btn-secondary btn-sm" onClick={() => setShowReextractPicker(false)} style={{ width: "100%" }}>Cancel</button>
            </div>
          </div>
        )}

        {/* Right pane: Extracted Data Editor */}
        <div
          id="dynamic-right-pane"
          className="card"
          style={{
            flex: `0 0 ${splitOffset}px`,
            height: "100%",
            display: "flex",
            flexDirection: "column",
            padding: 0,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: "8px 16px",
              borderBottom: "1px solid var(--surface-200)",
              background: "var(--surface-50)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span style={{ fontWeight: 600, fontSize: "0.9rem" }}>
              Extracted Data
            </span>
            <div
              style={{
                display: "flex",
                background: "var(--surface-200)",
                padding: 3,
                borderRadius: "var(--radius-sm)",
              }}
            >
              <button
                onClick={() => setViewMode("form")}
                style={{
                  padding: "4px 12px",
                  fontSize: "0.8rem",
                  fontWeight: 600,
                  background: viewMode === "form" ? "white" : "transparent",
                  color:
                    viewMode === "form"
                      ? "var(--primary)"
                      : "var(--text-muted)",
                  border: "none",
                  borderRadius: "var(--radius-sm)",
                  cursor: "pointer",
                  boxShadow:
                    viewMode === "form" ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
                  transition: "all 0.1s",
                }}
              >
                Form
              </button>
              <button
                onClick={() => setViewMode("json")}
                style={{
                  padding: "4px 12px",
                  fontSize: "0.8rem",
                  fontWeight: 600,
                  background: viewMode === "json" ? "white" : "transparent",
                  color:
                    viewMode === "json"
                      ? "var(--primary)"
                      : "var(--text-muted)",
                  border: "none",
                  borderRadius: "var(--radius-sm)",
                  cursor: "pointer",
                  boxShadow:
                    viewMode === "json" ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
                  transition: "all 0.1s",
                }}
              >
                JSON
              </button>
            </div>
          </div>


          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            {viewMode === "form" ? (
              renderFormView()
            ) : (
              <div
                style={{
                  padding: 16,
                  display: "flex",
                  flex: 1,
                  flexDirection: "column",
                }}
              >
                <textarea
                  value={editedData}
                  onChange={(e) => setEditedData(e.target.value)}
                  style={{
                    flex: 1,
                    width: "100%",
                    fontFamily: "monospace",
                    fontSize: "0.85rem",
                    lineHeight: 1.5,
                    padding: 12,
                    borderRadius: "var(--radius-md)",
                    border: "1px solid var(--surface-300)",
                    background: "var(--surface-100)",
                    color: "var(--text-primary)",
                    resize: "none",
                  }}
                  spellCheck={false}
                />
              </div>
            )}
          </div>
          <div
            style={{
              padding: "16px",
              borderTop: "1px solid var(--surface-200)",
              background: "var(--surface-50)",
              display: "flex",
              gap: 12,
              justifyContent: "flex-end",
            }}
          >
            <button
              className="btn btn-secondary"
              onClick={() => handleSave(false)}
              disabled={saving}
            >
              Save Draft
            </button>
            <button
              className="btn btn-primary"
              onClick={() => handleSave(true)}
              disabled={saving}
            >
              {saving ? "Confirming..." : "Confirm Data"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
