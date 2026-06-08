const fs = require('fs');
let content = fs.readFileSync('frontend/src/pages/crew/DigitalPRFForm.tsx', 'utf8');

function normalize(str) { return str.replace(/\r\n/g, '\n'); }
content = normalize(content);

// 1. Add the ref
const badRef = `  const onSceneKmRef = useRef<HTMLInputElement>(null);`;
const goodRef = `  const onSceneKmRef = useRef<HTMLInputElement>(null);
  const chiefComplaintRef = useRef<HTMLDivElement>(null);`;

// 2. Wrap the Chief Complaint field
const badField = `        <Card>
          <Lbl t="Chief Complaint / Signs and Symptoms" req /><VoiceTxt fk="chief_complaint" ph="Patient's primary complaint, signs and symptoms..." rows={2} />`;
const goodField = `        <Card>
          <div ref={chiefComplaintRef} style={{ scrollMarginTop: 80 }}>
            <Lbl t="Chief Complaint / Signs and Symptoms" req /><VoiceTxt fk="chief_complaint" ph="Patient's primary complaint, signs and symptoms..." rows={2} />
          </div>`;

// 3. Add scroll on click
const badClick = `                        onClick={() => {
                          sf('assessment_level', lvl);
                          setAssessmentModalOpen(false);
                        }}`;
const goodClick = `                        onClick={() => {
                          sf('assessment_level', lvl);
                          setAssessmentModalOpen(false);
                          setTimeout(() => chiefComplaintRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
                        }}`;

let changed = 0;
if (content.includes(normalize(badRef))) { content = content.replace(normalize(badRef), normalize(goodRef)); changed++; }
if (content.includes(normalize(badField))) { content = content.replace(normalize(badField), normalize(goodField)); changed++; }
if (content.includes(normalize(badClick))) { content = content.replace(normalize(badClick), normalize(goodClick)); changed++; }

if (changed === 3) {
    fs.writeFileSync('frontend/src/pages/crew/DigitalPRFForm.tsx', content);
    console.log('Successfully added snap-to-top for Chief Complaint!');
} else {
    console.log('Failed to find all targets. Changed:', changed);
}
