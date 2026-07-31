"""READ-ONLY reproduction of the per-task-event-loop + module-level engine claim.

Mimics exactly what extraction.py / preprocessing.py do:
  loop = asyncio.new_event_loop(); set_event_loop(loop)
  loop.run_until_complete(coro that uses app.database.AsyncSessionLocal)
  loop.close()

Only issues SELECTs. No writes, no commits.
"""
import asyncio, traceback

from sqlalchemy import text
from app.database import AsyncSessionLocal, engine

print("engine pool:", engine.pool.__class__.__name__, "pre_ping:", engine.pool._pre_ping)


async def _work(i):
    async with AsyncSessionLocal() as db:
        r = await db.execute(text("SELECT 1"))
        return r.scalar()


ok = 0
fail = 0
errs = {}
for i in range(40):
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        loop.run_until_complete(_work(i))
        ok += 1
        print(i, "OK")
    except BaseException as e:
        fail += 1
        name = type(e).__name__ + ": " + str(e)[:110]
        errs[name] = errs.get(name, 0) + 1
        print(i, "FAIL", name)
    finally:
        loop.close()

print("=== ok=%d fail=%d rate=%.0f%%" % (ok, fail, 100.0 * fail / (ok + fail)))
for k, v in errs.items():
    print("   x%d  %s" % (v, k))
