const fs = require('fs');
let content = fs.readFileSync('frontend/src/pages/crew/DigitalPRFForm.tsx', 'utf8');

function normalize(str) { return str.replace(/\r\n/g, '\n'); }
content = normalize(content);

const badWarning = `                {/* Mismatch warning */}
                {hasMismatch && (
                  <div style={{
                    margin: '0 20px 12px',
                    padding: '12px 14px', borderRadius: 12,
                    border: \`1.5px solid \${isUpgrade ? '#f59e0b' : '#3b82f6'}\`,
                    background: isUpgrade ? 'rgba(245,158,11,0.09)' : 'rgba(59,130,246,0.08)',
                    color: isUpgrade ? '#7c2d12' : '#1e3a8a',
                    fontSize: '0.8rem', fontWeight: 600, lineHeight: 1.5,
                    display: 'flex', gap: 8, alignItems: 'flex-start',
                  }}>
                    <span style={{ fontSize: '1rem', flexShrink: 0 }}>{isUpgrade ? '\u2191' : '\u2193'}</span>
                    <span>
                      {isUpgrade
                        ? <><b>Upgrade required.</b> Monitoring ({fd.monitoring_level}) exceeds the assessed level ({fd.assessment_level}). Notify dispatch to upgrade this call to {fd.monitoring_level}.</>
                        : <><b>Downgrade required.</b> Monitoring ({fd.monitoring_level}) is below the assessed level ({fd.assessment_level}). Notify dispatch to downgrade this call to {fd.monitoring_level}.</>
                      }
                    </span>
                  </div>
                )}`;

const goodWarning = `                {/* Mismatch warning */}
                {hasMismatch && (
                  <div style={{
                    margin: '0 20px 12px',
                    padding: '12px 14px', borderRadius: 12,
                    border: \`1.5px solid \${S200}\`,
                    background: S50,
                    color: S700,
                    fontSize: '0.8rem', fontWeight: 600, lineHeight: 1.5,
                    display: 'flex', gap: 8, alignItems: 'flex-start',
                  }}>
                    <span style={{ fontSize: '1rem', flexShrink: 0, color: S500 }}>{isUpgrade ? '\u2191' : '\u2193'}</span>
                    <span>
                      {isUpgrade
                        ? <><b style={{ color: S900 }}>Upgrade required.</b> Monitoring ({fd.monitoring_level}) exceeds the assessed level ({fd.assessment_level}). Notify dispatch to upgrade this call to {fd.monitoring_level}.</>
                        : <><b style={{ color: S900 }}>Downgrade required.</b> Monitoring ({fd.monitoring_level}) is below the assessed level ({fd.assessment_level}). Notify dispatch to downgrade this call to {fd.monitoring_level}.</>
                      }
                    </span>
                  </div>
                )}`;

if (content.includes(normalize(badWarning))) {
    content = content.replace(normalize(badWarning), normalize(goodWarning));
    fs.writeFileSync('frontend/src/pages/crew/DigitalPRFForm.tsx', content);
    console.log('Fixed mismatch warning styles!');
} else {
    console.log('Could not find badWarning');
}
