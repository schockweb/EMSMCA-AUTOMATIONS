"""
Storage utilities — local file storage abstraction.
"""
import os
import uuid
import aiofiles
from pathlib import Path
from app.config import get_settings

settings = get_settings()


async def save_upload(file_bytes: bytes, original_filename: str, subfolder: str = "raw") -> str:
    """
    Save uploaded file bytes to local storage.
    Returns the relative storage URI.
    """
    upload_dir = Path(settings.UPLOAD_DIR) / subfolder
    upload_dir.mkdir(parents=True, exist_ok=True)

    # Generate unique filename to prevent collisions
    ext = Path(original_filename).suffix
    unique_name = f"{uuid.uuid4()}{ext}"
    file_path = upload_dir / unique_name

    async with aiofiles.open(str(file_path), "wb") as f:
        await f.write(file_bytes)

    return f"{subfolder}/{unique_name}"


async def save_processed(file_bytes: bytes, original_filename: str) -> str:
    """Save preprocessed/enhanced file."""
    return await save_upload(file_bytes, original_filename, subfolder="processed")


def get_full_path(storage_uri: str) -> str:
    """Get absolute path from storage URI. Validates against path traversal."""
    base = Path(settings.UPLOAD_DIR).resolve()
    full = (base / storage_uri).resolve()
    # Prevent directory traversal (e.g. ../../etc/passwd)
    if not str(full).startswith(str(base)):
        raise ValueError(f"Path traversal detected: {storage_uri}")
    return str(full)


def file_exists(storage_uri: str) -> bool:
    """Check if a file exists in storage."""
    return os.path.exists(get_full_path(storage_uri))
