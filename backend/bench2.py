import asyncio, os, time, resource
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from sqlalchemy import select, text
from app.models.digital_prf import DigitalPRF

URL = os.environ["DATABASE_URL"]

def rss():
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1024.0

async def main():
    eng = create_async_engine(URL)
    S = async_sessionmaker(eng, expire_on_commit=False)
    cols = "gen_random_uuid() as id, " + ", ".join(
        c.name for c in DigitalPRF.__table__.columns if c.name != "id")
    print("baseline RSS %.1f MB" % rss())
    for k in (24, 60, 120):
        async with S() as db:
            t0 = time.perf_counter()
            # REAL ORM entity load — distinct PKs so the identity map cannot dedupe
            res = await db.execute(
                select(DigitalPRF).from_statement(
                    text(f"select {cols} from digital_prfs dp cross join generate_series(1,{k}) g")))
            objs = res.scalars().all()
            t1 = time.perf_counter()
            # touch form_data exactly as the watchdog's loop would keep it alive
            tot = sum(len(o.form_data or {}) for o in objs)
            t2 = time.perf_counter()
            print(f"ORM rows={len(objs):6d}  load={t1-t0:7.2f}s  touch={t2-t1:5.2f}s "
                  f"TOTAL={t2-t0:7.2f}s  peakRSS={rss():8.1f}MB  keys={tot}")
            del objs
    await eng.dispose()

asyncio.run(main())
