"""Mint a crew session for the isolated tenant and open one draft PRF.

Authenticating programmatically, not through the login form: the sign-in flow
already has jsdom coverage (offlineShiftStart, offlineCrewRoster) and it is not
what is under test here — the CREW FORM is. Injecting the session the same way
a completed sign-in would leave it means no password is typed anywhere and the
run starts at the thing being measured.
"""
import asyncio, json, sys
sys.path.insert(0, "/app")

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.database import engine
from app.models.crew_member import CrewMember
from app.models.digital_prf import DigitalPRF, PRFStatus
from app.models.service_provider import ServiceProvider
from app.utils.security import create_access_token

SLUG = "zzz-loadtest-temporary"


async def main():
    S = async_sessionmaker(engine, expire_on_commit=False)
    async with S() as db:
        prov = (await db.execute(select(ServiceProvider)
                                 .where(ServiceProvider.slug == SLUG))).scalar_one()
        crew = (await db.execute(select(CrewMember)
                                 .where(CrewMember.provider_id == prov.id)
                                 .limit(2))).scalars().all()
        c1, c2 = crew[0], crew[1]
        token = create_access_token({
            "sub": str(c1.id), "crew_id": str(c1.id),
            "provider_id": str(prov.id), "provider_slug": prov.slug,
            "role": c1.role, "token_scope": "crew",
        })
        profile = {
            "id": str(c1.id), "name": c1.full_name, "provider_id": str(prov.id),
            "provider_name": prov.name, "provider_slug": prov.slug,
            "qualification": c1.qualification, "hpcsa_number": c1.hpcsa_number, "role": "crew",
        }
        partner = {"id": str(c2.id), "name": c2.full_name,
                   "qualification": c2.qualification, "hpcsa_number": c2.hpcsa_number}
    print(json.dumps({
        "provider_slug": prov.slug, "provider_id": str(prov.id),
        "crew_token": token, "crew_profile": profile, "partner": partner,
    }))
    await engine.dispose()

asyncio.run(main())
