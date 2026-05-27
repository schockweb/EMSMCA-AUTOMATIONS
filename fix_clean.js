const fs = require('fs');

let content = fs.readFileSync('frontend/src/pages/Cases.tsx', 'utf-8');

// Fix syntax error
content = content.replace(/handleNavigationToReview\(e, c\.document_id\)\} = \/review\/\$\{c\.document_id\}; \}\}/g, 
  "handleNavigationToReview(e, c.document_id)}");

// Fix unicode mangling for the badges
content = content.replace(/s' RFI/g, "? RFI");
content = content.replace(/o" Clean/g, "? Clean");
content = content.replace(/\? RFI/g, "? RFI");

// Ensure the onClick is actually on the badge where the user expects it (Adjudication column)
// Look for ? RFI badge display code...
content = content.replace(/<span style=\{\{\s*fontSize: '0\.72rem', fontWeight: 700, padding: '4px 10px', borderRadius: 99,/g,
  '<span onClick={(e) => handleNavigationToReview(e, c.document_id)} style={{ cursor: "pointer", fontSize: "0.72rem", fontWeight: 700, padding: "4px 10px", borderRadius: 99,');

fs.writeFileSync('frontend/src/pages/Cases.tsx', content, 'utf-8');
console.log("Fixed!");
