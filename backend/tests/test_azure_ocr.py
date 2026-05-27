import asyncio
import os
from dotenv import load_dotenv
load_dotenv(dotenv_path='C:/Users/USER-PC/Desktop/New EMS AUTOMATIONS/backend/.env', override=True)
from azure.core.credentials import AzureKeyCredential
from azure.ai.documentintelligence.aio import DocumentIntelligenceClient
from app.config import get_settings

async def test():
    settings = get_settings()
    client = DocumentIntelligenceClient(settings.AZURE_DOC_INTEL_ENDPOINT, AzureKeyCredential(settings.AZURE_DOC_INTEL_KEY))
    
    with open('uploads/raw/06977abf-8258-41e5-a652-2deb5bf943fb.pdf', 'rb') as f:
        data = f.read()

    try:
        async with client:
            poller = await client.begin_analyze_document(
                "prebuilt-layout",
                body=data,
                features=["keyValuePairs"],
                content_type="application/octet-stream"
            )
            res = await poller.result()
            
            print("--- RAW KV PAIRS ---")
            if hasattr(res, "key_value_pairs") and res.key_value_pairs:
                for kvp in res.key_value_pairs:
                    key_text = kvp.key.content if kvp.key else "NONE"
                    val_text = kvp.value.content if kvp.value else "NONE"
                    print(f"[{key_text}] : [{val_text}]")
            else:
                print("No KV pairs returned by Azure.")
    except Exception as e:
        print("ERROR:", str(e))

asyncio.run(test())
