"""
Create the first administrator on a new instance.

The password is supplied by the operator — it is never hardcoded here.

WHY THIS CHANGED (2026-07-30)
-----------------------------
This script used to create `admin@emsclaims.co.za` with the plaintext password
`Admin@2026!` baked into the source. That is the same failure that burned the
seed password: the repository was public from 2026-05-27 to 2026-07-27, so the
value is permanently compromised. Worse, the client-VM install guide tells the
operator to run this script — so every client instance would have come up with a
full-access administrator whose password is published on the internet.

It also created the account as ADMIN with `permissions=None`. The first account
on a new instance should be SUPER_ADMIN: `require_role` treats SUPER_ADMIN as
satisfying every check, and some routes (notably `DELETE /api/cases/all`) are
SUPER_ADMIN-only, so an ADMIN-only first account cannot fully administer the box.

USAGE
-----
    python create_admin.py --email admin@client.co.za

    # Non-interactive (CI / automated install):
    ADMIN_PASSWORD='...' python create_admin.py --email admin@client.co.za --from-env

The password is read from a hidden prompt by default and is never echoed,
logged, or printed back.
"""
from __future__ import annotations

import argparse
import asyncio
import getpass
import os
import sys

from sqlalchemy import select

from app.database import AsyncSessionLocal
from app.models.user import User, UserRole
from app.utils.security import hash_password, validate_password_complexity

# Values that must never be accepted, regardless of complexity rules. Both were
# published while the repository was public and are permanently burned.
_BURNED_PASSWORDS = {
    "Admin@2026!",
    "DevSeed!Change#2026",
}


def _read_password(from_env: bool) -> str:
    if from_env:
        password = os.getenv("ADMIN_PASSWORD", "")
        if not password:
            print("ERROR: --from-env given but ADMIN_PASSWORD is not set.", file=sys.stderr)
            raise SystemExit(2)
        return password

    if not sys.stdin.isatty():
        print(
            "ERROR: no terminal available for a password prompt. "
            "Use --from-env with ADMIN_PASSWORD set.",
            file=sys.stderr,
        )
        raise SystemExit(2)

    password = getpass.getpass("Password for the new administrator: ")
    confirm = getpass.getpass("Confirm password: ")
    if password != confirm:
        print("ERROR: passwords do not match.", file=sys.stderr)
        raise SystemExit(2)
    return password


def _validate(password: str) -> None:
    if password in _BURNED_PASSWORDS:
        print(
            "ERROR: that password was published while this repository was public "
            "and can never be used again. Choose a different one.",
            file=sys.stderr,
        )
        raise SystemExit(2)
    try:
        validate_password_complexity(password)
    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(2)


async def create_admin(email: str, password: str, role: UserRole, full_name: str) -> int:
    async with AsyncSessionLocal() as db:
        existing = (await db.execute(select(User).where(User.email == email))).scalar_one_or_none()
        if existing:
            print(f"A user with email {email} already exists — nothing created.")
            print("To change its password use: python rotate_admin_password.py")
            return 1

        db.add(User(
            email=email,
            hashed_password=hash_password(password),
            full_name=full_name,
            role=role,
            is_active=True,
            permissions=None,  # None = every permission key
        ))
        await db.commit()

    print(f"Created {role.value}: {email}")
    print("Store the password in a password manager now — it is not recoverable.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Create the first administrator.")
    parser.add_argument("--email", required=True, help="login email for the new administrator")
    parser.add_argument("--name", default="System Administrator", help="full name")
    parser.add_argument(
        "--from-env",
        action="store_true",
        help="read the password from ADMIN_PASSWORD instead of prompting",
    )
    parser.add_argument(
        "--role",
        choices=["super_admin", "admin"],
        default="super_admin",
        help="role for the new account (default: super_admin)",
    )
    args = parser.parse_args()

    email = args.email.strip().lower()
    if "@" not in email:
        print(f"ERROR: {email!r} is not a valid email address.", file=sys.stderr)
        return 2

    password = _read_password(args.from_env)
    _validate(password)

    role = UserRole.SUPER_ADMIN if args.role == "super_admin" else UserRole.ADMIN
    return asyncio.run(create_admin(email, password, role, args.name))


if __name__ == "__main__":
    raise SystemExit(main())
