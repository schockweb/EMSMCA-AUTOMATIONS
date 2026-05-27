import os
import re

models_dir = r"c:\Users\USER-PC\Desktop\New EMS AUTOMATIONS\backend\app\models"

for filename in os.listdir(models_dir):
    if filename.endswith(".py"):
        filepath = os.path.join(models_dir, filename)
        with open(filepath, "r", encoding="utf-8") as f:
            content = f.read()
        
        # Replace JSONB with JSON in imports and usage
        # This is a bit risky but we'll try to be specific
        new_content = content.replace("from sqlalchemy.dialects.postgresql import UUID, JSONB", "from sqlalchemy import UUID, JSON as JSONB")
        new_content = new_content.replace("from sqlalchemy.dialects.postgresql import UUID, JSONB, INET", "from sqlalchemy import UUID, JSON as JSONB")
        
        if new_content != content:
            with open(filepath, "w", encoding="utf-8") as f:
                f.write(new_content)
            print(f"Updated {filename}")
