import asyncio
import os
from dotenv import load_dotenv
from openai import AsyncAzureOpenAI
import logging

load_dotenv(dotenv_path='C:/Users/USER-PC/Desktop/New EMS AUTOMATIONS/backend/.env', override=True)

async def probe_deployment():
    ep = os.environ.get('AZURE_OPENAI_ENDPOINT', '')
    k = os.environ.get('AZURE_OPENAI_API_KEY', '')

    common_names = [
        "gpt-4o", "gpt4o", "gpt-4", "gpt4", 
        "emsclaims", "emsclaims-gpt4o", "emsclaims-gpt-4o",
        "deployment", "model"
    ]
    
    print("Beginning probe for actual deployment name...")
    for name in common_names:
        print(f"Trying deployment name: '{name}'...")
        client = AsyncAzureOpenAI(api_key=k, api_version="2024-02-15-preview", azure_endpoint=ep)
        try:
            res = await client.chat.completions.create(
                model=name,
                messages=[{"role": "user", "content": "ping"}],
                max_tokens=5
            )
            print(f">>>> SUCCESS! Deployment name is: {name}")
            return
        except Exception as e:
            if "DeploymentNotFound" in str(e):
                pass
            else:
                print(f"Failed with different error for {name}: {e}")

    print("Probe failed. No common deployment names hit.")

asyncio.run(probe_deployment())
