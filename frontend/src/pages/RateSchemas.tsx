/**
 * RateSchemas — Admin page to manage billing rate schemas per medical scheme.
 * Each schema defines the rate-per-KM, base fees, rounding rules, and
 * multipliers that the tariff engine uses to convert KM into rand amounts.
 * Supports effective date ranges so historical PRFs can always be re-billed
 * at the rate that was active at the time of the call.
 */
import { useState, useEffect, useCallback } from 'react';
import api from '../api/client';

interface RateSchema {
  id: number;
  schema_code: string;
  scheme_name: string;
  effective_from: string;
  effective_to: string | null;
  rate_per_km: number;
  base_fee: number;
  minimum_km: number;
  rounding_rule: string;
  after_hours_multiplier: number;
  weekend_multiplier: number;
  notes: string | null;
  created_at: string;
  updated_at: string | null;
}

const EMPTY_FORM = {
  schema_code: '',
  scheme_name: '',
  effective_from: new Date().toISOString().slice(0, 10),
  effective_to: '',
  rate_per_km: '',
  base_fee: '0',
  minimum_km: '0',
  rounding_rule: 'nearest',
  after_hours_multiplier: '1.00',
  weekend_multiplier: '1.00',
  notes: '',
};

const teal = '#088395';
const rose = '#C2185B';
const amber = '#E65100';

