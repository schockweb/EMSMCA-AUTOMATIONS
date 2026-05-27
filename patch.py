import re

with open('frontend/src/pages/Cases.tsx', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Add useNavigate import
if 'useNavigate' not in content:
    content = content.replace("import { useState, useEffect } from 'react';", "import { useState, useEffect } from 'react';\nimport { useNavigate } from 'react-router-dom';")

# 2. Add navigate to the component
if 'const navigate = useNavigate();' not in content:
    content = content.replace("export default function Cases() {\n", "export default function Cases() {\n  const navigate = useNavigate();\n")

# 3. Replace the RFI badge onclick
new_badge_onclick = "onClick={(e) => { e.stopPropagation(); if (c.document_id) { navigate('/review/' + c.document_id, { state: { flaggedFields: ['adjudication_status'] } }); } }}"
content = re.sub(
    r"onClick=\{\(\) => \{ if \(c\.document_id\) window\.location\.href = /review/\$\{c\.document_id\}; \}\}",
    new_badge_onclick,
    content
)

# 4. Replace Document Click
new_doc_onclick = "onClick={(e) => { e.stopPropagation(); if (c.document_id) { navigate('/review/' + c.document_id); } else { alert('Associated document not found.'); } }}"
content = re.sub(
    r"onClick=\{\(\) => \{ if \(c\.document_id\) window\.location\.href = /review/\$\{c\.document_id\}; else alert\(\"Associated document not found\.\"\); \}\}",
    new_doc_onclick,
    content
)

# 5. Replace Update Claim Data button
new_update_onclick = "onClick={(e) => { e.stopPropagation(); const dId = result.rfis_generated[0]?.document_id || ''; if (dId) { navigate('/review/' + dId, { state: { flaggedFields: ['adjudication_status'] } }); } }}"
content = re.sub(
    r"onClick=\{\(\) => \{ window\.location\.href = /review/\$\{result\.rfis_generated\[0\]\?\.document_id \|\| \'\'\}; \}\}",
    new_update_onclick,
    content
)

# 6. Replace specific field reason code navigate (line 1347)
new_field_onclick = '''onClick={(e) => {
                          e.stopPropagation();
                          const field = FIELD_KEY_MAP[r.missing_fields ? Object.keys(r.missing_fields)[0] : ''] || '';
                          navigate(/review/?highlight=);
                        }}'''
content = re.sub(
    r"onClick=\{\(e\) => \{[\s\S]*?window\.location\.href = /review/\$\{r\.document_id\}\?highlight=\$\{field \|\| r\.reason_code\};[\s\S]*?\}\}",
    new_field_onclick,
    content
)

with open('frontend/src/pages/Cases.tsx', 'w', encoding='utf-8') as f:
    f.write(content)
print("Patched!")
