const fs = require('fs');
let content = fs.readFileSync('frontend/src/pages/crew/DigitalPRFForm.tsx', 'utf8');

const regex = /\n[ \t]*\)\}\n\r[ \t]*\)\}\n\n[ \t]*\{\/\* ── Assessment Level Mod/;
const replacement = `\n        )}\n\n        {/* ── Assessment Level Mod`;

if (content.match(regex)) {
    content = content.replace(regex, replacement);
    fs.writeFileSync('frontend/src/pages/crew/DigitalPRFForm.tsx', content);
    console.log('Fixed syntax error!');
} else {
    console.log('Could not find bad chunk');
}
