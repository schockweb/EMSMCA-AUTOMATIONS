with open('frontend/src/pages/Cases.tsx', 'r', encoding='utf-8') as f:
    lines = f.readlines()

for i in range(len(lines)):
    if "? RFI" in lines[i]:
        lines[i] = lines[i].replace("? RFI", "? RFI")
    if "V Clean" in lines[i]:
        lines[i] = lines[i].replace("V Clean", "? Clean")
    if "s' RFI" in lines[i]:
        lines[i] = lines[i].replace("s' RFI", "? RFI")
    if "o\" Clean" in lines[i]:
        lines[i] = lines[i].replace("o\" Clean", "? Clean")

with open('frontend/src/pages/Cases.tsx', 'w', encoding='utf-8') as f:
    f.writelines(lines)
print("Unicode flags fixed")
