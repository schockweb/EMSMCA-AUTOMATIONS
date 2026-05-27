const fs = require('fs');

let content = fs.readFileSync('frontend/src/pages/Cases.tsx', 'utf-8');

// 1. Add navigate to the component
if (!content.includes('useNavigate')) {
    content = content.replace("import { useState, useEffect } from 'react';", "import { useState, useEffect } from 'react';\nimport { useNavigate } from 'react-router-dom';");
}
if (!content.includes('const navigate = useNavigate();')) {
    content = content.replace('export default function Cases() {', 'export default function Cases() {\n  const navigate = useNavigate();\n');
}

// 2. Add handleNavigationToReview helper function
if (!content.includes('const handleNavigationToReview')) {
    content = content.replace('const [searchTerm, setSearchTerm] = useState(\'\');', 
    'const [searchTerm, setSearchTerm] = useState(\'\');\n' +
    '  const handleNavigationToReview = async (e: React.MouseEvent, docId?: string) => {\n' +
    '    if (e) e.stopPropagation();\n' +
    '    if (!docId) {\n' +
    '      alert("Associated document not found.");\n' +
    '      return;\n' +
    '    }\n' +
    '    navigate("/review/" + docId, { state: { flaggedFields: ["adjudication_status"] } });\n' +
    '  };\n');
}

// 3. Fix the standalone SVG Action Required icon
content = content.replace(/<span title="Action Required" onClick=\{.*?window\.location\.href.*?/g, 
  '<span title="Action Required" onClick={(e) => handleNavigationToReview(e, c.document_id)}');

// 4. Fix the Prf Display Name click
content = content.replace(/<div style=\{\{ color: 'var\(--text-main\)', fontWeight: 600, cursor: 'pointer' \}\}[\s\n]+onClick=\{.*?window\.location\.href.*?/g, 
  '<div style={{ color: "var(--text-main)", fontWeight: 600, cursor: "pointer" }}\n                      onClick={(e) => handleNavigationToReview(e, c.document_id)}');

// 5. Add onClick and cursor pointer to the Adjudication badge itself!
content = content.replace(/<span style=\{\{[\s\S]*?color: c\.adjudication_status === 'clean'.*?\}\}>[\s\S]*?\{c\.adjudication_status === 'clean'.*?\}/g, (match) => {
    // Inject cursor pointer
    let newMatch = match.replace(/borderRadius: 99,/g, "borderRadius: 99, cursor: 'pointer',");
    // Inject onClick
    newMatch = newMatch.replace(/<span style=\{\{/, '<span onClick={(e) => handleNavigationToReview(e, c.document_id)} style={{');
    return newMatch;
});

// 6. Fix Update Claim Data button
content = content.replace(/onClick=\{\(\) => \{ window\.location\.href = \/review\/\$\{result\.rfis_generated\[0\]\?\.document_id \|\| ''\}; \}\}/g, 
  "onClick={(e) => handleNavigationToReview(e, result.rfis_generated[0]?.document_id)}");

// 7. Fix Navigate to Problem Field sub-action
content = content.replace(/window\.location\.href = \/review\/\$\{r\.document_id\}\?highlight=\$\{field \|\| r\.reason_code\};/g, 
  'navigate(/review/?highlight=);');

fs.writeFileSync('frontend/src/pages/Cases.tsx', content, 'utf-8');
console.log('Successfully patched Cases.tsx');
