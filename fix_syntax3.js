const fs = require('fs');
let content = fs.readFileSync('frontend/src/pages/crew/DigitalPRFForm.tsx', 'utf8');

const badChunk = `        )}
        )}

        {/* ── Assessment Level Modal`;

const goodChunk = `        )}

        {/* ── Assessment Level Modal`;

// Handle CRLF differences
function normalize(str) {
    return str.replace(/\r\n/g, '\n');
}

let contentNorm = normalize(content);
const badChunkNorm = normalize(badChunk);

if (contentNorm.includes(badChunkNorm)) {
    contentNorm = contentNorm.replace(badChunkNorm, normalize(goodChunk));
    fs.writeFileSync('frontend/src/pages/crew/DigitalPRFForm.tsx', contentNorm);
    console.log('Fixed syntax error!');
} else {
    console.log('Could not find bad chunk');
}
