"""
API Dependencies — shared across all route modules.
"""
from app.database import get_db
from app.utils.security import get_current_user, require_role

__all__ = ["get_db", "get_current_user", "require_role"]
