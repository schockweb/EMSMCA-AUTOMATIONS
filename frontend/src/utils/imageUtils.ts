/**
 * imageUtils.ts — Shared client-side image compression utilities.
 *
 * Why compress on the phone?
 * --------------------------
 * A typical phone camera produces 3–8 MB JPEG files. Uploading them raw
 * means the crew waits longer, uses mobile data faster, and the server
 * burns CPU recompressing every image. By compressing to a reasonable
 * output size on the phone BEFORE uploading, we reduce:
 *
 *   - Upload size:     ~90% smaller (3 MB → ~250 KB)
 *   - Upload time:     ~5–10× faster on mobile data
 *   - Server CPU:      image processing drops to ~0%
 *   - Database size:   90% less base64 bloat per PRF
 *   - Bandwidth cost:  ~90% lower Azure egress fees
 *
 * Compression profiles
 * --------------------
 * DOCUMENT   — 1200px, quality 0.75  (~150–300 KB)  for forms/ID/nursing notes
 * STICKER    — 1600px, quality 0.88  (~200–400 KB)  for OCR — needs more detail
 * SIGNATURE  — kept as PNG (lossless, tiny for line art)
 *
 * All functions return data URLs (data:image/jpeg;base64,...) compatible
 * with the existing form_data storage shape.
 */

/** Output pixel budget for general documents (ID, referral letters, nursing notes). */
export const DOCUMENT_MAX_DIM    = 1200;
export const DOCUMENT_JPEG_QUAL  = 0.75;

/** Output pixel budget for hospital stickers — needs enough resolution for OCR. */
export const STICKER_MAX_DIM     = 1600;
export const STICKER_JPEG_QUAL   = 0.88;

/** Maximum raw file size accepted for upload (hard cap — reject before loading). */
export const MAX_RAW_FILE_BYTES  = 12 * 1024 * 1024; // 12 MB

/**
 * Resize and re-compress an image from a data URL.
 * Returns a JPEG data URL at the requested max dimension and quality.
 */
export function compressDataUrl(
  srcDataUrl: string,
  maxDim: number = DOCUMENT_MAX_DIM,
  quality: number = DOCUMENT_JPEG_QUAL,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height, 1));
      const w = Math.max(1, Math.round(img.width  * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width  = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) { reject(new Error('Canvas context unavailable')); return; }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => reject(new Error('Failed to decode image'));
    img.src = srcDataUrl;
  });
}

/**
 * Read a File object into a compressed JPEG data URL.
 * Validates size before loading — throws if the file exceeds MAX_RAW_FILE_BYTES.
 */
export async function compressFile(
  file: File,
  maxDim: number = DOCUMENT_MAX_DIM,
  quality: number = DOCUMENT_JPEG_QUAL,
): Promise<string> {
  if (file.size > MAX_RAW_FILE_BYTES) {
    throw new Error(`"${file.name}" exceeds 12 MB — please choose a smaller image.`);
  }
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
  return compressDataUrl(dataUrl, maxDim, quality);
}

/**
 * Compress a raw canvas frame (taken from a video element or ImageBitmap)
 * by drawing it to a downscaled canvas.
 *
 * Used by the camera overlays to compress video frames before they're
 * stored in form state — the camera always captures at up to 1920×1080
 * but we only need 1200px for documents (or 1600px for stickers).
 */
export function compressImageBitmap(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  maxDim: number = DOCUMENT_MAX_DIM,
  quality: number = DOCUMENT_JPEG_QUAL,
): string {
  const scale = Math.min(1, maxDim / Math.max(sourceWidth, sourceHeight, 1));
  const outW   = Math.max(1, Math.round(sourceWidth  * scale));
  const outH   = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width  = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas context unavailable');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, sourceWidth, sourceHeight, 0, 0, outW, outH);
  return canvas.toDataURL('image/jpeg', quality);
}

/**
 * Returns a human-readable approximate size from a data URL.
 * Useful for showing "~240 KB" in the UI so the crew can see the result.
 */
export function estimateDataUrlSizeKB(dataUrl: string): number {
  // Base64 encodes 3 bytes as 4 chars; strip the header prefix first.
  const b64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
  return Math.round((b64.length * 0.75) / 1024);
}
