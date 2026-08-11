"""
Rotate an admin user's password (INTERACTIVE — run it yourself in your own terminal).

The new password is typed by YOU at a hidden prompt and is never printed, never
logged, and never passed on a command line (so it can't leak into shell history
or the process list).

    ssh -i ~/.ssh/ems_vm azureuser@102.37.216.162 \
      -t "sudo docker exec -it ems_backend python rotate_admin_password.py"

On success it also clears any lockout counters and stamps password_changed_at.
"""
from __future__ import annotations
import asyncio
import getpass
import sys

from sqlalchemy import text

from app.database import AsyncSessionLocal
from app.utils.security import hash_password


MIN_LEN = 12


def _complexity_problems(pw: str) -> list[str]:
    problems = []
    if len(pw) < MIN_LEN:
        problems.append(f"must be at least {MIN_LEN} characters")
    if not any(c.islower() for c in pw):
        problems.append("needs a lowercase letter")
    if not any(c.isupper() for c in pw):
        problems.append("needs an uppercase letter")
    if not any(c.isdigit() for c in pw):
        problems.append("needs a digit")
    if not any(not c.isalnum() for c in pw):
        problems.append("needs a symbol")
    if pw.strip() != pw:
        problems.append("must not start or end with a space")
    return problems


# Anything that ever appeared in the repository is burned — refuse it outright.
BURNED = {"admin@2024!", "admin@2024", "password", "changeme"}


async def main() -> int:
    async with AsyncSessionLocal() as db:
        rows = (await db.execute(
            text("SELECT id, email, role FROM users ORDER BY created_at")
        )).mappings().all()

    if not rows:
        print("No user accounts found.")
        return 1

    print("\nAdmin accounts:")
    for i, r in enumerate(rows, 1):
        print(f"  [{i}] {r['email']}   role={r['role']}")

    if len(rows) == 1:
        target = rows[0]
        print(f"\nRotating the only account: {target['email']}")
    else:
        choice = input("\nWhich number to rotate? ").strip()
        if not choice.isdigit() or not (1 <= int(choice) <= len(rows)):
            print("Cancelled — invalid choice.")
            return 1
        target = rows[int(choice) - 1]

    pw1 = getpass.getpass("New password (hidden): ")
    pw2 = getpass.getpass("Confirm new password: ")

    if pw1 != pw2:
        print("Cancelled — the two entries did not match.")
        return 1
    if pw1.lower() in BURNED:
        print("Cancelled — that password was exposed in the repository. Choose a new one.")
        return 1
    problems = _complexity_problems(pw1)
    if problems:
        print("Cancelled — password " + "; ".join(problems) + ".")
        return 1

    new_hash = hash_password(pw1)
    del pw1, pw2

    async with AsyncSessionLocal() as db:
        await db.execute(
            text("""
                UPDATE users
                   SET hashed_password      = :h,
                       failed_login_attempts = 0,
                       locked_until          = NULL,
                       password_changed_at   = NOW()
                 WHERE id = :uid
            """),
            {"h": new_hash, "uid": target["id"]},
        )
        await db.commit()

    print(f"\nDone — password rotated for {target['email']}.")
    print("Existing sessions keep working until their token expires (60 min).")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        print("\nCancelled.")
        sys.exit(1)
