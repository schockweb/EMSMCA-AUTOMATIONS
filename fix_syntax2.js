const fs = require('fs');
let content = fs.readFileSync('frontend/src/pages/crew/DigitalPRFForm.tsx', 'utf8');

// The regex will look for the line with `sf('km_review_flags', [...existing, newFlag]);`
// followed by `close();` and `}}` and `</ul>` up to `crewPicker && crewPicker.phase === 'select'`
const regex = /(sf\('km_review_flags',\s*\[\.\.\.existing,\s*newFlag\]\);\s+close\(\);\s+\}\})([\s\S]*?)({\/\*\s*── Crew picker overlay)/;

const match = content.match(regex);
if (match) {
    const replacement = `sf('km_review_flags', [...existing, newFlag]);
                      close();
                    }}
                    style={{
                      flex: 1, padding: 12, borderRadius: 10,
                      border: 'none',
                      background: \`linear-gradient(135deg, \${G}, \${GDK})\`,
                      color: '#fff',
                      fontWeight: 800, fontSize: '0.86rem', cursor: 'pointer',
                    }}
                  >Yes, it's correct</button>
                </div>
              </div>
            </div>
          );
        })()}

        {/* ── Crew picker overlay`;

    content = content.replace(regex, replacement);
    fs.writeFileSync('frontend/src/pages/crew/DigitalPRFForm.tsx', content);
    console.log('Fixed syntax error with regex!');
} else {
    console.log('Regex did not match the damaged block.');
}
