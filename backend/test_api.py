import asyncio
from app.api.adjudication import validate_codes
from app.api.adjudication import ICD10ValidateRequest

async def run_test():
    try:
        from app.models.user import User
        req = ICD10ValidateRequest(icd10_code='R10.13')
        user = User(id='test')
        result = await validate_codes(req, user)
        print('RESULT:', result)
    except Exception as e:
        import traceback
        traceback.print_exc()

asyncio.run(run_test())
