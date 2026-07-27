import asyncio
import os
import certifi
from dotenv import load_dotenv
load_dotenv(dotenv_path='C:/Users/USER-PC/Desktop/New EMS AUTOMATIONS/backend/.env', override=True)
from app.services.ocr_extraction import extract_document
import pprint

async def test():
    with open('uploads/raw/06977abf-8258-41e5-a652-2deb5bf943fb.pdf', 'rb') as f:
        data = f.read()

    res = await extract_document(data, 'test.pdf')
    print('SUCCESS:', res.success)
    print('ERROR:', res.error)
    print('AVG CONFIDENCE:', res.avg_confidence)
    if res.success:
        pprint.pprint(res.extracted_data)

asyncio.run(test())
