const fs = require('fs');
let content = fs.readFileSync('frontend/src/pages/crew/DigitalPRFForm.tsx', 'utf8');
const badStart = content.indexOf('                      close();\n                    }\n                  </ul>');
if (badStart !== -1) {
    const endStr = "        {crewPicker && crewPicker.phase === 'select' && (() => {";
    const badEnd = content.indexOf(endStr, badStart);
    if (badEnd !== -1) {
        const replacement = `                      close();
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

        {/* ── Crew picker overlay ─────────────────────────────────────────────
           Opens for one of three flows:
             • IV Line  — pick administrator, then sign to confirm.
             • Medication — pick administrator, then sign to confirm.
             • Treating practitioner gate — pick who is treating the patient
               on entering the Clinical phase. Single-step; writes directly
               to \`fd.treating_practitioner_*\` for the scope-enforcement
               engine. No signing step (the act of picking is the audit).
           For IV / Medication, cancelling the signature returns to
           crew-select so the wrong crew member can be swapped without
           losing the overlay. ──────────────────────────────────────────── */}
`;
        content = content.substring(0, badStart) + replacement + content.substring(badEnd);
        fs.writeFileSync('frontend/src/pages/crew/DigitalPRFForm.tsx', content);
        console.log('Fixed syntax error!');
    } else { console.log('Could not find end of bad block'); }
} else { 
    // Try matching a different number of spaces or just 'close();'
    const closeIndex = content.indexOf("sf('km_review_flags', [...existing, newFlag]);\n                      close();\n                    }}\n                  </ul>");
    if (closeIndex !== -1) {
        const badStart2 = content.indexOf('                      close();\n                    }}\n                  </ul>');
        const endStr = "        {crewPicker && crewPicker.phase === 'select' && (() => {";
        const badEnd2 = content.indexOf(endStr, badStart2);
        if (badEnd2 !== -1) {
            const replacement = `                      close();
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

        {/* ── Crew picker overlay ─────────────────────────────────────────────
           Opens for one of three flows:
             • IV Line  — pick administrator, then sign to confirm.
             • Medication — pick administrator, then sign to confirm.
             • Treating practitioner gate — pick who is treating the patient
               on entering the Clinical phase. Single-step; writes directly
               to \`fd.treating_practitioner_*\` for the scope-enforcement
               engine. No signing step (the act of picking is the audit).
           For IV / Medication, cancelling the signature returns to
           crew-select so the wrong crew member can be swapped without
           losing the overlay. ──────────────────────────────────────────── */}
`;
            content = content.substring(0, badStart2) + replacement + content.substring(badEnd2);
            fs.writeFileSync('frontend/src/pages/crew/DigitalPRFForm.tsx', content);
            console.log('Fixed syntax error (fallback match)!');
        } else { console.log('Could not find end of bad block in fallback'); }
    } else {
        console.log('Could not find bad start block (fallback)'); 
    }
}
