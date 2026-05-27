import httpx
import asyncio

async def test_premium():
    async with httpx.AsyncClient() as c:
        res = await c.get(
            'https://api.cloud.llamaindex.ai/api/parsing/job/91a77911-b870-40d9-9f2e-7838ea1dc8d5',
            headers={'Authorization': 'Bearer llx-Z4H5AEU3H22fmipePR2NX8jFTKH55vWSRl8IJUvKOWr90azH'}
        )
        print("Status Code:", res.status_code)
        try:
            print("Response text:", res.json())
        except Exception:
            print(res.text)
        
asyncio.run(test_premium())
