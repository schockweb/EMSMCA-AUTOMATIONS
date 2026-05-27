import httpx

client = httpx.Client(base_url='http://localhost:8002')
res = client.post('/api/auth/login', data={'username':'admin@emsclaims.co.za', 'password':'Admin@2024!'})
token = res.json()['access_token']

rfi_res = client.get('/api/adjudication/rfis', headers={'Authorization': f'Bearer {token}'})
rfis = rfi_res.json()
if not rfis:
    print('No RFIs found.')
else:
    target_rfi = rfis[0]
    print(f"Trying to resolve RFI: {target_rfi['id']}")
    resolve_res = client.post(f"/api/adjudication/rfis/{target_rfi['id']}/resolve", json={'response_data': {'resolved_manually': True}}, headers={'Authorization': f'Bearer {token}'})
    print(resolve_res.status_code)
    print(resolve_res.text)
