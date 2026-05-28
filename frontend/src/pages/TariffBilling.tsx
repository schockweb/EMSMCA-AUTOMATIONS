/**
 * TariffBilling — Standalone admin page for managing per-scheme tariff codes.
 *
 * Two-panel layout:
 *   Left:  Scheme list (from rate_schemas) with search + active filter
 *   Right: Scheme detail with tariff line CRUD table
 *
 * Each scheme can have many tariff lines (base rates, mileage, procedures).
 * The billing engine reads these lines at runtime for non-GEMS/Discovery schemes.
 */
import { useState, useEffect, useCallback } from 'react';
import api from '../api/client';

/* ── Types ───────────────────────────────────────────────────── */

interface RateSchema {
  id: number;
  schema_code: string;
  scheme_name: string;
  effective_from: string;
  effective_to: string | null;
  rate_per_km: number;
  base_fee: number;
  active: boolean;
  notes: string | null;
}

interface TariffLine {
  id: number;
  rate_schema_id: number;
  tariff_code: string;
  description: string;
  category: string;
  level_of_care: string | null;
  loaded: boolean | null;
  primary_rate: number;
  iht_rate: number;
  unit: string;
  keywords: string | null;
  is_active: boolean;
  notes: string | null;
  created_at: string | null;
  updated_at: string | null;
}

const EMPTY_LINE = {
  tariff_code: '',
  description: '',
  category: 'base_rate',
  level_of_care: '',
  loaded: '',
  primary_rate: '0.00',
  iht_rate: '0.00',
  unit: 'per call',
  keywords: '',
  is_active: true,
  notes: '',
};

/* ── Constants ───────────────────────────────────────────────── */
const CATEGORIES = [
  { value: 'base_rate', label: 'Base Rate', color: '#088395' },
  { value: 'mileage', label: 'Mileage', color: '#1565C0' },
  { value: 'procedure', label: 'Procedure', color: '#E65100' },
  { value: 'medication', label: 'Medication', color: '#2E7D32' },
  { value: 'consumable', label: 'Consumable', color: '#6A1B9A' },
  { value: 'equipment', label: 'Equipment', color: '#4E342E' },
  { value: 'admin', label: 'Admin', color: '#546E7A' },
  { value: 'other', label: 'Other', color: '#78909C' },
];

const LEVELS = ['BLS', 'ILS', 'ALS'];
const UNITS = ['per call', 'per km', 'per 15 min', 'per item', 'per minute'];

const teal = '#088395';
const rose = '#C2185B';
const amber = '#E65100';

function getCategoryMeta(cat: string) {
  return CATEGORIES.find(c => c.value === cat) || CATEGORIES[CATEGORIES.length - 1];
}

/* ── Component ───────────────────────────────────────────────── */

