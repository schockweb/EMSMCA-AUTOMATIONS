const fs = require('fs');
let content = fs.readFileSync('frontend/src/pages/crew/DigitalPRFForm.tsx', 'utf8');

function normalize(str) { return str.replace(/\r\n/g, '\n'); }
content = normalize(content);

// Fix 1: Unhide the assessment chip in the clinical section for RESUS
const badChip = `        {/* Assessment level chip \u2014 shown once picked, tap to re-open modal.
            Never shown for RESUS or DOD. */}
        {fd.call_type !== 'RESUS' && fd.call_type !== 'DOD' && fd.assessment_level && (`;

const goodChip = `        {/* Assessment level chip \u2014 shown once picked, tap to re-open modal.
            Never shown for DOD. */}
        {fd.call_type !== 'DOD' && fd.assessment_level && (`;

const badPrompt = `        {/* Prompt to pick assessment if not yet chosen.
            Never shown for RESUS or DOD. */}
        {fd.call_type !== 'RESUS' && fd.call_type !== 'DOD' && !fd.assessment_level && fd.treating_practitioner_name && (`;

const goodPrompt = `        {/* Prompt to pick assessment if not yet chosen.
            Never shown for DOD. */}
        {fd.call_type !== 'DOD' && !fd.assessment_level && fd.treating_practitioner_name && (`;


// Fix 2: Filter out BLS from Assessment Modal if call_type === RESUS
const badAssessModal = `        {assessmentModalOpen && (() => {
          const LEVELS = ['BLS', 'ILS', 'ALS'] as const;`;

const goodAssessModal = `        {assessmentModalOpen && (() => {
          const LEVELS = fd.call_type === 'RESUS' ? (['ILS', 'ALS'] as const) : (['BLS', 'ILS', 'ALS'] as const);`;

// Fix 3: Filter out BLS from Monitoring Modal if call_type === RESUS
const badMonitorModal = `        {monitoringModalOpen && (() => {
          const LEVELS = ['BLS', 'ILS', 'ALS'] as const;`;

const goodMonitorModal = `        {monitoringModalOpen && (() => {
          const LEVELS = fd.call_type === 'RESUS' ? (['ILS', 'ALS'] as const) : (['BLS', 'ILS', 'ALS'] as const);`;

let changed = 0;

if (content.includes(badChip)) { content = content.replace(badChip, goodChip); changed++; }
if (content.includes(badPrompt)) { content = content.replace(badPrompt, goodPrompt); changed++; }
if (content.includes(badAssessModal)) { content = content.replace(badAssessModal, goodAssessModal); changed++; }
if (content.includes(badMonitorModal)) { content = content.replace(badMonitorModal, goodMonitorModal); changed++; }

if (changed === 4) {
    fs.writeFileSync('frontend/src/pages/crew/DigitalPRFForm.tsx', content);
    console.log('Fixed RESUS assessment modals and chips!');
} else {
    console.log('Could not find all targets. Changed:', changed);
}
