import sys

filename = r"c:\Users\USER-PC\Desktop\New EMS AUTOMATIONS\frontend\src\pages\crew\DigitalPRFForm.tsx"

with open(filename, "r", encoding="utf-8") as f:
    lines = f.readlines()

# keep up to line 1184 (index 1183)
lines = lines[:1184]

content = """
  // Timer to show in header
  const headerTimer = phase === 3 && sceneSeconds !== null
    ? `Scene ${fmtElapsed(sceneSeconds)}`
    : phase === 4 && transportSeconds !== null
    ? `Transport ${fmtElapsed(transportSeconds)}`
    : null;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <FormContext.Provider value={{ fd, sf, inArr, toggleArr }}>
    <div style={{ minHeight:'100vh', background:S50, color:S900, paddingBottom:100, fontFamily:'-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif' }}>

      {/* ── Sticky header ── */}
      <div style={{ position:'sticky', top:0, zIndex:50, background:'rgba(255,255,255,0.97)', backdropFilter:'blur(12px)', borderBottom:`1px solid ${S200}`, boxShadow:'0 1px 4px rgba(0,0,0,0.05)' }}>

        {/* Top bar */}
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'12px 18px' }}>
          <button onClick={() => navigate(`/${providerSlug}/crew/dashboard`)} style={{ background:'none', border:'none', color:GDK, fontSize:'1.3rem', cursor:'pointer', padding:'2px 4px' }}>&#8592;</button>
          <div style={{ textAlign:'center' }}>
            <div style={{ fontWeight:800, fontSize:'0.9rem', color:S900 }}>PRF #{prfMeta.prf_number}</div>
            {headerTimer
              ? <div style={{ fontSize:'0.68rem', color:GDK, fontWeight:800, fontFamily:'monospace', marginTop:1 }}>{headerTimer}</div>
              : <div style={{ fontSize:'0.65rem', color:S400, marginTop:1 }}>{prfMeta.case_number || '—'}</div>
            }
          </div>
          <div style={{ fontSize:'0.68rem', fontWeight:700, color:saving ? G : S400 }}>{saving ? 'Saving...' : savedStr}</div>
        </div>

        {/* Journey phase bar */}
        <div style={{ padding:'0 14px 4px' }}>
          <div style={{ display:'flex', alignItems:'center' }}>
            {PHASES.map((p, i) => {
              const done = phase > i, active = phase === i;
              const c = done || active ? G : S200;
              return (
                <div key={p.id} style={{ display:'flex', alignItems:'center', flex: i < PHASES.length - 1 ? '1 1 0' : 'none' }}>
                  <button type="button" onClick={() => setPhase(i)} style={{ width:28, height:28, borderRadius:14, flexShrink:0, background:done?G:active?G:W, border:`2px solid ${c}`, color:done||active?W:S400, fontSize:'0.6rem', fontWeight:900, display:'flex', alignItems:'center', justifyContent:'center', cursor:'pointer', boxShadow:active?`0 0 0 3px ${G}30`:'none', transition:'all 0.2s' }}>
                    {done ? '✓' : i + 1}
                  </button>
                  {i < PHASES.length - 1 && <div style={{ flex:1, height:2, background:done?G:S200, margin:'0 2px', transition:'background 0.3s' }} />}
                </div>
              );
            })}
          </div>
          <div style={{ display:'flex', marginTop:5, paddingBottom:8 }}>
            {PHASES.map((p, i) => (
              <div key={p.id} style={{ flex:1, textAlign:'center', fontSize:'0.48rem', fontWeight:phase===i?800:500, color:phase===i?GDK:S400, textTransform:'uppercase', letterSpacing:'0.04em' }}>{p.short}</div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Phase content ── */}
      <div style={{ padding:'20px 18px', maxWidth:640, margin:'0 auto' }}>
        {/* Phase title */}
        <div style={{ marginBottom:22 }}>
          <div style={{ display:'flex', alignItems:'center', gap:12 }}>
            <div style={{ width:36, height:36, borderRadius:18, background:`linear-gradient(135deg,${G},${GDK})`, display:'flex', alignItems:'center', justifyContent:'center', color:W, fontWeight:900, fontSize:'0.85rem', flexShrink:0 }}>{phase + 1}</div>
            <div>
              <div style={{ fontSize:'1.2rem', fontWeight:900, color:S900 }}>{PHASES[phase].label}</div>
              <div style={{ fontSize:'0.7rem', color:S400, marginTop:2 }}>Step {phase + 1} of {PHASES.length}</div>
            </div>
          </div>
        </div>

        {Renderer()}
      </div>

      {/* ── Floating quick-vitals button (clinical & transport phases) ── */}
      {(phase === 3 || phase === 4) && !quickVital && (
        <button type="button" onClick={() => setQV(true)} style={{ position:'fixed', bottom:90, right:18, zIndex:100, width:56, height:56, borderRadius:28, background:`linear-gradient(135deg,${G},${GDK})`, border:'none', color:W, fontSize:'0.65rem', fontWeight:900, cursor:'pointer', boxShadow:`0 4px 20px ${G}55`, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:2, lineHeight:1 }}>
          <span style={{ fontSize:'1.2rem', lineHeight:1 }}>+</span>
          <span style={{ fontSize:'0.5rem', letterSpacing:'0.04em' }}>VITALS</span>
        </button>
      )}

      {/* ── Quick vitals overlay ── */}
      {quickVital && (
        <QuickVitalsOverlay
          onClose={() => setQV(false)}
          onSave={v => { setVitals(p => [...p, v]); dirtyRef.current = true; setQV(false); }}
        />
      )}

      {/* ── Bottom nav ── */}
      <div style={{ position:'fixed', bottom:0, left:0, right:0, zIndex:40, display:'flex', gap:10, padding:'12px 18px', background:'rgba(255,255,255,0.97)', backdropFilter:'blur(12px)', borderTop:`1px solid ${S200}`, boxShadow:'0 -4px 16px rgba(0,0,0,0.06)' }}>
        {phase > 0 && (
          <button type="button" onClick={() => setPhase(phase - 1)} style={{ flex:1, padding:'15px 0', borderRadius:12, fontSize:'0.88rem', fontWeight:800, border:`2px solid ${S200}`, background:W, color:S600, cursor:'pointer' }}>&#8592; Back</button>
        )}
        {phase < PHASES.length - 1 ? (
          <button type="button" onClick={() => { doSave(); setPhase(p => p + 1); }} style={{ flex:2, padding:'15px 0', borderRadius:12, fontSize:'0.88rem', fontWeight:800, border:'none', background:`linear-gradient(135deg,${G},${GDK})`, color:W, cursor:'pointer', boxShadow:`0 4px 14px ${G}30` }}>Save &amp; Continue &#8594;</button>
        ) : (
          <button type="button" onClick={handleSubmit} disabled={submitting} style={{ flex:2, padding:'15px 0', borderRadius:12, fontSize:'0.88rem', fontWeight:800, border:'none', cursor:submitting?'wait':'pointer', background:submitting?S400:`linear-gradient(135deg,${ROSE},#be123c)`, color:W, boxShadow:submitting?'none':`0 4px 14px rgba(225,29,72,0.3)` }}>{submitting?'Submitting...':'Submit PRF'}</button>
        )}
      </div>
    </div>
    </FormContext.Provider>
  );
}
"""

lines.append(content)

with open(filename, "w", encoding="utf-8") as f:
    f.writelines(lines)

print("Fixed")
