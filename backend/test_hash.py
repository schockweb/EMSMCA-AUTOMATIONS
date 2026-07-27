import bcrypt
import os
SEED_ADMIN_PASSWORD = os.getenv("SEED_ADMIN_PASSWORD", "DevSeed!Change#2026")  # burned value removed

result = bcrypt.checkpw(bSEED_ADMIN_PASSWORD, b"$2b$12$6.PgY66Zr7FDEcTkuQwrQuqZIxnK5MlTVX0NPlamz8sB.XGsDwyLK")
print("Matches?", result)
