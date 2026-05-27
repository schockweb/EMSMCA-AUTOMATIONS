import re

with open('frontend/src/pages/crew/DigitalPRFForm.tsx', 'r', encoding='utf-8') as f:
    text = f.read()

# 1. Remove STEPS
text = re.sub(r'const STEPS = \[.*?\];', "const STEPS = ['Digital PRF'];", text, flags=re.DOTALL)

# 2. Add showSections state and replace `step` state
text = text.replace(
    'const [step, setStep] = useState(0);',
    'const [showSections, setShowSections] = useState(false);\n  const step = 0;'
)

# 3. Add useEffect to track arrival_at_scene_time and set showSections
text = text.replace(
    'const profile = JSON.parse(localStorage.getItem(\'crew_profile\') || \'{}\');',
    '''const profile = JSON.parse(localStorage.getItem('crew_profile') || '{}');

  useEffect(() => {
    if (fd.arrival_at_scene_time) {
      if (!showSections) {
        const timer = setTimeout(() => setShowSections(true), 2000);
        return () => clearTimeout(timer);
      }
    } else {
      setShowSections(false);
    }
  }, [fd.arrival_at_scene_time, showSections]);'''
)

# 4. Remove setStep(1) from arrival_at_scene_time since it's now handled by the auto-timer
text = re.sub(
    r"onChange=\{e => \{\s*setField\('arrival_at_scene_time', e.target\.value\);\s*if \(e\.target\.value\) \{\s*setTimeout\(\(\) => setStep\(1\), 600\);\s*\}\s*\}\}",
    "onChange={e => setField('arrival_at_scene_time', e.target.value)}",
    text
)

# 5. Extract case 0, 1, 2, 4
try:
    case_0_str = re.search(r'case 0: \{(.*?)\}\s*// ═══ Step 1:', text, flags=re.DOTALL).group(1)
    case_0_body = re.search(r'return \(\s*<>(.*?)</>\s*\);', case_0_str, flags=re.DOTALL).group(1)

    case_1_str = re.search(r'case 1: \{(.*?)\}\s*// ═══ Step 2: Call', text, flags=re.DOTALL).group(1)
    case_1_body = re.search(r'return \(\s*<>(.*?)</>\s*\);', case_1_str, flags=re.DOTALL).group(1)

    case_2_str = re.search(r'case 2:\s*return \(\s*<>(.*?)</>\s*\);', text, flags=re.DOTALL).group(1)
    
    case_4_str = re.search(r'case 4: \{(.*?)\}\s*// ═══ Step 5:', text, flags=re.DOTALL).group(1)
    case_4_body = re.search(r'return \(\s*<>(.*?)</>\s*\);', case_4_str, flags=re.DOTALL).group(1)

    case_0_vars = re.search(r'(const nowDate.*?)\s*return \(', case_0_str, flags=re.DOTALL).group(1)
    case_1_vars = re.search(r'(const vOpen.*?)\s*return \(', case_1_str, flags=re.DOTALL).group(1)
    case_4_vars = re.search(r'(const crew2 =.*?)\s*return \(', case_4_str, flags=re.DOTALL).group(1)

    main_content = f"""
  const renderContent = () => {{
    {case_0_vars}
    {case_1_vars}
    {case_4_vars}

    return (
      <>
        {{/* Dispatch Information */}}
        {case_0_body}

        {{showSections && (
          <div style={{{{ marginTop: 32 }}}}>
            {case_1_body}
            {case_2_str}
            {case_4_body}
          </div>
        )}}
      </>
    );
  }};
"""

    # We must use string replace or re.sub properly to avoid escape \ issues in the replacement target.
    # It's better to just split and join.
    match = re.search(r'const renderStep = \(\) => \{.+?// ═══ Step 15:.+?\}\s*};\s*return \(', text, flags=re.DOTALL)
    if match:
        text = text[:match.start()] + main_content + '\n  return (' + text[match.end():]
    else:
        print("COULD NOT FIND MATCH FOR RENDERSTEP")

    new_return = """
    <div style={{
      minHeight: '100vh',
      background: bgLight,
      color: textDark,
      paddingBottom: 110,
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
    }}>
      {/* Top Bar */}
      <div style={{
        padding: '14px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        borderBottom: `1px solid ${borderLight}`, position: 'sticky', top: 0, zIndex: 50,
        background: 'rgba(255,255,255,0.95)', backdropFilter: 'blur(12px)',
        boxShadow: '0 1px 3px rgba(0,0,0,0.04)'
      }}>
        <button onClick={() => navigate(`/${providerSlug}/crew/dashboard`)} style={{ background: 'none', border: 'none', color: jemsGreenDark, fontSize: '1.4rem', cursor: 'pointer', padding: '0 8px 0 0' }}>←</button>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '0.9rem', fontWeight: 800, color: textDark }}>PRF #{prfMeta.prf_number}</div>
          <div style={{ fontSize: '0.7rem', color: textMuted, fontWeight: 500, marginTop: 2 }}>{showSections ? 'Live Capture' : 'Dispatch'}</div>
        </div>
        <div style={{ fontSize: '0.7rem', fontWeight: 700, color: saving ? jemsGreen : textMuted }}>
          {saving ? 'Saving...' : 'Saved'}
        </div>
      </div>

      {/* Main Content */}
      <div style={{ padding: '24px 24px 30px' }}>
        {renderContent()}
      </div>

      {/* Bottom Submit Button */}
      {showSections && (
        <div style={{
          position: 'fixed', bottom: 0, left: 0, right: 0,
          padding: '16px 24px', background: 'rgba(255,255,255,0.95)',
          borderTop: `1px solid ${borderLight}`, backdropFilter: 'blur(12px)',
          boxShadow: '0 -4px 16px rgba(0,0,0,0.05)'
        }}>
          <button onClick={handleSubmit} disabled={submitting} style={{
            width: '100%', padding: '16px 0', borderRadius: 14, fontSize: '1rem', fontWeight: 800,
            border: 'none', background: submitting ? '#fbcfe8' : `linear-gradient(135deg, ${rose}, #be123c)`,
            color: '#fff', cursor: submitting ? 'wait' : 'pointer', transition: 'all 0.2s',
            boxShadow: submitting ? 'none' : `0 6px 20px rgba(225, 29, 72, 0.25)`
          }}>
            {submitting ? 'Submitting...' : 'Complete & Submit PRF'}
          </button>
        </div>
      )}
    </div>
"""

    match_end = re.search(r'<div style=\{\{\s*minHeight: \'100vh\',\s*background: bgLight,.*?</div>\s*</div>\s*\);\s*}$', text, flags=re.DOTALL)
    if match_end:
        text = text[:match_end.start()] + new_return + ');\n}'
    else:
        print("COULD NOT FIND MATCH FOR END RENDER")

    with open('frontend/src/pages/crew/DigitalPRFForm.tsx', 'w', encoding='utf-8') as f:
        f.write(text)
    print("Success")
except Exception as e:
    import traceback
    traceback.print_exc()
