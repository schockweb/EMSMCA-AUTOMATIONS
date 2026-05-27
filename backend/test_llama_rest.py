import asyncio
import httpx
import os
import json
from dotenv import load_dotenv

load_dotenv()
API_KEY = os.getenv("LLAMA_CLOUD_API_KEY")

if API_KEY and API_KEY.startswith("llx") and not API_KEY.startswith("llx-"):
    API_KEY = "llx-" + API_KEY[3:]


async def test_llamaparse():
    async with httpx.AsyncClient() as client:
        print("Uploading to LlamaParse REST API...")
        file_bytes = b"Hello world! This is a test pdf text."
        
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
        
        # Poll for completion
        for i in range(15):
            await asyncio.sleep(2)
            
            # Check the status endpoint
            status_res = await client.get(
                f"https://api.cloud.llamaindex.ai/api/parsing/job/{job_id}",
                headers={"Authorization": f"Bearer {API_KEY}"}
            )
            data = status_res.json()
            status = data.get("status")
            print(f"[{i}] Job status:", status)
            
            if status == "SUCCESS":
                res_md = await client.get(
                    f"https://api.cloud.llamaindex.ai/api/parsing/job/{job_id}/result/markdown",
                    headers={"Authorization": f"Bearer {API_KEY}"}
                )
                print("Result code (markdown):", res_md.status_code)
                print(res_md.json())
                break
            elif status == "ERROR":
                print("Job failed!")
                break

asyncio.run(test_llamaparse())
