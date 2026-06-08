const fs = require('fs');
let content = fs.readFileSync('frontend/src/pages/crew/DigitalPRFForm.tsx', 'utf8');

function normalize(str) { return str.replace(/\r\n/g, '\n'); }
content = normalize(content);

// Fix 1: Editor container
const badContainer = `        {/* Active editor */}
        {editing && (
          <div style={{ background: '#f0fdf4', border: \`2px solid \${G}\`, borderRadius: 14, padding: 18, marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <div style={{ fontWeight: 800, color: GDK }}>Vitals Set #{editVital + 1}</div>
              <button type="button" onClick={() => setEditVital(-1)} style={{ padding: '8px 18px', borderRadius: 8, fontSize: '0.82rem', fontWeight: 800, border: 'none', background: G, color: W, cursor: 'pointer' }}>Done</button>
            </div>`;

const goodContainer = `        {/* Active editor */}
        {editing && (
          <div style={{ background: '#ffffff', border: \`1.5px solid \${S200}\`, borderRadius: 14, padding: 18, marginBottom: 16, boxShadow: '0 4px 14px rgba(0,0,0,0.03)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <div style={{ fontWeight: 800, color: S900 }}>Vitals Set #{editVital + 1}</div>
              <button type="button" onClick={() => setEditVital(-1)} style={{ padding: '8px 18px', borderRadius: 8, fontSize: '0.82rem', fontWeight: 800, border: 'none', background: S800, color: W, cursor: 'pointer' }}>Done</button>
            </div>`;

// Fix 2: Alpha / 123 toggles
const badToggles = `                    {isNumericField && !hasOpts && (
                      <div style={{ display: 'inline-flex', borderRadius: 6, border: \`1.5px solid \${S200}\`, overflow: 'hidden', flexShrink: 0 }}>
                        <button type="button" onClick={() => { if (alphaOn) toggleAlpha(); }} style={{ padding: '2px 9px', fontSize: '0.65rem', fontWeight: 800, border: 'none', background: !alphaOn ? G : W, color: !alphaOn ? W : S600, cursor: 'pointer' }}>123</button>
                        <button type="button" onClick={() => { if (!alphaOn) toggleAlpha(); }} style={{ padding: '2px 9px', fontSize: '0.65rem', fontWeight: 800, border: 'none', background: alphaOn ? G : W, color: alphaOn ? W : S600, cursor: 'pointer' }}>Aa</button>
                      </div>
                    )}`;

const goodToggles = `                    {isNumericField && !hasOpts && (
                      <div style={{ display: 'inline-flex', borderRadius: 6, border: \`1.5px solid \${S200}\`, overflow: 'hidden', flexShrink: 0 }}>
                        <button type="button" onClick={() => { if (alphaOn) toggleAlpha(); }} style={{ padding: '2px 9px', fontSize: '0.65rem', fontWeight: 800, border: 'none', background: !alphaOn ? S700 : W, color: !alphaOn ? W : S600, cursor: 'pointer' }}>123</button>
                        <button type="button" onClick={() => { if (!alphaOn) toggleAlpha(); }} style={{ padding: '2px 9px', fontSize: '0.65rem', fontWeight: 800, border: 'none', background: alphaOn ? S700 : W, color: alphaOn ? W : S600, cursor: 'pointer' }}>Aa</button>
                      </div>
                    )}`;

// Fix 3: Options (hasOpts)
const badOpts = `                  {hasOpts ? (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {f.opts!.map(o => {
                        const on = editing[f.key] === o;
                        return <button key={o} type="button" onClick={() => updVS(f.key, o)} style={{ padding: '9px 14px', borderRadius: 8, fontSize: '0.8rem', fontWeight: 700, border: \`2px solid \${on ? G : S200}\`, background: on ? GBG : W, color: on ? GDK : S600, cursor: 'pointer', transition: 'all 0.12s' }}>{o}</button>;
                      })}
                    </div>
                  ) : (`;

const goodOpts = `                  {hasOpts ? (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {f.opts!.map(o => {
                        const on = editing[f.key] === o;
                        return <button key={o} type="button" onClick={() => updVS(f.key, o)} style={{ padding: '9px 14px', borderRadius: 8, fontSize: '0.8rem', fontWeight: 700, border: \`2px solid \${on ? S700 : S200}\`, background: on ? S50 : W, color: on ? S900 : S600, cursor: 'pointer', transition: 'all 0.12s' }}>{o}</button>;
                      })}
                    </div>
                  ) : (`;

let changed = 0;
if (content.includes(normalize(badContainer))) { content = content.replace(normalize(badContainer), normalize(goodContainer)); changed++; }
if (content.includes(normalize(badToggles))) { content = content.replace(normalize(badToggles), normalize(goodToggles)); changed++; }
if (content.includes(normalize(badOpts))) { content = content.replace(normalize(badOpts), normalize(goodOpts)); changed++; }

if (changed === 3) {
    fs.writeFileSync('frontend/src/pages/crew/DigitalPRFForm.tsx', content);
    console.log('Successfully changed vitals layout to minimalistic!');
} else {
    console.log('Failed to find all targets. Changed:', changed);
}
