import asyncio
import httpx
import uuid
from datetime import datetime

BASE_URL = "http://localhost:8000"
ADMIN_EMAIL = "admin@emsclaims.co.za"
ADMIN_PASSWORD = "Admin@2024!"

async def test_xss_protection():
    print("\n--- Testing XSS Protection ---")
    async with httpx.AsyncClient(base_url=BASE_URL) as client:
        # We need an endpoint that accepts POST and JSON, but since XSS middleware runs before route handlers,
        # we can even use the login endpoint or any other POST endpoint.
        payload = {"email": "test@test.com", "body": "<script>alert(1)</script>"}
        resp = await client.post("/api/auth/login", json=payload)
        
        # We expect a 400 Bad Request because of our XSS Protection Middleware
        if resp.status_code == 400 and "unsafe" in resp.text.lower():
            print("✅ XSS Protection active: Blocked script injection in JSON body")
        else:
            print(f"❌ XSS Protection failed! Status: {resp.status_code}, Response: {resp.text}")

async def test_rate_limiting():
    print("\n--- Testing Auth Rate Limiter ---")
    async with httpx.AsyncClient(base_url=BASE_URL) as client:
        # The limit is 10 requests per minute
        # We will make 12 requests. The 11th or 12th should be blocked (429).
        success_count = 0
        blocked_count = 0
        for i in range(12):
            resp = await client.post("/api/auth/login", data={"username": "dummy_rate@test.com", "password": "abc"})
            if resp.status_code == 429:
                blocked_count += 1
            else:
                success_count += 1
        
        if blocked_count > 0:
            print(f"✅ Rate limiter active: Blocked {blocked_count} requests after limit reached (Success before block: {success_count})")
        else:
            print(f"❌ Rate limiter failed! No requests were blocked. (Success: {success_count})")

async def test_swagger_production():
    print("\n--- Testing Swagger Visibility ---")
    # Swagger is disabled only if APP_ENV != development. The current running instance has APP_ENV=development.
    # We will just verify it's reachable for development. In production, this would return 404.
    async with httpx.AsyncClient(base_url=BASE_URL) as client:
        resp = await client.get("/docs")
        if resp.status_code == 200:
            print("ℹ️ Swagger docs are accessible (Expected in APP_ENV=development)")
        else:
            print(f"ℹ️ Swagger docs are inaccessible. Status: {resp.status_code}")

async def test_magic_byte_upload():
    print("\n--- Testing Magic-Byte Upload Validation ---")
    # We will upload a file that has a .pdf extension but the contents of a text file (no %PDF header)
    async with httpx.AsyncClient(base_url=BASE_URL) as client:
        # First we need a token (we must login as admin)
        login_resp = await client.post("/api/auth/login", data={"username": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
        if login_resp.status_code != 200:
            print(f"⚠️ Could not login to test upload. Status: {login_resp.status_code}")
            return
        
        token = login_resp.json().get("access_token")
        
        # Fake PDF content
        fake_pdf_content = b"This is just a text file, not a real PDF."
        files = {'file': ('fake.pdf', fake_pdf_content, 'application/pdf')}
        
        resp = await client.post("/api/documents/upload", files=files, headers={"Authorization": f"Bearer {token}"})
        
        if resp.status_code == 400 and "content does not match" in resp.text.lower():
            print("✅ Magic-byte validation active: Blocked fake PDF upload")
        else:
            print(f"❌ Magic-byte validation failed! Status: {resp.status_code}, Response: {resp.text}")

async def test_account_lockout():
    print("\n--- Testing Account Lockout & Password Complexity ---")
    
    # We will use sqlalchemy to create a test user directly if needed, but let's try the API
    async with httpx.AsyncClient(base_url=BASE_URL) as client:
        # Login admin
        login_resp = await client.post("/api/auth/login", data={"username": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
        token = login_resp.json().get("access_token")
        
        test_email = f"testlockout_{uuid.uuid4().hex[:6]}@test.com"
        
        # 1. Test Password Complexity
        user_payload = {
            "email": test_email,
            "password": "weakpassword", # Weak password
            "full_name": "Test Lockout User",
            "role": "paramedic"
        }
        create_resp = await client.post("/api/users/", json=user_payload, headers={"Authorization": f"Bearer {token}"})
        
        if create_resp.status_code == 400:
            print("✅ Password complexity active: Rejected weak password")
        else:
            print(f"❌ Password complexity failed! Status: {create_resp.status_code}")
            
        # Create user with strong password
        user_payload["password"] = "StrongP@ssw0rd2024!"
        create_resp = await client.post("/api/users/", json=user_payload, headers={"Authorization": f"Bearer {token}"})
        
        if create_resp.status_code != 201:
            print(f"⚠️ Failed to create test user for lockout test. Status: {create_resp.status_code}, Response: {create_resp.text}")
            return
            
        print(f"ℹ️ Created test user {test_email}")
        
        # 2. Test Lockout
        # We need to fail 5 times, and on the 6th it should be locked
        status_codes = []
        for i in range(5):
            resp = await client.post("/api/auth/login", data={"username": test_email, "password": "WrongPassword1!"})
            status_codes.append(resp.status_code)
            
        if all(code == 401 for code in status_codes):
            print("ℹ️ Successfully failed login 5 times with 401 Unauthorized")
        else:
            print(f"⚠️ Unexpected status codes during failures: {status_codes}")
            
        # 6th attempt should be locked (423 Locked)
        locked_resp = await client.post("/api/auth/login", data={"username": test_email, "password": "WrongPassword1!"})
        if locked_resp.status_code == 423:
            print("✅ Account lockout active: User locked (423) after 5 failed attempts")
        elif locked_resp.status_code == 429: # Might hit rate limit if we do it too fast and from same IP, but we used a different username so rate limit is per IP.
             # Actually auth rate limit is per IP, so 10 req/min. We made 12 earlier, so we might be rate limited!
             # We should use a different mechanism or IP if possible.
             print("⚠️ Request was rate limited (429). We hit the IP rate limit before the lockout.")
        else:
            print(f"❌ Account lockout failed! Status: {locked_resp.status_code}, Response: {locked_resp.text}")

async def main():
    print("🚀 Starting Security Verification Protocol...")
    await test_xss_protection()
    await test_swagger_production()
    await test_magic_byte_upload()
    await test_account_lockout()
    # Run rate limiting last so it doesn't block the other tests from the same IP
    await asyncio.sleep(1) # small breather
    await test_rate_limiting()
    print("\n🏁 Security Verification Complete.")

if __name__ == "__main__":
    asyncio.run(main())
