const fs = require('fs');
let content = fs.readFileSync('frontend/src/pages/crew/DigitalPRFForm.tsx', 'utf8');

function normalize(str) { return str.replace(/\r\n/g, '\n'); }
content = normalize(content);

const bad = `      <Inp fk="med_aid_dec_death_case_no" ph="Case number" />

      {/* For Resus calls the dispatch times already render inside
          the Resus subsection above — skip the duplicate here. */}
      {fd.call_type !== 'RESUS' && <DodDispatchTimesEmbed />}

      <Lbl t="Precise location of body" />`;

const good = `      <Inp fk="med_aid_dec_death_case_no" ph="Case number" />

      <Lbl t="Precise location of body" />`;

if (content.includes(bad)) {
    content = content.replace(bad, good);
    fs.writeFileSync('frontend/src/pages/crew/DigitalPRFForm.tsx', content);
    console.log('Removed duplicate DodDispatchTimesEmbed');
} else {
    console.log('Could not find target');
}