export default function RateSchemas() {
  const [schemas, setSchemas] = useState<RateSchema[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<RateSchema | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [filterActive, setFilterActive] = useState(false);

  const fetchSchemas = useCallback(async () => {
    setLoading(true);
    try {
      const params = filterActive ? { active_only: 'true' } : {};
      const res = await api.get('/api/rate-schemas', { params });
      setSchemas(res.data);
    } catch { /* ignore */ }
    setLoading(false);
  }, [filterActive]);

  useEffect(() => { fetchSchemas(); }, [fetchSchemas]);

  const openAdd = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setShowForm(true);
  };

  const openEdit = (s: RateSchema) => {
    setEditing(s);
    setForm({
      schema_code: s.schema_code,
      scheme_name: s.scheme_name,
      effective_from: s.effective_from,
      effective_to: s.effective_to || '',
      rate_per_km: String(s.rate_per_km),
      base_fee: String(s.base_fee),
      minimum_km: String(s.minimum_km),
      rounding_rule: s.rounding_rule,
      after_hours_multiplier: String(s.after_hours_multiplier),
      weekend_multiplier: String(s.weekend_multiplier),
      notes: s.notes || '',
    });
    setShowForm(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = {
        schema_code: form.schema_code.trim(),
        scheme_name: form.scheme_name.trim(),
        effective_from: form.effective_from,
        effective_to: form.effective_to || null,
        rate_per_km: parseFloat(form.rate_per_km) || 0,
        base_fee: parseFloat(form.base_fee) || 0,
        minimum_km: parseFloat(form.minimum_km) || 0,
        rounding_rule: form.rounding_rule,
        after_hours_multiplier: parseFloat(form.after_hours_multiplier) || 1,
        weekend_multiplier: parseFloat(form.weekend_multiplier) || 1,
        notes: form.notes.trim() || null,
      };
      if (editing) {
        await api.put(`/api/rate-schemas/${editing.id}`, payload);
      } else {
        await api.post('/api/rate-schemas', payload);
      }
      setShowForm(false);
      setEditing(null);
      setForm(EMPTY_FORM);
      fetchSchemas();
    } catch (e: any) {
      alert(e.response?.data?.detail || 'Failed to save rate schema');
    }
    setSaving(false);
  };

  const handleDelete = async (id: number, code: string) => {
    if (!window.confirm(`Delete rate schema "${code}"? This cannot be undone.`)) return;
    try {
      await api.delete(`/api/rate-schemas/${id}`);
      fetchSchemas();
    } catch (e: any) {
      alert(e.response?.data?.detail || 'Failed to delete');
    }
  };

  const sf = (key: string, val: string) => setForm(prev => ({ ...prev, [key]: val }));
  const isActive = (s: RateSchema) => !s.effective_to || new Date(s.effective_to) >= new Date();

  const filtered = schemas.filter(s => {
    if (!search) return true;
    const q = search.toLowerCase();
    return s.scheme_name.toLowerCase().includes(q) || s.schema_code.toLowerCase().includes(q);
  });

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
    border: '1px solid var(--surface-200)',
    background: 'var(--bg)',
    color: 'var(--text)',
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
    padding: '10px 14px',
    fontWeight: 700,
    fontSize: '0.7rem',
    textTransform: 'uppercase',
    color: 'var(--text-muted)',
    whiteSpace: 'nowrap',
  };

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 800, margin: 0, color: 'var(--text)' }}>
            💰 Billing Rate Schemas
          </h1>
          <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', margin: '4px 0 0' }}>
            Define rate-per-KM, base fees, and rounding rules for each medical scheme
          </p>
        </div>
        <button style={btnPrimary} onClick={openAdd}>+ Add Rate Schema</button>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center' }}>
        <input
          type="text"
          placeholder="Search by scheme name or code..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ ...inputStyle, marginBottom: 0, maxWidth: 320 }}
        />
        <button
          onClick={() => setFilterActive(!filterActive)}
          style={{
            padding: '8px 14px', borderRadius: 8, fontSize: '0.78rem', fontWeight: 700,
            cursor: 'pointer', letterSpacing: '0.03em',
            border: `1px solid ${filterActive ? teal : 'var(--surface-200)'}`,
            background: filterActive ? `rgba(8,131,149,0.08)` : 'var(--bg)',
            color: filterActive ? teal : 'var(--text-muted)',
          }}
        >
          {filterActive ? '● Active Only' : '○ Show All'}
        </button>
        <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginLeft: 'auto' }}>
          {filtered.length} schema{filtered.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Add/Edit Form Modal */}
      {showForm && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 200,
          background: 'rgba(15,23,42,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 16,
        }} onClick={() => setShowForm(false)}>
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: 'var(--bg)', borderRadius: 16, padding: 24,
              width: '100%', maxWidth: 640, maxHeight: '90vh', overflowY: 'auto',
              boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
            }}
          >
            <h2 style={{ fontSize: '1.1rem', fontWeight: 800, color: teal, marginBottom: 16, marginTop: 0 }}>
              {editing ? `Edit: ${editing.scheme_name}` : 'New Rate Schema'}
            </h2>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label style={labelStyle}>Schema Code *</label>
                <input style={inputStyle} placeholder="e.g. DISCOVERY-2026" value={form.schema_code}
                  onChange={e => sf('schema_code', e.target.value)} disabled={!!editing} />
              </div>
              <div>
                <label style={labelStyle}>Scheme Name *</label>
                <input style={inputStyle} placeholder="e.g. Discovery Health Medical Scheme" value={form.scheme_name}
                  onChange={e => sf('scheme_name', e.target.value)} />
              </div>
              <div>
                <label style={labelStyle}>Effective From *</label>
                <input type="date" style={inputStyle} value={form.effective_from}
                  onChange={e => sf('effective_from', e.target.value)} />
              </div>
              <div>
                <label style={labelStyle}>Effective To <span style={{ fontWeight: 400 }}>(blank = active)</span></label>
                <input type="date" style={inputStyle} value={form.effective_to}
                  onChange={e => sf('effective_to', e.target.value)} />
              </div>
            </div>

            <div style={{ marginTop: 8, marginBottom: 4, fontSize: '0.72rem', fontWeight: 700, color: amber, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Billing Rates
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, background: 'var(--surface-50)', borderRadius: 10, padding: 14, border: '1px solid var(--surface-100)' }}>
              <div>
                <label style={labelStyle}>Rate per KM (R) *</label>
                <input type="number" step="0.01" style={inputStyle} placeholder="0.00" value={form.rate_per_km}
                  onChange={e => sf('rate_per_km', e.target.value)} />
              </div>
              <div>
                <label style={labelStyle}>Base Fee (R)</label>
                <input type="number" step="0.01" style={inputStyle} placeholder="0.00" value={form.base_fee}
                  onChange={e => sf('base_fee', e.target.value)} />
              </div>
              <div>
                <label style={labelStyle}>Minimum KM</label>
                <input type="number" step="0.1" style={inputStyle} placeholder="0.0" value={form.minimum_km}
                  onChange={e => sf('minimum_km', e.target.value)} />
              </div>
              <div>
                <label style={labelStyle}>Rounding Rule</label>
                <select style={inputStyle} value={form.rounding_rule} onChange={e => sf('rounding_rule', e.target.value)}>
                  <option value="nearest">Nearest</option>
                  <option value="up">Round Up</option>
                  <option value="down">Round Down</option>
                </select>
              </div>
              <div>
                <label style={labelStyle}>After-Hours ×</label>
                <input type="number" step="0.01" style={inputStyle} placeholder="1.00" value={form.after_hours_multiplier}
                  onChange={e => sf('after_hours_multiplier', e.target.value)} />
              </div>
              <div>
                <label style={labelStyle}>Weekend ×</label>
                <input type="number" step="0.01" style={inputStyle} placeholder="1.00" value={form.weekend_multiplier}
                  onChange={e => sf('weekend_multiplier', e.target.value)} />
              </div>
            </div>

            <div style={{ marginTop: 12 }}>
              <label style={labelStyle}>Notes</label>
              <textarea
                style={{ ...inputStyle, minHeight: 60, resize: 'vertical', fontFamily: 'inherit' }}
                placeholder="e.g. 2026 tariff book, effective from 1 Jan 2026..."
                value={form.notes} onChange={e => sf('notes', e.target.value)}
              />
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button style={btnPrimary} onClick={handleSave} disabled={saving}>
                {saving ? 'Saving...' : editing ? 'Update Schema' : 'Create Schema'}
              </button>
              <button style={{ ...btnPrimary, background: 'var(--surface-200)', color: 'var(--text)' }}
                onClick={() => { setShowForm(false); setEditing(null); }}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>Loading rate schemas...</div>
      ) : filtered.length === 0 ? (
        <div style={{ ...cardStyle, textAlign: 'center', padding: 40 }}>
          <p style={{ fontSize: '1rem', color: 'var(--text-muted)' }}>
            {search ? 'No schemas match your search' : 'No rate schemas configured yet'}
          </p>
          <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
            Click "Add Rate Schema" to define billing rates for your first medical scheme.
          </p>
        </div>
      ) : (
        <div style={{ ...cardStyle, padding: 0, overflow: 'hidden', overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem', minWidth: 900 }}>
            <thead>
              <tr style={{ background: 'var(--surface-100)', textAlign: 'left' }}>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>Schema Code</th>
                <th style={thStyle}>Scheme Name</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Rate/KM</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Base Fee</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Min KM</th>
                <th style={thStyle}>Rounding</th>
                <th style={thStyle}>Effective</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(s => {
                const active = isActive(s);
                return (
                  <tr key={s.id} style={{ borderBottom: '1px solid var(--surface-100)' }}>
                    <td style={{ padding: '10px 14px' }}>
                      <span style={{
                        padding: '2px 8px', borderRadius: 99, fontSize: '0.68rem', fontWeight: 700,
                        background: active ? 'rgba(8,131,149,0.1)' : 'rgba(150,150,150,0.1)',
                        color: active ? teal : 'var(--text-muted)',
                      }}>
                        {active ? 'ACTIVE' : 'EXPIRED'}
                      </span>
                    </td>
                    <td style={{ padding: '10px 14px', fontFamily: 'monospace', fontWeight: 600, fontSize: '0.78rem' }}>
                      {s.schema_code}
                    </td>
                    <td style={{ padding: '10px 14px', fontWeight: 600 }}>{s.scheme_name}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 700, color: teal }}>
                      R{s.rate_per_km.toFixed(2)}
                    </td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', fontFamily: 'monospace' }}>
                      R{s.base_fee.toFixed(2)}
                    </td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', fontFamily: 'monospace' }}>
                      {s.minimum_km.toFixed(1)}
                    </td>
                    <td style={{ padding: '10px 14px', fontSize: '0.78rem' }}>
                      {s.rounding_rule}
                    </td>
                    <td style={{ padding: '10px 14px', fontSize: '0.75rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                      {s.effective_from} → {s.effective_to || '∞'}
                    </td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button
                        onClick={() => openEdit(s)}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: teal, fontSize: '0.75rem', fontWeight: 700, marginRight: 8 }}
                      >Edit</button>
                      <button
                        onClick={() => handleDelete(s.id, s.schema_code)}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: rose, fontSize: '0.75rem', fontWeight: 700 }}
                      >Delete</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Info card */}
      <div style={{
        ...cardStyle, marginTop: 8, padding: 14,
        background: 'rgba(8,131,149,0.04)', border: `1px solid rgba(8,131,149,0.15)`,
      }}>
        <div style={{ fontSize: '0.72rem', fontWeight: 700, color: teal, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
          How Rate Schemas Work
        </div>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
          <li><strong>Schema Code</strong> links a PRF to its rate schedule — auto-populated from the medical scheme selected on the form.</li>
          <li><strong>Effective dates</strong> ensure historical PRFs are always re-billed at the rate active at the time of the call.</li>
          <li><strong>After-hours / weekend multipliers</strong> are applied automatically when the dispatch time falls outside standard hours.</li>
          <li>Rates change annually — create a new schema with the new effective date rather than editing the old one.</li>
        </ul>
      </div>
    </div>
  );
}
