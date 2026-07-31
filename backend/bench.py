import asyncio, os, time, resource, json
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy import text

URL = os.environ["DATABASE_URL"]

async def main():
    eng = create_async_engine(URL, pool_pre_ping=False)
    async with eng.connect() as c:
        # warm
        await c.execute(text("select 1"))
        for k in (2, 6, 12, 24):
            base = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
            t0 = time.perf_counter()
            res = await c.execute(text(
                "select dp.id, dp.form_data from digital_prfs dp cross join generate_series(1,:k) g"
            ), {"k": k})
            rows = res.fetchall()
            t1 = time.perf_counter()
            # force full python materialisation of the json (what ORM attrs hold)
            held = [r[1] for r in rows]
            n_keys = sum(len(d) if isinstance(d, dict) else 0 for d in held)
            t2 = time.perf_counter()
            peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
            print(f"rows={len(rows):6d}  fetch+parse={t1-t0:7.2f}s  materialise={t2-t1:6.2f}s "
                  f"TOTAL={t2-t0:7.2f}s  peakRSS={peak/1024:8.1f}MB (delta {(peak-base)/1024:7.1f}MB) keys={n_keys}")
            del rows, held
    await eng.dispose()

asyncio.run(main())
