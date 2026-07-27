import asyncio, sys
sys.path.insert(0,'/app')
from tests.conftest import app, _ensure_schema, _TestSession
from tests import conftest as cf
from httpx import AsyncClient, ASGITransport
from tests.test_digital_prf import CREW_A_EMAIL, CREW_PASSWORD

async def main():
    await _ensure_schema()
    # run the crew bootstrap the autouse fixture normally does
    gen = cf._ensure_test_crew.__wrapped__()
    try:
        await gen.__anext__()
    except StopAsyncIteration:
        pass
    except AttributeError:
        pass
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.post("/api/crew/login", json={"email": CREW_A_EMAIL, "password": CREW_PASSWORD})
        print("crew login:", r.status_code, r.text[:200])
        if r.status_code != 200: return
        h = {"Authorization": "Bearer " + r.json()["access_token"]}
        cr = await c.post("/api/digital-prf", json={}, headers=h)
        print("create:", cr.status_code)
        pid = cr.json()["id"]
        s = await c.post("/api/digital-prf/" + pid + "/submit", headers=h)
        print("submit:", s.status_code)
        print("BODY:", s.text[:800])
asyncio.run(main())
