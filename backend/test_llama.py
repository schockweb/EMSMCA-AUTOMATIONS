import asyncio
import httpx
import os
from dotenv import load_dotenv

load_dotenv()
API_KEY = os.getenv("LLAMA_CLOUD_API_KEY")

async def test_llamaparse():
    async with httpx.AsyncClient() as client:
        # 1. upload a dummy txt file
        print("Uploading...")
        file_bytes = b"This is a test patient form. Patient name: John Doe. ID: 1234567890123. Location: Cape Town."
        
        up_res = await client.post(
            "https://api.cloud.llamaindex.ai/api/parsing/upload",
            headers={"Authorization": f"Bearer {API_KEY}"},
            files={"file": ("test.txt", file_bytes)},
            data={"result_type": "markdown"}
        )
        print("Upload status:", up_res.status_code)
        if up_res.status_code != 200:
            print(up_res.text)
            return
            
        job = up_res.json()
        job_id = job.get("id")
        print("Job ID:", job_id)
        
        # 2. check status endpoint
        for _ in range(10):
            await asyncio.sleep(2)
            status_res = await client.get(
                f"https://api.cloud.llamaindex.ai/api/parsing/job/{job_id}",
                headers={"Authorization": f"Bearer {API_KEY}"}
            )
            print("Status code (job):", status_res.status_code)
            if status_res.status_code == 200:
                print("Job status:", status_res.json())
                
            res_md = await client.get(
                f"https://api.cloud.llamaindex.ai/api/parsing/job/{job_id}/result/markdown",
                headers={"Authorization": f"Bearer {API_KEY}"}
            )
            print("Result code (markdown):", res_md.status_code)
            if res_md.status_code == 200:
                print("Got markdown!")
                print(res_md.json())
                break
            elif res_md.status_code != 404:
                print("Unexpected result code:", res_md.text)

asyncio.run(test_llamaparse())
