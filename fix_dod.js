const fs = require('fs');
let content = fs.readFileSync('frontend/src/pages/crew/DigitalPRFForm.tsx', 'utf8');

function normalize(str) { return str.replace(/\r\n/g, '\n'); }
content = normalize(content);

// Fix 1: remove pink bg from DOD expanded panel, add CTA inside it
const bad1 = `          {/* Expanded form body */}
          {fd.med_aid_dec_death && (
            <div style={{
              border: \`1.5px solid \${S200}\`,
              borderTop: 'none',
              background: 'linear-gradient(180deg, rgba(255,241,242,0.6) 0%, #ffffff 40px)',
              boxShadow: '0 4px 16px rgba(225,29,72,0.08)',
            }}>
              <DodFormBody />
            </div>
          )}`;

const good1 = `          {/* Expanded form body */}
          {fd.med_aid_dec_death && (
            <div style={{
              border: \`1.5px solid \${S200}\`,
              borderTop: 'none',
              borderRadius: '0 0 12px 12px',
              padding: '20px 16px',
              background: W,
              boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
            }}>
              <DodFormBody />
              {/* Patient Information CTA sits at the bottom of the DOD form */}
              <div style={{ marginTop: 20 }}>
                {CTA({ label: 'Patient Information  \u2192', onClick: () => advancePhase(2) })}
              </div>
            </div>
          )}`;

// Fix 2: change top-level Patient Info CTA condition - remove med_aid_dec_death, skip DOD
const bad2 = `      {/* Patient Information CTA \u2014 intercept to collect monitoring level first */}
      {(fd.med_aid_dec_death || !!fd.chief_complaint) && (
        CTA({
          label: "Patient Information  \u2192",
          onClick: () => {
            // If monitoring not yet set, collect it before advancing
            if (!fd.monitoring_level) {
              setMonitoringModalOpen(true);
            } else {
              advancePhase(2);
            }
          }
        })
      )}`;

const good2 = `      {/* Patient Information CTA \u2014 DOD shows CTA inside its own form body */}
      {!!fd.chief_complaint && fd.call_type !== 'DOD' && (
        CTA({
          label: "Patient Information  \u2192",
          onClick: () => {
            if (!fd.monitoring_level) {
              setMonitoringModalOpen(true);
            } else {
              advancePhase(2);
            }
          }
        })
      )}`;

let changed = 0;
if (content.includes(normalize(bad1))) {
    content = content.replace(normalize(bad1), normalize(good1));
    console.log('Fixed DOD panel background and added CTA inside');
    changed++;
} else {
    console.log('Could not find bad1');
}

if (content.includes(normalize(bad2))) {
    content = content.replace(normalize(bad2), normalize(good2));
    console.log('Fixed top-level CTA condition');
    changed++;
} else {
    console.log('Could not find bad2');
}

if (changed > 0) {
    fs.writeFileSync('frontend/src/pages/crew/DigitalPRFForm.tsx', content);
    console.log('Done! Wrote file.');
}
