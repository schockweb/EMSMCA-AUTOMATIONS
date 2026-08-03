"""
Mint crew JWTs directly, so the PRF write path can be measured without every
request first queueing behind bcrypt and the auth rate limiter.

    docker cp loadtest/mint_tokens.py lt_backend:/tmp/mint_tokens.py
    docker exec -e PYTHONPATH=/app lt_backend python /tmp/mint_tokens.py > loadtest/tokens.txt

WHY THIS IS NOT CHEATING
------------------------
Auth is measured separately and on purpose (see the login-storm results): the
limiter caps /api/crew/login at 15 per 60 s PER CLIENT IP, and bcrypt costs
~200 ms per attempt. Leaving that in the write-path test would mean every run
measures the login wall again and nothing else.

It is also what really happens. A crew token lasts 12 hours with no refresh, so
a crew logs in ONCE at the start of a shift and every request for the rest of
the day carries that token. Re-authenticating per call, which the first version
of the driver did, models nothing.

The claims mirror crew_auth.py exactly; a token from here is indistinguishable
from one issued by the login endpoint.
"""
from __future__ import annotations

import asyncio
import os
import sys

sys.path.insert(0, "/app")

from sqlalchemy import select                          # noqa: E402

from app.database import engine                        # noqa: E402
from sqlalchemy.ext.asyncio import async_sessionmaker  # noqa: E402
from app.models.crew_member import CrewMember          # noqa: E402
from app.models.service_provider import ServiceProvider  # noqa: E402
from app.utils.security import create_access_token     # noqa: E402

COUNT = int(os.getenv("LT_TOKENS", "600"))


async def main() -> None:
    Session = async_sessionmaker(engine, expire_on_commit=False)
    async with Session() as db:
        rows = (await db.execute(
            select(CrewMember, ServiceProvider)
            .join(ServiceProvider, ServiceProvider.id == CrewMember.provider_id)
            .where(CrewMember.email.like("crew%@loadtest.local"))
            .limit(COUNT)
        )).all()

    for crew, provider in rows:
        token = create_access_token({
            "sub": str(crew.id),
            "crew_id": str(crew.id),
            "provider_id": str(provider.id),
            "provider_slug": provider.slug,
            "role": crew.role,
            "token_scope": "crew",
        })
        print(f"{token}\t{provider.id}")

    await engine.dispose()


asyncio.run(main())
