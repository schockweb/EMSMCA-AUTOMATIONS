import os
import re

models_dir = "app/models"

for filename in os.listdir(models_dir):
    if filename.endswith(".py"):
        filepath = os.path.join(models_dir, filename)
        with open(filepath, "r", encoding="utf-8") as f:
            content = f.read()
        
        # Regex to find Mapped[<anything> | None] and replace with Mapped[Union[<anything>, None]]
        def repl(match):
            inner = match.group(1)
            # Split by '|' and strip whitespaces
            parts = [p.strip() for p in inner.split("|")]
            # Filter out None and recreate parts list
            has_none = "None" in parts
            clean_parts = [p for p in parts if p != "None"]
            if has_none:
                # e.g., str | None -> Union[str, None]
                # dict | list | None -> Union[dict, list, None]
                union_inner = ", ".join(clean_parts) + ", None"
                return f"Mapped[Union[{union_inner}]]"
            return match.group(0)

        new_content = re.sub(r"Mapped\[([^\]\n]+)\]", repl, content)
        
        if new_content != content:
            # Check if Union is imported from typing
            if "Union" not in new_content:
                if "from typing import" in new_content:
                    new_content = re.sub(
                        r"from typing import ([^\n]+)",
                        r"from typing import Union, \1",
                        new_content
                    )
                else:
                    # Insert after docstring
                    lines = new_content.splitlines(keepends=True)
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
            print(f"Fixed typing in {filename}")
