const fs = require('fs');
let content = fs.readFileSync('frontend/src/pages/crew/DigitalPRFForm.tsx', 'utf8');

// The file uses CRLF line endings - match exact bytes
const oldCode = `onPick={(type) => {\r\n        if (type === 'PRIMARY') {\r\n          setDispatchPromptOpen(true);\r\n          // Wait briefly for the modal to render before focusing the input\r\n          window.setTimeout(() => dispatchKmRef.current?.focus(), 50);\r\n        } else if (type === 'RHT') {\r\n          setRhtCallOutFeeOpen(true);\r\n        }\r\n      }}`;

const newCode = `onPick={(type) => {\r\n        if (type === 'PRIMARY' || type === 'RESUS' || type === 'COURTESY' || type === 'DOD') {\r\n          setDispatchPromptOpen(true);\r\n          // Wait briefly for the modal to render before focusing the input\r\n          window.setTimeout(() => dispatchKmRef.current?.focus(), 50);\r\n        } else if (type === 'RHT') {\r\n          setRhtCallOutFeeOpen(true);\r\n        }\r\n      }}`;

if (content.includes(oldCode)) {
  content = content.replace(oldCode, newCode);
  fs.writeFileSync('frontend/src/pages/crew/DigitalPRFForm.tsx', content);
  console.log('SUCCESS: onPick updated for RESUS, COURTESY, DOD');
} else {
  console.log('ERROR: Could not find target code even with CRLF');
}
