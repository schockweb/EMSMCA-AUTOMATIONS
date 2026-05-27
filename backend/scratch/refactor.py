import re

filepath = r"c:\Users\USER-PC\Desktop\New EMS AUTOMATIONS\frontend\src\pages\crew\DigitalPRFForm.tsx"

with open(filepath, "r", encoding="utf-8") as f:
    content = f.read()

# Add createContext, useContext to imports
content = content.replace("import { useState, useEffect, useRef, useMemo, useCallback } from 'react';", "import { useState, useEffect, useRef, useMemo, useCallback, createContext, useContext } from 'react';")

# Extract the primitives block
primitives_start = content.find("  // ── Shared UI primitives ──────────────────────────────────────────────────")
primitives_end = content.find("  // ── Timing row with Mark button ──────────────────────────────────────────")

if primitives_start != -1 and primitives_end != -1:
    primitives_code = content[primitives_start:primitives_end]
    
    # Remove it from inside the component
    content = content[:primitives_start] + content[primitives_end:]
    
    # Modify primitives to use Context
    new_primitives = """
// ── Shared UI Context & Primitives ──────────────────────────────────────────────────
export const FormContext = createContext<any>(null);

const base: React.CSSProperties = {
  width: '100%', padding: '13px 14px', fontSize: '0.93rem', color: '#0f172a',
  background: '#ffffff', border: `1.5px solid #e2e8f0`, borderRadius: 10,
  outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit',
  boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.03)',
};
const onF = (e: React.FocusEvent<any>) => { e.currentTarget.style.borderColor = '#10b981'; e.currentTarget.style.boxShadow = `0 0 0 3px rgba(16,185,129,0.125), inset 0 1px 2px rgba(0,0,0,0.03)`; };
const onB = (e: React.FocusEvent<any>) => { e.currentTarget.style.borderColor = '#e2e8f0'; e.currentTarget.style.boxShadow = 'inset 0 1px 2px rgba(0,0,0,0.03)'; };

const Lbl = ({ t, req }: { t: string; req?: boolean }) => (
  <div style={{ fontSize: '0.68rem', fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 7 }}>
    {t}{req && <span style={{ color: '#ef4444', marginLeft: 3 }}>*</span>}
  </div>
);

const Inp = ({ fk, ph = '', type = 'text', req }: { fk: string; ph?: string; type?: string; req?: boolean }) => {
  const { fd, sf } = useContext(FormContext);
  return <input type={type} value={fd[fk] ?? ''} onChange={e => sf(fk, e.target.value)} onFocus={onF} onBlur={onB} placeholder={ph} autoComplete="off" style={{ ...base, marginBottom: 14, borderColor: req && !fd[fk] ? `rgba(239,68,68,0.6)` : '#e2e8f0' }} />
};

const Txt = ({ fk, ph = '', rows = 3 }: { fk: string; ph?: string; rows?: number }) => {
  const { fd, sf } = useContext(FormContext);
  return <textarea value={fd[fk] ?? ''} onChange={e => sf(fk, e.target.value)} onFocus={onF} onBlur={onB} placeholder={ph} rows={rows} style={{ ...base, resize: 'vertical', marginBottom: 14, fontFamily: 'inherit' }} />
};

const Sel = ({ fk, opts }: { fk: string; opts: string[] }) => {
  const { fd, sf } = useContext(FormContext);
  return <select value={fd[fk] ?? ''} onChange={e => sf(fk, e.target.value)} onFocus={onF} onBlur={onB} style={{ ...base, marginBottom: 14, appearance: 'menulist' }}>
    <option value="">— Select —</option>
    {opts.map((o: string) => <option key={o} value={o}>{o}</option>)}
  </select>
};

const Toggle = ({ fk, opts, colors }: { fk: string; opts: string[]; colors?: Record<string, string> }) => {
  const { fd, sf } = useContext(FormContext);
  return <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
    {opts.map((o: string) => {
      const on = fd[fk] === o; const c = colors?.[o] || '#10b981';
      return <button key={o} type="button" onClick={() => sf(fk, o)} style={{ flex: 1, minWidth: 60, padding: '13px 8px', borderRadius: 10, fontSize: '0.82rem', fontWeight: 700, border: `2px solid ${on ? c : '#e2e8f0'}`, background: on ? `${c}18` : '#ffffff', color: on ? c : '#475569', cursor: 'pointer', transition: 'all 0.15s', boxShadow: on ? `0 0 0 3px ${c}22` : '0 1px 2px rgba(0,0,0,0.03)' }}>{o}</button>;
    })}
  </div>
};

const Chk = ({ fk, val, label }: { fk: string; val: string; label?: string }) => {
  const { inArr, toggleArr } = useContext(FormContext);
  const on = inArr(fk, val);
  return (
    <button type="button" onClick={() => toggleArr(fk, val)} style={{ padding: '11px 14px', borderRadius: 10, width: '100%', textAlign: 'left', border: `1.5px solid ${on ? '#10b981' : '#e2e8f0'}`, background: on ? 'rgba(16,185,129,0.09)' : '#ffffff', color: on ? '#059669' : '#0f172a', fontWeight: on ? 700 : 500, fontSize: '0.85rem', cursor: 'pointer', transition: 'all 0.15s', display: 'flex', alignItems: 'center', gap: 10, boxShadow: on ? `0 0 0 2px rgba(16,185,129,0.13)` : '0 1px 2px rgba(0,0,0,0.02)' }}>
      <span style={{ width: 18, height: 18, borderRadius: 5, border: `2px solid ${on ? '#10b981' : '#94a3b8'}`, background: on ? '#10b981' : '#ffffff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, color: '#ffffff', fontSize: '0.7rem', fontWeight: 900 }}>{on ? '✓' : ''}</span>
      {label || val}
    </button>
  );
};

const SHdr = ({ t, c = '#059669' }: { t: string; c?: string }) => (
  <div style={{ fontSize: '0.72rem', fontWeight: 800, color: c, textTransform: 'uppercase', letterSpacing: '0.1em', borderBottom: `2px solid ${c}28`, paddingBottom: 8, marginBottom: 16, marginTop: 6 }}>{t}</div>
);

const Card = ({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) => (
  <div style={{ background: '#ffffff', borderRadius: 14, border: `1.5px solid #e2e8f0`, boxShadow: '0 1px 4px rgba(0,0,0,0.04)', padding: 18, marginBottom: 16, ...style }}>{children}</div>
);

const G2 = ({ children }: { children: React.ReactNode }) => (
  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 12px' }}>{children}</div>
);

"""
    
    # Insert new primitives before the component
    comp_start = content.find("export default function DigitalPRFForm() {")
    content = content[:comp_start] + new_primitives + content[comp_start:]
    
    # Wrap return with Provider
    # Find the return ( block
    ret_idx = content.find("  return (\n")
    if ret_idx != -1:
        # We need to wrap it
        content = content.replace("  return (\n    <div", "  return (\n    <FormContext.Provider value={{ fd, sf, inArr, toggleArr }}>\n    <div")
        # And close it at the end
        content = content.replace("    </div>\n  );\n}", "    </div>\n    </FormContext.Provider>\n  );\n}")

with open(filepath, "w", encoding="utf-8") as f:
    f.write(content)

print("Refactor complete")
