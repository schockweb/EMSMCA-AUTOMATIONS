import re

filepath = r"c:\Users\USER-PC\Desktop\New EMS AUTOMATIONS\frontend\src\pages\crew\DigitalPRFForm.tsx"

with open(filepath, "r", encoding="utf-8") as f:
    content = f.read()

# TimeTable usages
content = re.sub(r'<TimeTable rows={([^}]+)} />', r'{TimeTable({ rows: \1 })}', content)

# TimeRow usages
content = re.sub(r'<TimeRow key={([^}]+)} row={([^}]+)} />', r'<div key={\1}>{TimeRow({ row: \2 })}</div>', content)

# CriticalBanner
content = content.replace('<CriticalBanner />', '{CriticalBanner()}')

# AllergyBanner
content = content.replace('<AllergyBanner />', '{AllergyBanner()}')

# CTA
content = re.sub(r'<CTA label="([^"]+)" onClick={([^}]+)} />', r'{CTA({ label: "\1", onClick: \2 })}', content)
content = re.sub(r'<CTA label="([^"]+)" color={([^}]+)} onClick={([^}]+)} />', r'{CTA({ label: "\1", color: \2, onClick: \3 })}', content)
content = re.sub(r'<CTA label="([^"]+)" color="([^"]+)" onClick={([^}]+)} />', r'{CTA({ label: "\1", color: "\2", onClick: \3 })}', content)

with open(filepath, "w", encoding="utf-8") as f:
    f.write(content)

print("Refactor 2 complete")
