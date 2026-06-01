const fs = require('fs');
let content = fs.readFileSync('frontend/src/pages/crew/DigitalPRFForm.tsx', 'utf8');

const regex = /(<span style=\{\{\s*color: S600,\s*fontSize: '0\.74rem',\s*fontWeight: 700,\s*textTransform: 'uppercase',\s*letterSpacing: '0\.06em'\s*\}\}>Difference<\/span>\s*<span style=\{\{\r?\n)\s*delta: kmConfirm\.delta,\s*acknowledged: true,\s*timestamp: new Date\(\)\.toISOString\(\),\s*\};\s*sf\('km_review_flags', \[\.\.\.existing, newFlag\]\);\s*close\(\);\s*\}\})/;

const replacement = `$1                      fontFamily: 'monospace', fontWeight: 800,
                      color: kmConfirm.delta < 0 ? REDC : '#92400e',
                    }}>{kmConfirm.delta > 0 ? '+' : ''}{kmConfirm.delta.toLocaleString()} km</span>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button
                    type="button"
                    onClick={() => {
                      sf(kmConfirm.kmKey, '');
                      close();
                    }}
                    style={{
                      flex: 1, padding: 12, borderRadius: 10,
                      border: \`1.5px solid \${S200}\`, background: '#fff', color: S700,
                      fontWeight: 800, fontSize: '0.86rem', cursor: 'pointer',
                    }}
                  >Clear &amp; re-enter</button>
                  <button
                    type="button"
                    onClick={() => {
                      // Persist acknowledgement into form_data so it survives save/reload
                      const existing = Array.isArray(fd.km_review_flags) ? fd.km_review_flags : [];
                      const newFlag = {
                        field: kmConfirm.kmKey,
                        prev_field: kmConfirm.previousKey,
                        delta: kmConfirm.delta,
                        acknowledged: true,
                        timestamp: new Date().toISOString(),
                      };
                      sf('km_review_flags', [...existing, newFlag]);
                      close();
                    }}`;

if (content.match(regex)) {
  content = content.replace(regex, replacement);
  fs.writeFileSync('frontend/src/pages/crew/DigitalPRFForm.tsx', content);
  console.log('Fixed syntax error!');
} else {
  console.log('Could not find match');
  const index = content.indexOf('Difference</span>');
  console.log(content.substring(index, index + 300));
}
