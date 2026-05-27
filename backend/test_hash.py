import bcrypt
result = bcrypt.checkpw(b"Admin@2024!", b"$2b$12$6.PgY66Zr7FDEcTkuQwrQuqZIxnK5MlTVX0NPlamz8sB.XGsDwyLK")
print("Matches?", result)
