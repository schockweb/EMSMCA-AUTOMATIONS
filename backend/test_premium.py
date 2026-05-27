import httpx
import asyncio

async def test_premium():
    async with httpx.AsyncClient() as c:
        res = await c.post(
            'https://api.cloud.llamaindex.ai/api/parsing/upload',
            headers={'Authorization': 'Bearer llx-Z4H5AEU3H22fmipePR2NX8jFTKH55vWSRl8IJUvKOWr90azH'},
            files={'file': ('file.pdf', b'fake')},
            data={'result_type': 'markdown', 'premium_mode': 'true', 'fast_mode': 'false'}
        )
        print("Upload Response:", res.status_code, res.text)
        
asyncio.run(test_premium())