export default function TariffBilling() {
  // ── State: Scheme list
  const [schemas, setSchemas] = useState<RateSchema[]>([]);
  const [schemasLoading, setSchemasLoading] = useState(true);
  const [schemaSearch, setSchemaSearch] = useState('');
  const [filterActive, setFilterActive] = useState(false);

  // ── State: Selected scheme + tariff lines
  const [selectedSchema, setSelectedSchema] = useState<RateSchema | null>(null);
  const [lines, setLines] = useState<TariffLine[]>([]);
  const [linesLoading, setLinesLoading] = useState(false);

  // ── State: Line form
  const [showLineForm, setShowLineForm] = useState(false);
  const [editingLine, setEditingLine] = useState<TariffLine | null>(null);
  const [lineForm, setLineForm] = useState(EMPTY_LINE);
  const [saving, setSaving] = useState(false);

  // ── State: Duplicate modal
  const [showDuplicate, setShowDuplicate] = useState(false);
  const [duplicateTargetId, setDuplicateTargetId] = useState('');
  const [duplicating, setDuplicating] = useState(false);

  /* ── Fetchers ────────────────────────────────────────────────── */

  const fetchSchemas = useCallback(async () => {
    setSchemasLoading(true);
    try {
      const params = filterActive ? { active_only: 'true' } : {};
      const res = await api.get('/api/rate-schemas', { params });
      setSchemas(res.data);
    } catch { /* ignore */ }
    setSchemasLoading(false);
  }, [filterActive]);

  const fetchLines = useCallback(async (schemaId: number) => {
    setLinesLoading(true);
    try {
      const res = await api.get(`/api/tariff-lines/by-schema/${schemaId}`);
      setLines(res.data);
    } catch { setLines([]); }
    setLinesLoading(false);
  }, []);

  useEffect(() => { fetchSchemas(); }, [fetchSchemas]);

  useEffect(() => {
    if (selectedSchema) {
      fetchLines(selectedSchema.id);
    } else {
      setLines([]);
    }
  }, [selectedSchema, fetchLines]);

  /* ── Handlers: Scheme selection ──────────────────────────────── */

  const selectSchema = (s: RateSchema) => {
    setSelectedSchema(s);
    setShowLineForm(false);
    setEditingLine(null);
  };

  /* ── Handlers: Line CRUD ─────────────────────────────────────── */

  const openAddLine = () => {
    setEditingLine(null);
    setLineForm(EMPTY_LINE);
    setShowLineForm(true);
  };

  const openEditLine = (ln: TariffLine) => {
    setEditingLine(ln);
    setLineForm({
      tariff_code: ln.tariff_code,
      description: ln.description,
      category: ln.category,
      level_of_care: ln.level_of_care || '',
      loaded: ln.loaded === null ? '' : ln.loaded ? 'true' : 'false',
      primary_rate: String(ln.primary_rate),
      iht_rate: String(ln.iht_rate),
      unit: ln.unit,
      keywords: ln.keywords || '',
      is_active: ln.is_active,
      notes: ln.notes || '',
    });
    setShowLineForm(true);
  };

  const handleSaveLine = async () => {
    if (!selectedSchema) return;
    setSaving(true);
    try {
      const payload: any = {
        tariff_code: lineForm.tariff_code.trim(),
        description: lineForm.description.trim(),
        category: lineForm.category,
        level_of_care: lineForm.level_of_care || null,
        loaded: lineForm.loaded === '' ? null : lineForm.loaded === 'true',
        primary_rate: parseFloat(lineForm.primary_rate) || 0,
        iht_rate: parseFloat(lineForm.iht_rate) || 0,
        unit: lineForm.unit,
        keywords: lineForm.keywords.trim() || null,
        is_active: lineForm.is_active,
        notes: lineForm.notes.trim() || null,
      };

      if (editingLine) {
        await api.put(`/api/tariff-lines/${editingLine.id}`, payload);
      } else {
        payload.rate_schema_id = selectedSchema.id;
        await api.post('/api/tariff-lines', payload);
      }
      setShowLineForm(false);
      setEditingLine(null);
      setLineForm(EMPTY_LINE);
      fetchLines(selectedSchema.id);
    } catch (e: any) {
      alert(e.response?.data?.detail || 'Failed to save tariff line');
    }
    setSaving(false);
  };

  const handleDeleteLine = async (ln: TariffLine) => {
    if (!window.confirm(`Delete tariff code "${ln.tariff_code}" — ${ln.description}?`)) return;
    try {
      await api.delete(`/api/tariff-lines/${ln.id}`);
      if (selectedSchema) fetchLines(selectedSchema.id);
    } catch (e: any) {
      alert(e.response?.data?.detail || 'Failed to delete');
    }
  };

  const handleToggleActive = async (ln: TariffLine) => {
    try {
      await api.put(`/api/tariff-lines/${ln.id}`, { is_active: !ln.is_active });
      if (selectedSchema) fetchLines(selectedSchema.id);
    } catch { /* ignore */ }
  };

  /* ── Handler: Duplicate lines ────────────────────────────────── */

  const handleDuplicate = async () => {
    if (!selectedSchema || !duplicateTargetId) return;
    setDuplicating(true);
    try {
      const res = await api.post(
        `/api/tariff-lines/duplicate/${selectedSchema.id}/${duplicateTargetId}`
      );
      alert(`${res.data.created} tariff lines copied (${res.data.skipped} skipped).`);
      setShowDuplicate(false);
      setDuplicateTargetId('');
    } catch (e: any) {
      alert(e.response?.data?.detail || 'Failed to duplicate');
    }
    setDuplicating(false);
  };

  const lf = (key: string, val: any) => setLineForm(prev => ({ ...prev, [key]: val }));

  /* ── Filtered schema list ────────────────────────────────────── */

  const filteredSchemas = schemas.filter(s => {
    if (!schemaSearch) return true;
    const q = schemaSearch.toLowerCase();
    return s.scheme_name.toLowerCase().includes(q) || s.schema_code.toLowerCase().includes(q);
  });

  const isSchemaActive = (s: RateSchema) =>
    s.active !== false && (!s.effective_to || new Date(s.effective_to) >= new Date());

  /* ── Line stats ──────────────────────────────────────────────── */
  const activeLines = lines.filter(l => l.is_active);
  const baseRateCount = activeLines.filter(l => l.category === 'base_rate').length;
  const mileageCount = activeLines.filter(l => l.category === 'mileage').length;
  const otherCount = activeLines.length - baseRateCount - mileageCount;

  /* ── Styles ──────────────────────────────────────────────────── */

  const panelLeft: React.CSSProperties = {
    width: 340,
    minWidth: 300,
    borderRight: '1px solid var(--surface-200)',
    display: 'flex',
    flexDirection: 'column',
    height: 'calc(100vh - 100px)',
    overflow: 'hidden',
  };

  const panelRight: React.CSSProperties = {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    height: 'calc(100vh - 100px)',
    overflow: 'hidden',
  };

  const schemaCard = (isSelected: boolean): React.CSSProperties => ({
    padding: '14px 16px',
    borderRadius: 10,
    cursor: 'pointer',
    border: isSelected ? `2px solid ${teal}` : '1px solid var(--surface-100)',
    background: isSelected ? 'rgba(8,131,149,0.06)' : 'var(--surface-50)',
    marginBottom: 8,
    transition: 'all 0.15s ease',
  });

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

  const btnSecondary: React.CSSProperties = {
    background: 'var(--surface-200)',
    color: 'var(--text-primary)',
    border: 'none',
    borderRadius: 8,
    padding: '8px 16px',
    fontSize: '0.82rem',
    fontWeight: 600,
    cursor: 'pointer',
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    fontSize: '0.84rem',
    padding: '8px 12px',
    borderRadius: 8,
    border: '1px solid var(--surface-200)',
    background: 'var(--surface-0)',
    color: 'var(--text-primary)',
    marginBottom: 8,
    boxSizing: 'border-box',
  };

  const labelStyle: React.CSSProperties = {
    fontSize: '0.68rem',
    fontWeight: 700,
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    marginBottom: 3,
    display: 'block',
  };

  const thStyle: React.CSSProperties = {
    padding: '10px 12px',
    fontWeight: 700,
    fontSize: '0.68rem',
    textTransform: 'uppercase',
    color: 'var(--text-muted)',
    whiteSpace: 'nowrap',
    textAlign: 'left',
  };

  const tdStyle: React.CSSProperties = {
    padding: '10px 12px',
    fontSize: '0.82rem',
    borderBottom: '1px solid var(--surface-100)',
  };

  const categoryBadge = (cat: string): React.CSSProperties => {
    const meta = getCategoryMeta(cat);
    return {
      padding: '2px 8px',
      borderRadius: 99,
      fontSize: '0.65rem',
      fontWeight: 700,
      textTransform: 'uppercase',
      background: `${meta.color}14`,
      color: meta.color,
      letterSpacing: '0.04em',
    };
  };

  /* ── Render ──────────────────────────────────────────────────── */

  return (
    <div style={{ maxWidth: 1400, margin: '0 auto' }}>
      {/* Page Header */}
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 800, margin: 0, color: 'var(--text-primary)' }}>
          🏥 Tariff Billing
        </h1>
        <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', margin: '4px 0 0' }}>
          Manage tariff mapping codes for each medical scheme — base rates, mileage, procedures
        </p>
      </div>

      {/* Two-Panel Layout */}
      <div style={{ display: 'flex', gap: 0, background: 'var(--surface-50)', borderRadius: 16, border: '1px solid var(--surface-100)', overflow: 'hidden' }}>

        {/* ── LEFT PANEL: Scheme List ──────────────────────────── */}
        <div style={panelLeft}>
          {/* Scheme Search */}
          <div style={{ padding: '16px 16px 8px' }}>
            <input
              type="text"
              placeholder="Search schemes..."
              value={schemaSearch}
              onChange={e => setSchemaSearch(e.target.value)}
              style={{ ...inputStyle, marginBottom: 8 }}
            />
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <button
                onClick={() => setFilterActive(!filterActive)}
                style={{
                  padding: '5px 10px', borderRadius: 6, fontSize: '0.72rem', fontWeight: 700,
                  cursor: 'pointer', border: `1px solid ${filterActive ? teal : 'var(--surface-200)'}`,
                  background: filterActive ? 'rgba(8,131,149,0.08)' : 'transparent',
                  color: filterActive ? teal : 'var(--text-muted)',
                }}
              >
                {filterActive ? '● Active' : '○ All'}
              </button>
              <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginLeft: 'auto' }}>
                {filteredSchemas.length} scheme{filteredSchemas.length !== 1 ? 's' : ''}
              </span>
            </div>
          </div>

          {/* Scheme List */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px 16px 16px' }}>
            {schemasLoading ? (
              <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)', fontSize: '0.82rem' }}>
                Loading schemes...
              </div>
            ) : filteredSchemas.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 30, color: 'var(--text-muted)', fontSize: '0.82rem' }}>
                No schemes found. Add one via Rate Schemas page.
              </div>
            ) : (
              filteredSchemas.map(s => {
                const active = isSchemaActive(s);
                const sel = selectedSchema?.id === s.id;
                return (
                  <div
                    key={s.id}
                    style={schemaCard(sel)}
                    onClick={() => selectSchema(s)}
                    onMouseEnter={e => {
                      if (!sel) (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--surface-300)';
                    }}
                    onMouseLeave={e => {
                      if (!sel) (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--surface-100)';
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <span style={{
                        width: 8, height: 8, borderRadius: '50%',
                        background: active ? '#10b981' : '#94a3b8',
                        flexShrink: 0,
                      }} />
                      <span style={{ fontWeight: 700, fontSize: '0.88rem', color: 'var(--text-primary)' }}>
                        {s.scheme_name}
                      </span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontFamily: 'monospace', fontSize: '0.72rem', color: teal, fontWeight: 600 }}>
                        {s.schema_code}
                      </span>
                      <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                        {s.effective_from}
                      </span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* ── RIGHT PANEL: Tariff Lines ───────────────────────── */}
        <div style={panelRight}>
          {!selectedSchema ? (
            /* Empty state */
            <div style={{
              flex: 1, display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center',
              color: 'var(--text-muted)', padding: 40,
            }}>
              <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 16, opacity: 0.4 }}>
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
                <polyline points="10 9 9 9 8 9" />
              </svg>
              <p style={{ fontSize: '1rem', fontWeight: 600, marginBottom: 6 }}>Select a Scheme</p>
              <p style={{ fontSize: '0.82rem' }}>Choose a medical scheme from the left to manage its tariff codes</p>
            </div>
          ) : (
            <>
              {/* Scheme Header */}
              <div style={{
                padding: '16px 24px',
                borderBottom: '1px solid var(--surface-100)',
                background: 'linear-gradient(135deg, rgba(8,131,149,0.03), rgba(8,131,149,0.01))',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <h2 style={{ fontSize: '1.15rem', fontWeight: 800, margin: 0, color: 'var(--text-primary)' }}>
                      {selectedSchema.scheme_name}
                    </h2>
                    <div style={{ display: 'flex', gap: 12, marginTop: 6, alignItems: 'center' }}>
                      <span style={{ fontFamily: 'monospace', fontSize: '0.78rem', color: teal, fontWeight: 600, background: 'rgba(8,131,149,0.08)', padding: '2px 8px', borderRadius: 6 }}>
                        {selectedSchema.schema_code}
                      </span>
                      <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                        From {selectedSchema.effective_from}{selectedSchema.effective_to ? ` to ${selectedSchema.effective_to}` : ' (active)'}
                      </span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button style={btnSecondary} onClick={() => setShowDuplicate(true)} title="Copy lines to another scheme">
                      📋 Duplicate
                    </button>
                    <button style={btnPrimary} onClick={openAddLine}>
                      + Add Tariff Code
                    </button>
                  </div>
                </div>

                {/* Stats Bar */}
                <div style={{ display: 'flex', gap: 16, marginTop: 12 }}>
                  {[
                    { label: 'Total', val: activeLines.length, color: teal },
                    { label: 'Base Rates', val: baseRateCount, color: '#088395' },
                    { label: 'Mileage', val: mileageCount, color: '#1565C0' },
                    { label: 'Other', val: otherCount, color: '#78909C' },
                  ].map(st => (
                    <div key={st.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: '1.1rem', fontWeight: 800, color: st.color }}>{st.val}</span>
                      <span style={{ fontSize: '0.68rem', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                        {st.label}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Tariff Lines Table */}
              <div style={{ flex: 1, overflowY: 'auto', padding: '0' }}>
                {linesLoading ? (
                  <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)', fontSize: '0.82rem' }}>
                    Loading tariff lines...
                  </div>
                ) : lines.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-muted)' }}>
                    <p style={{ fontSize: '1rem', fontWeight: 600, marginBottom: 8 }}>No tariff codes configured</p>
                    <p style={{ fontSize: '0.82rem', marginBottom: 16 }}>
                      Add base rates, mileage codes, and procedures for this scheme.
                    </p>
                    <button style={btnPrimary} onClick={openAddLine}>+ Add First Tariff Code</button>
                  </div>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
                    <thead>
                      <tr style={{ background: 'var(--surface-100)' }}>
                        <th style={thStyle}>Code</th>
                        <th style={thStyle}>Description</th>
                        <th style={thStyle}>Category</th>
                        <th style={thStyle}>Level</th>
                        <th style={{ ...thStyle, textAlign: 'right' }}>Primary (R)</th>
                        <th style={{ ...thStyle, textAlign: 'right' }}>IHT (R)</th>
                        <th style={thStyle}>Unit</th>
                        <th style={thStyle}>Status</th>
                        <th style={{ ...thStyle, textAlign: 'right' }}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map(ln => (
                        <tr
                          key={ln.id}
                          style={{
                            opacity: ln.is_active ? 1 : 0.5,
                            transition: 'opacity 0.15s',
                          }}
                        >
                          <td style={{ ...tdStyle, fontFamily: 'monospace', fontWeight: 700, fontSize: '0.8rem', color: teal }}>
                            {ln.tariff_code}
                          </td>
                          <td style={{ ...tdStyle, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {ln.description}
                          </td>
                          <td style={tdStyle}>
                            <span style={categoryBadge(ln.category)}>
                              {getCategoryMeta(ln.category).label}
                            </span>
                          </td>
                          <td style={{ ...tdStyle, fontWeight: 600, fontSize: '0.78rem' }}>
                            {ln.level_of_care || '—'}
                          </td>
                          <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'monospace', fontWeight: 700, color: teal }}>
                            R{ln.primary_rate.toFixed(2)}
                          </td>
                          <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'monospace', fontWeight: 600, color: amber }}>
                            R{ln.iht_rate.toFixed(2)}
                          </td>
                          <td style={{ ...tdStyle, fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                            {ln.unit}
                          </td>
                          <td style={tdStyle}>
                            <button
                              onClick={() => handleToggleActive(ln)}
                              style={{
                                background: 'none', border: 'none', cursor: 'pointer',
                                padding: '2px 8px', borderRadius: 99,
                                fontSize: '0.65rem', fontWeight: 700,
                                color: ln.is_active ? '#10b981' : '#94a3b8',
                                backgroundColor: ln.is_active ? 'rgba(16,185,129,0.1)' : 'rgba(148,163,184,0.1)',
                              }}
                            >
                              {ln.is_active ? 'ACTIVE' : 'DISABLED'}
                            </button>
                          </td>
                          <td style={{ ...tdStyle, textAlign: 'right', whiteSpace: 'nowrap' }}>
                            <button
                              onClick={() => openEditLine(ln)}
                              style={{ background: 'none', border: 'none', cursor: 'pointer', color: teal, fontSize: '0.75rem', fontWeight: 700, marginRight: 8 }}
                            >✏️ Edit</button>
                            <button
                              onClick={() => handleDeleteLine(ln)}
                              style={{ background: 'none', border: 'none', cursor: 'pointer', color: rose, fontSize: '0.75rem', fontWeight: 700 }}
                            >🗑️</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              {/* Info Footer */}
              <div style={{
                padding: '12px 24px',
                borderTop: '1px solid var(--surface-100)',
                background: 'rgba(8,131,149,0.02)',
                fontSize: '0.72rem',
                color: 'var(--text-muted)',
              }}>
                <strong style={{ color: teal }}>💡 TIP:</strong>{' '}
                Descriptions are load-bearing — the billing engine matches rows by keyword phrases like
                "up to 45", "every 15", "with patient", "loaded". Include the <code>[LEVEL]</code> bracket tag
                (e.g. <code>[BLS]</code>) in descriptions for level filtering.
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Add/Edit Line Modal ──────────────────────────────────── */}
      {showLineForm && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 200,
            background: 'rgba(15,23,42,0.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 16,
          }}
          onClick={() => setShowLineForm(false)}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: 'var(--surface-0)', borderRadius: 16, padding: 24,
              width: '100%', maxWidth: 680, maxHeight: '90vh', overflowY: 'auto',
              boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
            }}
          >
            <h2 style={{ fontSize: '1.1rem', fontWeight: 800, color: teal, marginBottom: 16, marginTop: 0 }}>
              {editingLine ? `Edit: ${editingLine.tariff_code}` : 'New Tariff Code'}
            </h2>

            {/* Row 1: Code + Category */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label style={labelStyle}>Tariff Code *</label>
                <input style={inputStyle} placeholder="e.g. 100, 9111, 131"
                  value={lineForm.tariff_code} onChange={e => lf('tariff_code', e.target.value)} />
              </div>
              <div>
                <label style={labelStyle}>Category *</label>
                <select style={inputStyle} value={lineForm.category}
                  onChange={e => lf('category', e.target.value)}>
                  {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
              </div>
            </div>

            {/* Row 2: Description */}
            <div>
              <label style={labelStyle}>Description * <span style={{ fontWeight: 400, fontSize: '0.62rem' }}>(include [LEVEL] tag + keywords)</span></label>
              <input style={inputStyle} placeholder="e.g. BLS Base Rate [BLS] Up to 45 min"
                value={lineForm.description} onChange={e => lf('description', e.target.value)} />
            </div>

            {/* Row 3: Level + Loaded + Unit */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
              <div>
                <label style={labelStyle}>Level of Care</label>
                <select style={inputStyle} value={lineForm.level_of_care}
                  onChange={e => lf('level_of_care', e.target.value)}>
                  <option value="">All Levels</option>
                  {LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
                </select>
              </div>
              <div>
                <label style={labelStyle}>Loaded (With Patient?)</label>
                <select style={inputStyle} value={lineForm.loaded}
                  onChange={e => lf('loaded', e.target.value)}>
                  <option value="">N/A</option>
                  <option value="true">Yes — With Patient</option>
                  <option value="false">No — Callout / RTB</option>
                </select>
              </div>
              <div>
                <label style={labelStyle}>Unit</label>
                <select style={inputStyle} value={lineForm.unit}
                  onChange={e => lf('unit', e.target.value)}>
                  {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                </select>
              </div>
            </div>

            {/* Row 4: Rates */}
            <div style={{
              marginTop: 4, marginBottom: 4, fontSize: '0.72rem', fontWeight: 700,
              color: amber, textTransform: 'uppercase', letterSpacing: '0.06em',
            }}>
              Billing Rates
            </div>
            <div style={{
              display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12,
              background: 'var(--surface-50, #f8f9fc)', borderRadius: 10, padding: 14,
              border: '1px solid var(--surface-100, #f1f3f8)',
            }}>
              <div>
                <label style={labelStyle}>Primary Rate (R) *</label>
                <input type="number" step="0.01" style={inputStyle} placeholder="0.00"
                  value={lineForm.primary_rate} onChange={e => lf('primary_rate', e.target.value)} />
              </div>
              <div>
                <label style={labelStyle}>IHT Rate (R) *</label>
                <input type="number" step="0.01" style={inputStyle} placeholder="0.00"
                  value={lineForm.iht_rate} onChange={e => lf('iht_rate', e.target.value)} />
              </div>
            </div>

            {/* Row 5: Keywords */}
            <div style={{ marginTop: 8 }}>
              <label style={labelStyle}>Keywords <span style={{ fontWeight: 400, fontSize: '0.62rem' }}>(comma-separated, for engine matching)</span></label>
              <input style={inputStyle} placeholder="e.g. up to 45, base rate"
                value={lineForm.keywords} onChange={e => lf('keywords', e.target.value)} />
            </div>

            {/* Row 6: Notes + Active */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 12, marginTop: 4 }}>
              <div>
                <label style={labelStyle}>Notes</label>
                <input style={inputStyle} placeholder="Optional notes..."
                  value={lineForm.notes} onChange={e => lf('notes', e.target.value)} />
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 10 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: '0.78rem', fontWeight: 600 }}>
                  <input
                    type="checkbox" checked={lineForm.is_active}
                    onChange={e => lf('is_active', e.target.checked)}
                    style={{ accentColor: teal }}
                  />
                  Active
                </label>
              </div>
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button style={btnPrimary} onClick={handleSaveLine} disabled={saving}>
                {saving ? 'Saving...' : editingLine ? 'Update Code' : 'Add Code'}
              </button>
              <button style={btnSecondary} onClick={() => { setShowLineForm(false); setEditingLine(null); }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Duplicate Modal ──────────────────────────────────────── */}
      {showDuplicate && selectedSchema && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 200,
            background: 'rgba(15,23,42,0.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 16,
          }}
          onClick={() => setShowDuplicate(false)}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: 'var(--surface-0)', borderRadius: 16, padding: 24,
              width: '100%', maxWidth: 440,
              boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
            }}
          >
            <h2 style={{ fontSize: '1rem', fontWeight: 800, color: teal, marginTop: 0, marginBottom: 12 }}>
              📋 Duplicate Tariff Lines
            </h2>
            <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginBottom: 12 }}>
              Copy all tariff lines from <strong>{selectedSchema.scheme_name}</strong> to another scheme.
              Existing codes in the target will be skipped.
            </p>
            <label style={labelStyle}>Target Scheme</label>
            <select
              style={inputStyle}
              value={duplicateTargetId}
              onChange={e => setDuplicateTargetId(e.target.value)}
            >
              <option value="">Select target scheme...</option>
              {schemas.filter(s => s.id !== selectedSchema.id).map(s => (
                <option key={s.id} value={s.id}>{s.scheme_name} ({s.schema_code})</option>
              ))}
            </select>
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button style={btnPrimary} onClick={handleDuplicate} disabled={duplicating || !duplicateTargetId}>
                {duplicating ? 'Copying...' : 'Copy Lines'}
              </button>
              <button style={btnSecondary} onClick={() => setShowDuplicate(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
