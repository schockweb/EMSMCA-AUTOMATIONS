import os

models_dir = r"c:\Users\USER-PC\Desktop\New EMS AUTOMATIONS\backend\app\models"

for filename in os.listdir(models_dir):
    if filename.endswith(".py"):
        filepath = os.path.join(models_dir, filename)
        with open(filepath, "r", encoding="utf-8") as f:
            content = f.read()
        
        # Replace back to PostgreSQL JSONB
        new_content = content.replace("from sqlalchemy import UUID, JSON as JSONB", "from sqlalchemy.dialects.postgresql import UUID, JSONB")
        
        # In audit log we might need to restore INET
        if filename == "audit_log.py" and "from sqlalchemy.dialects.postgresql import UUID, JSONB" in new_content:
            new_content = new_content.replace(
                "from sqlalchemy.dialects.postgresql import UUID, JSONB", 
                "from sqlalchemy.dialects.postgresql import UUID, JSONB, INET"
            )
        
        if new_content != content:
            with open(filepath, "w", encoding="utf-8") as f:
                f.write(new_content)
            print(f"Reverted {filename}")
