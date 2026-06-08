const fs = require('fs');
const file = 'frontend/src/pages/crew/DigitalPRFForm.tsx';
let content = fs.readFileSync(file, 'utf8');

// 1. Replace 'Bleeding' with 'Profuse Bleeding', 'Fluid Resuscitation'
content = content.replace(
`              'CPR', 'Bleeding',`,
`              'CPR', 'Profuse Bleeding', 'Fluid Resuscitation',`
);

content = content.replace(
`            {inArr('circulation_interventions', 'Bleeding') && (`,
`            {(inArr('circulation_interventions', 'Bleeding') || inArr('circulation_interventions', 'Profuse Bleeding')) && (`
);

// 2. Extract IV Therapy & Medication section
const ivStartStr = `<SHdr t="IV Therapy" />`;
const ivEndStr = `<button type="button" onClick={() => setCrewPicker({ phase: 'select', kind: 'med' })} style={{ width: '100%', padding: 12, borderRadius: 10, fontWeight: 800, fontSize: '0.88rem', border: \`2px dashed \${G}\`, background: GBG, color: GDK, cursor: 'pointer', marginBottom: 20 }}>+ Add Medication</button>`;

const startIndex = content.indexOf(ivStartStr);
const endIndex = content.indexOf(ivEndStr) + ivEndStr.length;

if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
  console.log("Could not find IV Therapy block.");
  process.exit(1);
}

const ivBlock = content.slice(startIndex, endIndex);

// Modify the "+ Add IV Line" button logic in the extracted block
let modifiedIvBlock = ivBlock.replace(
`          const cat = normaliseHpcsaCategory(fd.treating_practitioner_category);
          const canIv = !cat || isAuthorised(cat, 'circ_iv_cannulation_limbs_over_1yr');
          if (!canIv) return null;`,
`          const cat = normaliseHpcsaCategory(fd.treating_practitioner_category);
          const canIv = !cat || isAuthorised(cat, 'circ_iv_cannulation_limbs_over_1yr');
          if (!canIv) return null;

          if (fd.call_type === 'PRIMARY') {
            const hasIndication = inArr('circulation_interventions', 'Profuse Bleeding') || inArr('circulation_interventions', 'Fluid Resuscitation');
            if (!hasIndication) return null;
          }`
);

// Now wrap it in a function definition
const functionDef = `
  const IvAndMedsSection = () => (
    <>
      ${modifiedIvBlock}
    </>
  );
`;

// Remove the block from its original location and replace with the function call
content = content.slice(0, startIndex) + `{IvAndMedsSection()}` + content.slice(endIndex);

// Inject the function definition right before `const P3 = ...`
const p3Marker = `  // ── Phase 3: CLINICAL (assessment & treatment on scene) ───────────────────`;
content = content.replace(p3Marker, functionDef + '\n' + p3Marker);

// 3. In P4, add the checkbox and conditional rendering
const p4DepartureEndStr = `          {/* Vitals trend — last 3 sets side by side */}`;
const checkboxInjection = `
          <div style={{ marginTop: 20, marginBottom: 20 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer', padding: '14px 16px', background: W, border: \`1.5px solid \${S200}\`, borderRadius: 12 }}>
              <input 
                type="checkbox" 
                checked={!!fd.medication_administered_on_route}
                onChange={e => sf('medication_administered_on_route', e.target.checked)}
                style={{ width: 22, height: 22, accentColor: S700, cursor: 'pointer' }}
              />
              <span style={{ fontWeight: 700, fontSize: '0.9rem', color: S900 }}>Medication / IV Administered On Route</span>
            </label>
          </div>
          {fd.medication_administered_on_route && IvAndMedsSection()}
`;

content = content.replace(p4DepartureEndStr, checkboxInjection + '\n' + p4DepartureEndStr);

fs.writeFileSync(file, content);
console.log("Refactoring complete.");
