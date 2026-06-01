const fs = require('fs');
let content = fs.readFileSync('frontend/src/pages/crew/DigitalPRFForm.tsx', 'utf8');

function normalize(str) { return str.replace(/\r\n/g, '\n'); }
content = normalize(content);

// Re-add assessment modal auto-trigger, guarded for DOD
const bad = `              setCrewPicker(null);
            };`;
const good = `              setCrewPicker(null);
              // Auto-open assessment modal — skip for DOD (no assessment needed)
              if (!fd.assessment_level && fd.call_type !== 'DOD') {
                setAssessmentModalOpen(true);
              }
            };`;

if (content.includes(bad)) {
    content = content.replace(bad, good);
    fs.writeFileSync('frontend/src/pages/crew/DigitalPRFForm.tsx', content);
    console.log('Added assessment modal auto-trigger with DOD guard!');
} else {
    console.log('Could not find target');
}
