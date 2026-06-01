import os
import re

app_dir = "app"

for root, dirs, files in os.walk(app_dir):
    # Skip models directory since we fixed it with Union already
    if "models" in root:
        continue
    for filename in files:
        if filename.endswith(".py"):
            filepath = os.path.join(root, filename)
            with open(filepath, "r", encoding="utf-8") as f:
                content = f.read()
            
            # Check if from __future__ import annotations is already there
            if "from __future__ import annotations" not in content:
                lines = content.splitlines(keepends=True)
                insert_idx = 0
                if lines and lines[0].startswith('"""'):
                    for idx, line in enumerate(lines[1:], 1):
                        if '"""' in line:
                            insert_idx = idx + 1
                            break
                lines.insert(insert_idx, "from __future__ import annotations\n")
                new_content = "".join(lines)
                
                with open(filepath, "w", encoding="utf-8") as f:
                    f.write(new_content)
                print(f"Added future annotations to {filepath}")
