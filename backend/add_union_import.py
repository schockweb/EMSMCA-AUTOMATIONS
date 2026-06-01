import os
import re

models_dir = "app/models"

for filename in os.listdir(models_dir):
    if filename.endswith(".py"):
        filepath = os.path.join(models_dir, filename)
        with open(filepath, "r", encoding="utf-8") as f:
            content = f.read()
        
        # Check if the file uses Mapped[Union[...]] but does not import Union from typing
        # Let's check if the word Union is imported:
        has_union_import = re.search(r"from typing import.*Union", content) or re.search(r"import typing", content)
        
        if "Union" in content and not has_union_import:
            # We need to import Union!
            if "from typing import" in content:
                # Add Union to existing from typing import ...
                new_content = re.sub(
                    r"from typing import ([^\n]+)",
                    r"from typing import Union, \1",
                    content
                )
            else:
                # Insert from typing import Union
                lines = content.splitlines(keepends=True)
                insert_idx = 0
                if lines and lines[0].startswith('"""'):
                    for idx, line in enumerate(lines[1:], 1):
                        if '"""' in line:
                            insert_idx = idx + 1
                            break
                lines.insert(insert_idx, "from typing import Union\n")
                new_content = "".join(lines)
            
            with open(filepath, "w", encoding="utf-8") as f:
                f.write(new_content)
            print(f"Added Union import to {filename}")
