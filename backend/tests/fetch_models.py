import requests
import os
import json
from dotenv import load_dotenv

load_dotenv(dotenv_path='.env', override=True)
ep = os.environ.get('AZURE_OPENAI_ENDPOINT', '').rstrip('/')
k = os.environ.get('AZURE_OPENAI_API_KEY', '')

url = f"{ep}/openai/models?api-version=2024-02-15-preview"
res = requests.get(url, headers={'api-key': k})
print("STATUS:", res.status_code)
try:
    data = res.json()
    if "data" in data:
        for model in data["data"]:
            print("FOUND DEPLOYMENT/MODEL:", model.get("id"))
    else:
        print("JSON:", data)
except Exception as e:
    print("RAW TEXT:", res.text)
