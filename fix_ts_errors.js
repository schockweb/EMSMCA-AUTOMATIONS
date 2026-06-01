const fs = require('fs');
let content = fs.readFileSync('frontend/src/pages/crew/DigitalPRFForm.tsx', 'utf8');

function normalize(str) { return str.replace(/\r\n/g, '\n'); }
content = normalize(content);

// Remove ICONS from Assessment Modal
content = content.replace(
  normalize(`          type Level = typeof LEVELS[number];
          const ICONS: Record<Level, string> = { BLS: '🟢', ILS: '🟡', ALS: '🔴' };
          const DESC: Record<Level, string> = {`),
  normalize(`          type Level = typeof LEVELS[number];
          const DESC: Record<Level, string> = {`)
);

// Remove ICONS from Monitoring Modal
content = content.replace(
  normalize(`          type Level = typeof LEVELS[number];
          const ICONS: Record<Level, string> = { BLS: '🟢', ILS: '🟡', ALS: '🔴' };
          const DESC: Record<Level, string> = {`),
  normalize(`          type Level = typeof LEVELS[number];
          const DESC: Record<Level, string> = {`)
);

// Remove wouldUpgrade and wouldMismatch from Monitoring Modal mapping
// Wait, wouldMismatch is used! Let's check if it's still used. No, it's not used in the UI anymore, we removed it from the inline span. Wait, wouldMismatch is still needed for something? No, we removed the inline span!
// Wait! isUpgrade and hasMismatch are calculated globally for the warning box.
// But inside the map function: const wouldMismatch = ...; const wouldUpgrade = ...;
content = content.replace(
  normalize(`                    const isOn = fd.monitoring_level === lvl;
                    const lvlRank = RANK[lvl];
                    const wouldMismatch = fd.assessment_level && lvlRank !== assessRank;
                    const wouldUpgrade = wouldMismatch && lvlRank > assessRank;
                    return (`),
  normalize(`                    const isOn = fd.monitoring_level === lvl;
                    return (`)
);

// Fix S500 -> S400 in the warning box
content = content.replace(
  normalize(`<span style={{ fontSize: '1rem', flexShrink: 0, color: S500 }}>{isUpgrade ? '\u2191' : '\u2193'}</span>`),
  normalize(`<span style={{ fontSize: '1rem', flexShrink: 0, color: S400 }}>{isUpgrade ? '\u2191' : '\u2193'}</span>`)
);

fs.writeFileSync('frontend/src/pages/crew/DigitalPRFForm.tsx', content);
console.log('Fixed typescript errors!');
