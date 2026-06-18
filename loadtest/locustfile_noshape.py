"""
Wrapper locustfile that imports CrewUser but NOT the ShiftChangeShape,
so headless --users / --run-time CLI flags work as expected.
"""
import sys
from pathlib import Path

# Ensure the loadtest dir is importable
sys.path.insert(0, str(Path(__file__).resolve().parent))

# Import only the user class and the fixture loader event
from locustfile import CrewUser, _load_fixtures  # noqa: F401
