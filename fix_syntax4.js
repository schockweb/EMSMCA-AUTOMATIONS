const fs = require('fs');
let content = fs.readFileSync('frontend/src/pages/crew/DigitalPRFForm.tsx', 'utf8');

const regex = /([ \t]*\)\}\r?\n)([ \t]*\)\}\r?\n)(\s*\{\/\* ── Assessment Level Modal)/;

if (content.match(regex)) {
    content = content.replace(regex, '$1$3');
    fs.writeFileSync('frontend/src/pages/crew/DigitalPRFForm.tsx', content);
    console.log('Fixed syntax error!');
} else {
    console.log('Could not find bad chunk');
}
