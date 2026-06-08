const fs = require('fs');
const file = 'frontend/src/pages/crew/DigitalPRFForm.tsx';
let content = fs.readFileSync(file, 'utf8');

content = content.replace("id: \\`crew\\${i + 3}\\`, tag: \\`Crew \\${i + 3}\\`,", "id: `crew${i + 3}`, tag: `Crew ${i + 3}`,");

fs.writeFileSync(file, content);
console.log('Fixed syntax error!');
