"""Quick benchmark: measure DB round-trip latency and startup overhead."""
import time
import asyncio
from sqlalchemy import text

async def main():
    t0 = time.perf_counter()
    from app.database import AsyncSessionLocal
    t1 = time.perf_counter()
    print(f"Import + engine init: {(t1 - t0)*1000:.0f}ms")

    # Cold connection (first query opens a new TCP socket to Supabase)
    t2 = time.perf_counter()
    async with AsyncSessionLocal() as db:
        await db.execute(text("SELECT 1"))
    t3 = time.perf_counter()
    print(f"Cold DB query (incl. TCP connect): {(t3 - t2)*1000:.0f}ms")

    # Warm connection (uses pooled connection)
    times = []
    for _ in range(5):
        t4 = time.perf_counter()
        async with AsyncSessionLocal() as db:
            await db.execute(text("SELECT 1"))
        t5 = time.perf_counter()
        times.append((t5 - t4) * 1000)
    
    avg = sum(times) / len(times)
    print(f"Warm DB queries (5x avg): {avg:.0f}ms  (individual: {', '.join(f'{t:.0f}ms' for t in times)})")

    # Test a real query - count cases
    t6 = time.perf_counter()
    async with AsyncSessionLocal() as db:
        result = await db.execute(text("SELECT count(*) FROM cases"))
        count = result.scalar()
    t7 = time.perf_counter()
    print(f"Count cases ({count} rows): {(t7 - t6)*1000:.0f}ms")

    # Test the heavy /api/stats query pattern
    t8 = time.perf_counter()
    async with AsyncSessionLocal() as db:
        await db.execute(text("""
            SELECT
                (SELECT count(*) FROM documents) as docs,
                (SELECT count(*) FROM claims) as claims,
                (SELECT count(*) FROM cases) as cases
        """))
    t9 = time.perf_counter()
    print(f"Stats-style multi-subquery: {(t9 - t8)*1000:.0f}ms")

if __name__ == "__main__":
    asyncio.run(main())
