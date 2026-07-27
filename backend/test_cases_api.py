import requests
import os
SEED_ADMIN_PASSWORD = os.getenv("SEED_ADMIN_PASSWORD", "DevSeed!Change#2026")  # burned value removed


url_login = "http://127.0.0.1:8000/api/auth/login"
data = {
    "username": "admin@emsclaims.co.za",
    "password": SEED_ADMIN_PASSWORD
}

try:
    print("Logging in...")
    resp = requests.post(url_login, data=data)
    resp.raise_for_status()
    token = resp.json()["access_token"]
    print("Logged in, token received.")
    
    print("Fetching /api/cases ...")
    headers = {"Authorization": f"Bearer {token}"}
    cases_resp = requests.get("http://127.0.0.1:8000/api/cases", headers=headers, timeout=5)
    
    print("Status:", cases_resp.status_code)
    try:
        cases = cases_resp.json()
        print(f"Success! Got {len(cases)} cases.")
        if cases:
            print("First case:", cases[0])
    except Exception as e:
        print("Failed to parse JSON:", cases_resp.text)
        
except Exception as e:
    print("Error:", str(e))
