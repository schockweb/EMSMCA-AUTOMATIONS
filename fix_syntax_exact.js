const fs = require('fs');
let content = fs.readFileSync('frontend/src/pages/crew/DigitalPRFForm.tsx', 'utf8');

const badChunk = `                    <span style={{ color: S600, fontSize: '0.74rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Difference</span>
                    <span style={{
                        delta: kmConfirm.delta,
                        acknowledged: true,
                        timestamp: new Date().toISOString(),
                      };
                      sf('km_review_flags', [...existing, newFlag]);
                      close();
                    }}`;

const goodChunk = `                    <span style={{ color: S600, fontSize: '0.74rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Difference</span>
                    <span style={{
                      fontFamily: 'monospace', fontWeight: 800,
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

// Because of CRLF line endings, we need to normalize line endings for matching
function normalize(str) {
    return str.replace(/\r\n/g, '\n');
}

let contentNorm = normalize(content);
const badChunkNorm = normalize(badChunk);

if (contentNorm.includes(badChunkNorm)) {
    contentNorm = contentNorm.replace(badChunkNorm, normalize(goodChunk));
    fs.writeFileSync('frontend/src/pages/crew/DigitalPRFForm.tsx', contentNorm);
    console.log('Fixed syntax error!');
} else {
    console.log('Could not find bad chunk');
}
