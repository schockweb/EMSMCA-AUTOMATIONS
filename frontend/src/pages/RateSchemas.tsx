/**
 * MedicalSchemes (route: /add-schemas) — Manage the master list of medical
 * schemes connected to the EMSMCA client. Only scheme identity is managed here.
 * Billing tariff codes are managed under /tariff-billing.
 */
import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';

/* ── Types ──────────────────────────────────────────────────────── */
interface RateSchema {
  id: number;
  schema_code: string;
  scheme_name: string;
  effective_from: string;
  effective_to: string | null;
  notes: string | null;
  // Scalar billing fields still exist in the DB — we just don't show them here
  rate_per_km: number;
  base_fee: number;
  minimum_km: number;
  rounding_rule: string;
  after_hours_multiplier: number;
  weekend_multiplier: number;
  created_at?: string;
}

const EMPTY_FORM = {
  schema_code: '',
  scheme_name: '',
  notes: '',
};

/* ── Design tokens ──────────────────────────────────────────────── */
const teal  = '#088395';
const rose  = '#C2185B';

export default function MedicalSchemes() {
  const navigate = useNavigate();

  const [schemas, setSchemas]         = useState<RateSchema[]>([]);
  const [loading, setLoading]         = useState(true);
  const [showForm, setShowForm]       = useState(false);
  const [editing, setEditing]         = useState<RateSchema | null>(null);
  const [form, setForm]               = useState(EMPTY_FORM);
  const [saving, setSaving]           = useState(false);
  const [search, setSearch]           = useState('');
  const [filterActive, setFilterActive] = useState(false);

  /* ── Fetch ──────────────────────────────────────────────────────── */
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

  /* ── Helpers ────────────────────────────────────────────────────── */
  const isActive = (s: RateSchema) =>
    !s.effective_to || new Date(s.effective_to) >= new Date();

  const sf = (key: string, val: string) =>
    setForm(prev => ({ ...prev, [key]: val }));

  const filtered = schemas.filter(s => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      s.scheme_name.toLowerCase().includes(q) ||
      s.schema_code.toLowerCase().includes(q)
    );
  });

  /* ── Actions ────────────────────────────────────────────────────── */
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
      notes: s.notes || '',
    });
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!form.scheme_name.trim()) {
      alert('Please enter a Medical Scheme Name.');
      return;
    }
    setSaving(true);
    try {
      // Auto-generate code from name: "Discovery Health" → "DISCOVERY_HEALTH"
      const autoCode = form.scheme_name.trim().toUpperCase().replace(/\s+/g, '_').replace(/[^A-Z0-9_]/g, '');
      const today = new Date().toISOString().slice(0, 10);
      const payload = {
        schema_code:  editing?.schema_code ?? autoCode,
        scheme_name:  form.scheme_name.trim(),
        effective_from: today,
        effective_to: null,
        rate_per_km: editing?.rate_per_km ?? 0,
        base_fee: editing?.base_fee ?? 0,
        minimum_km: editing?.minimum_km ?? 0,
        rounding_rule: editing?.rounding_rule ?? 'nearest',
        after_hours_multiplier: editing?.after_hours_multiplier ?? 1,
        weekend_multiplier: editing?.weekend_multiplier ?? 1,
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
      alert(e.response?.data?.detail || 'Failed to save scheme');
    }
    setSaving(false);
  };

  const handleDelete = async (id: number, name: string) => {
    if (!window.confirm(`Remove scheme "${name}"? This cannot be undone.`)) return;
    try {
      await api.delete(`/api/rate-schemas/${id}`);
      fetchSchemas();
    } catch (e: any) {
      alert(e.response?.data?.detail || 'Failed to delete');
    }
  };

  /* ── Styles ─────────────────────────────────────────────────────── */
  const btnPrimary: React.CSSProperties = {
    background: `linear-gradient(135deg, ${teal}, #0a9396)`,
    color: '#fff', border: 'none', borderRadius: 8,
    padding: '9px 20px', fontSize: '0.84rem', fontWeight: 700,
    cursor: 'pointer', letterSpacing: '0.03em',
    display: 'flex', alignItems: 'center', gap: 6,
  };

  const btnOutline: React.CSSProperties = {
    background: 'transparent', border: `1.5px solid ${teal}`,
    color: teal, borderRadius: 8, padding: '7px 16px',
    fontSize: '0.78rem', fontWeight: 700, cursor: 'pointer',
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', fontSize: '0.88rem', padding: '10px 14px',
    borderRadius: 10, border: '1.5px solid var(--surface-200)',
    background: 'var(--surface-0)', color: 'var(--text-primary)',
    marginBottom: 0, boxSizing: 'border-box',
    outline: 'none', transition: 'border-color 0.15s',
  };

  const labelStyle: React.CSSProperties = {
    fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-muted)',
    textTransform: 'uppercase', letterSpacing: '0.07em',
    marginBottom: 5, display: 'block',
  };

  const fieldWrap: React.CSSProperties = {
    display: 'flex', flexDirection: 'column', gap: 0,
  };

  /* ── Render ─────────────────────────────────────────────────────── */
  return (
    <div style={{ maxWidth: 1100, margin: '0 auto' }}>

      {/* ── Page Header ──────────────────────────────────────── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: '1.55rem', fontWeight: 900, margin: 0, color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
            🏥 Medical Schemes
          </h1>
          <p style={{ fontSize: '0.84rem', color: 'var(--text-muted)', margin: '5px 0 0' }}>
            Manage all medical schemes linked to EMSMCA clients. Tariff codes are configured under{' '}
            <span
              onClick={() => navigate('/tariff-billing')}
              style={{ color: teal, cursor: 'pointer', fontWeight: 700, textDecoration: 'underline' }}
            >
              Tariff Billing →
            </span>
          </p>
        </div>
        <button style={btnPrimary} onClick={openAdd}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          Add Scheme
        </button>
      </div>

      {/* ── Stats Strip ──────────────────────────────────────── */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 20,
      }}>
        {[
          { label: 'Total Schemes', val: schemas.length, icon: '🏥', color: teal },
          { label: 'Active', val: schemas.filter(isActive).length, icon: '✅', color: '#10b981' },
          { label: 'Expired', val: schemas.filter(s => !isActive(s)).length, icon: '🔒', color: '#94a3b8' },
        ].map(stat => (
          <div key={stat.label} style={{
            background: 'var(--surface-0)', borderRadius: 12,
            border: '1px solid var(--surface-100)', padding: '14px 18px',
            display: 'flex', alignItems: 'center', gap: 12,
          }}>
            <span style={{ fontSize: '1.5rem' }}>{stat.icon}</span>
            <div>
              <div style={{ fontSize: '1.5rem', fontWeight: 900, color: stat.color, lineHeight: 1 }}>
                {stat.val}
              </div>
              <div style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 2 }}>
                {stat.label}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* ── Search + Filter bar ───────────────────────────────── */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center' }}>
        <div style={{ position: 'relative', maxWidth: 340, flex: 1 }}>
          <svg style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', opacity: 0.4 }}
            width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            type="text" placeholder="Search schemes..."
            value={search} onChange={e => setSearch(e.target.value)}
            style={{ ...inputStyle, paddingLeft: 36 }}
          />
        </div>
        <button
          onClick={() => setFilterActive(!filterActive)}
          style={{
            padding: '9px 16px', borderRadius: 9, fontSize: '0.78rem', fontWeight: 700,
            cursor: 'pointer', letterSpacing: '0.03em',
            border: `1.5px solid ${filterActive ? teal : 'var(--surface-200)'}`,
            background: filterActive ? 'rgba(8,131,149,0.08)' : 'var(--surface-0)',
            color: filterActive ? teal : 'var(--text-muted)',
            transition: 'all 0.15s',
          }}
        >
          {filterActive ? '● Active Only' : '○ All Schemes'}
        </button>
        <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginLeft: 'auto' }}>
          {filtered.length} scheme{filtered.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* ── Scheme List ──────────────────────────────────────── */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-muted)', fontSize: '0.9rem' }}>
          Loading schemes...
        </div>
      ) : filtered.length === 0 ? (
        <div style={{
          background: 'var(--surface-0)', border: '1px solid var(--surface-100)',
          borderRadius: 14, padding: '48px 24px', textAlign: 'center',
        }}>
          <div style={{ fontSize: '2.5rem', marginBottom: 12 }}>🏥</div>
          <p style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 6px' }}>
            {search ? 'No schemes match your search' : 'No medical schemes added yet'}
          </p>
          <p style={{ fontSize: '0.84rem', color: 'var(--text-muted)', margin: '0 0 18px' }}>
            Add your first medical scheme to get started.
          </p>
          <button style={btnPrimary} onClick={openAdd}>+ Add First Scheme</button>
        </div>
      ) : (
        <div style={{
          background: 'var(--surface-0)', borderRadius: 14,
          border: '1px solid var(--surface-100)', overflow: 'hidden',
        }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.84rem' }}>
            <thead>
              <tr style={{ background: 'var(--surface-50)' }}>
                {['Status', 'Scheme Name', 'Code', 'Since', 'Notes', ''].map((h, i) => (
                  <th key={h + i} style={{
                    padding: '11px 16px', fontWeight: 700, fontSize: '0.68rem',
                    textTransform: 'uppercase', color: 'var(--text-muted)',
                    letterSpacing: '0.07em', textAlign: i >= 4 ? 'right' : 'left',
                    whiteSpace: 'nowrap',
                  }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map(s => {
                const active = isActive(s);
                return (
                  <tr
                    key={s.id}
                    style={{ borderTop: '1px solid var(--surface-100)', transition: 'background 0.1s' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-50)')}
                    onMouseLeave={e => (e.currentTarget.style.background = '')}
                  >
                    {/* Status */}
                    <td style={{ padding: '13px 16px' }}>
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', gap: 5,
                        padding: '3px 10px', borderRadius: 99, fontSize: '0.66rem', fontWeight: 800,
                        background: active ? 'rgba(16,185,129,0.1)' : 'rgba(148,163,184,0.12)',
                        color: active ? '#10b981' : '#94a3b8',
                        textTransform: 'uppercase', letterSpacing: '0.04em',
                      }}>
                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor' }} />
                        {active ? 'Active' : 'Expired'}
                      </span>
                    </td>

                    {/* Scheme Name */}
                    <td style={{ padding: '13px 16px', fontWeight: 700, color: 'var(--text-primary)' }}>
                      {s.scheme_name}
                    </td>

                    {/* Code */}
                    <td style={{ padding: '13px 16px' }}>
                      <span style={{
                        fontFamily: 'monospace', fontSize: '0.78rem', fontWeight: 700,
                        background: 'rgba(8,131,149,0.08)', color: teal,
                        padding: '3px 9px', borderRadius: 6,
                      }}>
                        {s.schema_code}
                      </span>
                    </td>

                    {/* Since */}
                    <td style={{ padding: '13px 16px', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                      {s.effective_from}
                    </td>

                    {/* Notes */}
                    <td style={{
                      padding: '13px 16px', fontSize: '0.78rem', color: 'var(--text-muted)',
                      maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {s.notes || '—'}
                    </td>

                    {/* Actions */}
                    <td style={{ padding: '13px 16px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button
                        onClick={() => navigate('/tariff-billing')}
                        style={{
                          background: 'none', border: 'none', cursor: 'pointer',
                          color: teal, fontSize: '0.75rem', fontWeight: 700, marginRight: 4,
                          padding: '4px 8px', borderRadius: 6,
                        }}
                        title="Manage tariff codes for this scheme"
                      >
                        📋 Tariffs
                      </button>
                      <button
                        onClick={() => openEdit(s)}
                        style={{
                          background: 'none', border: 'none', cursor: 'pointer',
                          color: 'var(--text-secondary)', fontSize: '0.75rem', fontWeight: 700,
                          padding: '4px 8px', borderRadius: 6, marginRight: 4,
                        }}
                      >
                        ✏️ Edit
                      </button>
                      <button
                        onClick={() => handleDelete(s.id, s.scheme_name)}
                        style={{
                          background: 'none', border: 'none', cursor: 'pointer',
                          color: rose, fontSize: '0.75rem', fontWeight: 700,
                          padding: '4px 8px', borderRadius: 6,
                        }}
                      >
                        🗑️
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Add / Edit Modal ─────────────────────────────────── */}
      {showForm && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 300,
            background: 'rgba(15,23,42,0.6)', backdropFilter: 'blur(4px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
          }}
          onClick={() => setShowForm(false)}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: 'var(--surface-0)', borderRadius: 18, padding: '28px 28px 24px',
              width: '100%', maxWidth: 520,
              boxShadow: '0 24px 80px rgba(0,0,0,0.22)',
            }}
          >
            {/* Modal header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 22 }}>
              <div>
                <h2 style={{ fontSize: '1.15rem', fontWeight: 900, color: 'var(--text-primary)', margin: 0, letterSpacing: '-0.01em' }}>
                  {editing ? 'Edit Scheme' : 'Add Medical Scheme'}
                </h2>
                <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '3px 0 0' }}>
                  {editing ? 'Update scheme details' : 'Register a new medical scheme with EMSMCA'}
                </p>
              </div>
              <button
                onClick={() => setShowForm(false)}
                style={{
                  width: 32, height: 32, borderRadius: '50%', border: 'none',
                  background: 'var(--surface-100)', color: 'var(--text-muted)',
                  cursor: 'pointer', fontSize: '1rem', display: 'flex',
                  alignItems: 'center', justifyContent: 'center', fontWeight: 700,
                }}
              >×</button>
            </div>

            {/* Single field: scheme name only */}
            <div style={fieldWrap}>
              <label style={labelStyle}>Medical Scheme Name *</label>
              <input
                autoFocus
                style={inputStyle}
                placeholder="e.g. Discovery Health Medical Scheme"
                value={form.scheme_name}
                onChange={e => sf('scheme_name', e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleSave(); }}
                onFocus={e => (e.target.style.borderColor = teal)}
                onBlur={e => (e.target.style.borderColor = 'var(--surface-200)')}
              />
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', gap: 10, marginTop: 22 }}>
              <button style={{ ...btnPrimary, flex: 1, justifyContent: 'center' }} onClick={handleSave} disabled={saving}>
                {saving ? 'Saving...' : editing ? 'Update Scheme' : 'Add Scheme'}
              </button>
              <button style={btnOutline} onClick={() => setShowForm(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
