with open('frontend/src/pages/Cases.tsx', 'r', encoding='utf-8') as f:
    lines = f.readlines()

for i in range(len(lines)):
    if "= /review/\\; }}" in lines[i]:
        lines[i] = lines[i].replace("= /review/; }}", "")

with open('frontend/src/pages/Cases.tsx', 'w', encoding='utf-8') as f:
    f.writelines(lines)
print("Syntax fixed")
