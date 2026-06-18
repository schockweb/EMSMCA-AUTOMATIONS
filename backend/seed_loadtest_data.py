"""
Seed load-test fixtures: providers, crews, and vehicles.

Creates two (or more) ServiceProviders, a pool of CrewMembers with known
credentials, and one Vehicle per provider — then writes everything to
`loadtest_fixtures.json` for the Locust harness and the correctness checker.

Run from the backend directory so `app.*` imports resolve and the backend `.env`
(DATABASE_URL) is loaded:

    cd backend
    python ../loadtest/seed_loadtest_data.py --providers 2 --crews-per-provider 60

⚠️  This writes real rows to whatever DATABASE_URL points at. Point it at a
    STAGING database, never production. The slugs are prefixed `loadtest-` so
    you can find and delete them afterwards (use --teardown).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import uuid
from pathlib import Path

# Make `app` importable whether run from repo root or backend/
THIS_DIR = Path(__file__).resolve().parent
BACKEND_DIR = THIS_DIR.parent / "backend"
for p in (str(BACKEND_DIR), str(THIS_DIR.parent)):
    if p not in sys.path:
        sys.path.insert(0, p)

from sqlalchemy import select  # noqa: E402
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession  # noqa: E402

from app.config import get_settings  # noqa: E402
from app.models.service_provider import ServiceProvider  # noqa: E402
from app.models.crew_member import CrewMember  # noqa: E402
from app.models.vehicle import Vehicle  # noqa: E402
from app.utils.security import hash_password  # noqa: E402

DEFAULT_PASSWORD = "LoadTest@2026"
OUTPUT_FILE = THIS_DIR / "loadtest_fixtures.json"


def _engine():
    settings = get_settings()
    return create_async_engine(settings.DATABASE_URL, echo=False, pool_pre_ping=True)


async def _get_or_create_provider(db: AsyncSession, slug: str, name: str) -> ServiceProvider:
    res = await db.execute(select(ServiceProvider).where(ServiceProvider.slug == slug))
    provider = res.scalar_one_or_none()
    if provider:
        provider.is_active = True
        return provider
    provider = ServiceProvider(
        name=name, slug=slug, pr_number=f"PR{slug[-4:].upper()}",
        email=f"{slug}@loadtest.test", is_active=True,
    )
    db.add(provider)
    await db.flush()
    return provider


async def _get_or_create_vehicle(db: AsyncSession, provider: ServiceProvider) -> Vehicle:
    res = await db.execute(select(Vehicle).where(Vehicle.provider_id == provider.id).limit(1))
    v = res.scalar_one_or_none()
    if v:
        return v
    v = Vehicle(
        provider_id=provider.id, callsign=f"LT-{provider.slug[-2:].upper()}-1",
        registration=f"LT {provider.slug[-3:].upper()} 001", vehicle_type="Ambulance",
        is_active=True,
    )
    db.add(v)
    await db.flush()
    return v


async def _get_or_create_crew(
    db: AsyncSession, provider: ServiceProvider, idx: int, pw_hash: str,
) -> CrewMember:
    email = f"loadtest+{provider.slug}-{idx:03d}@prf.test"
    res = await db.execute(select(CrewMember).where(CrewMember.email == email))
    crew = res.scalar_one_or_none()
    if crew:
        crew.is_active = True
        crew.hashed_password = pw_hash
        return crew
    crew = CrewMember(
        provider_id=provider.id,
        email=email,
        hashed_password=pw_hash,
        full_name=f"LoadTest Crew {provider.slug}-{idx:03d}",
        initials="LT",
        # Unique, namespaced HPCSA so the passwordless lookup path also works.
        hpcsa_number=f"LT{provider.slug[-2:].upper()}{idx:04d}",
        qualification="AEA",
        role="crew",
        is_active=True,
    )
    db.add(crew)
    await db.flush()
    return crew


async def seed(num_providers: int, crews_per_provider: int) -> dict:
    engine = _engine()
    Session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    # Hash the shared password once — bcrypt is slow and the hash is reusable.
    pw_hash = hash_password(DEFAULT_PASSWORD)

    fixtures: dict = {"password": DEFAULT_PASSWORD, "providers": [], "crews": []}
    try:
        async with Session() as db:
            for pi in range(num_providers):
                # Use letters a, b, c… so slugs read loadtest-a, loadtest-b.
                letter = chr(ord("a") + pi)
                slug = f"loadtest-{letter}"
                provider = await _get_or_create_provider(db, slug, f"LoadTest Provider {letter.upper()}")
                vehicle = await _get_or_create_vehicle(db, provider)
                await db.flush()
                fixtures["providers"].append({
                    "slug": provider.slug,
                    "provider_id": str(provider.id),
                    "vehicle_id": str(vehicle.id),
                })
                for ci in range(crews_per_provider):
                    crew = await _get_or_create_crew(db, provider, ci, pw_hash)
                    fixtures["crews"].append({
                        "email": crew.email,
                        "password": DEFAULT_PASSWORD,
                        "hpcsa_number": crew.hpcsa_number,
                        "provider_slug": provider.slug,
                        "provider_id": str(provider.id),
                        "crew_id": str(crew.id),
                        "vehicle_id": str(vehicle.id),
                    })
            await db.commit()
    finally:
        await engine.dispose()

    return fixtures


async def teardown() -> int:
    """Delete all loadtest-* providers and their crews/vehicles (cascade by hand)."""
    engine = _engine()
    Session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    removed = 0
    try:
        async with Session() as db:
            res = await db.execute(
                select(ServiceProvider).where(ServiceProvider.slug.like("loadtest-%"))
            )
            providers = res.scalars().all()
            for p in providers:
                crew_res = await db.execute(select(CrewMember).where(CrewMember.provider_id == p.id))
                for c in crew_res.scalars().all():
                    await db.delete(c)
                veh_res = await db.execute(select(Vehicle).where(Vehicle.provider_id == p.id))
                for v in veh_res.scalars().all():
                    await db.delete(v)
                await db.delete(p)
                removed += 1
            await db.commit()
    finally:
        await engine.dispose()
    return removed


def main():
    ap = argparse.ArgumentParser(description="Seed/clean Digital PRF load-test fixtures.")
    ap.add_argument("--providers", type=int, default=2, help="Number of provider companies (>=2 for isolation tests).")
    ap.add_argument("--crews-per-provider", type=int, default=50, help="Crew accounts per provider.")
    ap.add_argument("--teardown", action="store_true", help="Delete all loadtest-* fixtures instead of seeding.")
    args = ap.parse_args()

    if args.teardown:
        n = asyncio.run(teardown())
        print(f"Removed {n} loadtest provider(s) and their crews/vehicles.")
        return

    if args.providers < 2:
        print("WARNING: tenant-isolation tests need >=2 providers; forcing 2.", file=sys.stderr)
        args.providers = 2

    fixtures = asyncio.run(seed(args.providers, args.crews_per_provider))
    OUTPUT_FILE.write_text(json.dumps(fixtures, indent=2))
    print(
        f"Seeded {len(fixtures['providers'])} provider(s), "
        f"{len(fixtures['crews'])} crew(s). Fixtures → {OUTPUT_FILE}"
    )
    print(f"Shared crew password: {DEFAULT_PASSWORD}")


if __name__ == "__main__":
    main()
