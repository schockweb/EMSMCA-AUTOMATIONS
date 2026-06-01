const fs = require('fs');
let content = fs.readFileSync('frontend/src/pages/crew/DigitalPRFForm.tsx', 'utf8');

function normalize(str) { return str.replace(/\r\n/g, '\n'); }
content = normalize(content);

// Fix 1: Remove emoji icon from Assessment Modal
const badAssessIcon = `                        <div style={{
                          width: 42, height: 42, borderRadius: 21, flexShrink: 0,
                          background: isOn ? G : S200,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: '1.1rem', transition: 'all 0.15s ease',
                        }}>
                          {ICONS[lvl]}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 800, fontSize: '0.96rem', color: isOn ? GDK : S900 }}>{lvl}</div>`;

const goodAssessIcon = `                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 800, fontSize: '0.96rem', color: isOn ? GDK : S900 }}>{lvl}</div>`;

// Fix 2: Remove emoji icon from Monitoring Modal
const badMonitorIcon = `                        <div style={{
                          width: 42, height: 42, borderRadius: 21, flexShrink: 0,
                          background: isOn ? G : S200,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: '1.1rem', transition: 'all 0.15s ease',
                        }}>
                          {ICONS[lvl]}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>`;

const goodMonitorIcon = `                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>`;

// Fix 3: Remove inline Upgrade/Downgrade badges from Monitoring Modal tiles
const badBadges = `                            <span style={{ fontWeight: 800, fontSize: '0.96rem', color: isOn ? GDK : S900 }}>{lvl}</span>
                            {wouldMismatch && !isOn && (
                              <span style={{
                                fontSize: '0.62rem', fontWeight: 800, padding: '2px 6px', borderRadius: 5,
                                background: wouldUpgrade ? 'rgba(245,158,11,0.12)' : 'rgba(59,130,246,0.10)',
                                color: wouldUpgrade ? '#92400e' : '#1e40af',
                                letterSpacing: '0.05em', textTransform: 'uppercase',
                              }}>
                                {wouldUpgrade ? '\u2191 Upgrade' : '\u2193 Downgrade'}
                              </span>
                            )}
                          </div>`;

const goodBadges = `                            <span style={{ fontWeight: 800, fontSize: '0.96rem', color: isOn ? GDK : S900 }}>{lvl}</span>
                          </div>`;


let changed = 0;

if (content.includes(normalize(badAssessIcon))) { content = content.replace(normalize(badAssessIcon), normalize(goodAssessIcon)); changed++; }
else console.log('Could not find badAssessIcon');

if (content.includes(normalize(badMonitorIcon))) { content = content.replace(normalize(badMonitorIcon), normalize(goodMonitorIcon)); changed++; }
else console.log('Could not find badMonitorIcon');

if (content.includes(normalize(badBadges))) { content = content.replace(normalize(badBadges), normalize(goodBadges)); changed++; }
else console.log('Could not find badBadges');

if (changed > 0) {
    fs.writeFileSync('frontend/src/pages/crew/DigitalPRFForm.tsx', content);
    console.log('Fixed Modal icons and badges! Changed:', changed);
}
