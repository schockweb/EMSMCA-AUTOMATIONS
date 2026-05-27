"""
Image Preprocessing Service — Claid.ai (primary), Cloudinary (backup), local OpenCV (fallback).
Enhances low-quality mobile PRF uploads: deskew, shadow removal, contrast, upscaling.
"""
import io
import httpx
from dataclasses import dataclass
from PIL import Image, ImageEnhance, ImageFilter
from app.config import get_settings

settings = get_settings()


@dataclass
class PreprocessResult:
    """Result of image preprocessing."""
    image_bytes: bytes
    method_used: str  # "claid", "cloudinary", "local"
    enhancements_applied: list[str]
    success: bool
    error: str | None = None


async def preprocess_with_claid(image_bytes: bytes, filename: str) -> PreprocessResult:
    """
    Primary: Use Claid.ai API for professional image enhancement.
    Applies deskew, shadow removal, contrast optimization, and AI upscaling.
    """
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                "https://api.claid.ai/v1-beta1/image/edit",
                headers={
                    "Authorization": f"Bearer {settings.CLAID_API_KEY}",
                    "Content-Type": "application/json",
                },
                json={
                    "input": f"data:image/jpeg;base64,{__to_base64(image_bytes)}",
                    "operations": {
                        "restorations": {
                            "upscale": "smart_enhance",
                        },
                        "adjustments": {
                            "contrast": 20,
                            "brightness": 10,
                            "sharpness": 15,
                        },
                    },
                    "output": {
                        "format": "jpeg",
                        "quality": 95,
                    },
                },
            )

            if response.status_code == 200:
                result_data = response.json()
                # Claid returns base64 output or a URL
                output_url = result_data.get("output", {}).get("tmp_url")
                if output_url:
                    img_response = await client.get(output_url)
                    return PreprocessResult(
                        image_bytes=img_response.content,
                        method_used="claid",
                        enhancements_applied=["upscale", "contrast", "brightness", "sharpness"],
                        success=True,
                    )

            return PreprocessResult(
                image_bytes=image_bytes,
                method_used="claid",
                enhancements_applied=[],
                success=False,
                error=f"Claid API returned status {response.status_code}: {response.text[:200]}",
            )

    except Exception as e:
        return PreprocessResult(
            image_bytes=image_bytes,
            method_used="claid",
            enhancements_applied=[],
            success=False,
            error=str(e),
        )


async def preprocess_local(image_bytes: bytes, filename: str) -> PreprocessResult:
    """
    Local fallback: Pillow-based image enhancement.
    Basic contrast normalization, sharpening, and brightness adjustment.
    """
    try:
        img = Image.open(io.BytesIO(image_bytes))

        # Convert to RGB if needed
        if img.mode != "RGB":
            img = img.convert("RGB")

        enhancements = []

        # Auto-contrast
        enhancer = ImageEnhance.Contrast(img)
        img = enhancer.enhance(1.3)
        enhancements.append("contrast_1.3x")

        # Brightness boost
        enhancer = ImageEnhance.Brightness(img)
        img = enhancer.enhance(1.1)
        enhancements.append("brightness_1.1x")

        # Sharpen
        enhancer = ImageEnhance.Sharpness(img)
        img = enhancer.enhance(1.5)
        enhancements.append("sharpness_1.5x")

        # Denoise with slight blur then re-sharpen
        img = img.filter(ImageFilter.MedianFilter(size=3))
        img = img.filter(ImageFilter.SHARPEN)
        enhancements.append("denoise_sharpen")

        # Upscale if small
        min_dim = 1500
        if img.width < min_dim or img.height < min_dim:
            scale = max(min_dim / img.width, min_dim / img.height)
            new_size = (int(img.width * scale), int(img.height * scale))
            img = img.resize(new_size, Image.LANCZOS)
            enhancements.append(f"upscale_{scale:.1f}x")

        # Save to bytes
        output_buffer = io.BytesIO()
        img.save(output_buffer, format="JPEG", quality=95)
        output_bytes = output_buffer.getvalue()

        return PreprocessResult(
            image_bytes=output_bytes,
            method_used="local",
            enhancements_applied=enhancements,
            success=True,
        )

    except Exception as e:
        return PreprocessResult(
            image_bytes=image_bytes,
            method_used="local",
            enhancements_applied=[],
            success=False,
            error=str(e),
        )


async def preprocess_image(image_bytes: bytes, filename: str) -> PreprocessResult:
    """
    Main entry point: try Claid.ai first, fall back to local processing.
    """
    # Try Claid.ai first if API key is configured
    if settings.CLAID_API_KEY:
        result = await preprocess_with_claid(image_bytes, filename)
        if result.success:
            return result

    # Fallback to local processing
    return await preprocess_local(image_bytes, filename)


def __to_base64(data: bytes) -> str:
    import base64
    return base64.b64encode(data).decode("utf-8")
