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
 * SIGNATURE  — cropped to the ink, WebP 0.8 (see encodeSignature)
 *
 * "Signatures are tiny as PNG" was wrong, and it was costing more than the
 * hospital sticker. Measured on production geometry (2026-08-14): every stored
 * signature is 600x996, the ink occupies 12% of that canvas, and the same
 * stroke encodes as
 *
 *     full-canvas PNG (what shipped)   29.9 KB
 *     full-canvas WebP 0.8              6.2 KB
 *     cropped + WebP 0.8                4.9 KB   <- 6x smaller
 *     cropped + DOWNSCALED PNG         29.6 KB   <- no better at all
 *
 * The last line is the counter-intuitive one and the reason this is a crop, not
 * a resize: downscaling anti-aliases a crisp stroke into many grey values that
 * compress worse, so the obvious "just make it smaller" move saves nothing and
 * costs fidelity. The win is the format and the empty space, not the pixels.
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

/** Signature ink: WebP quality, and the transparent margin left around the ink. */
export const SIGNATURE_WEBP_QUAL = 0.8;
export const SIGNATURE_PAD_PX    = 10;

/** WebP encode support, probed once. Safari gained it in 14; older iPads in the
 *  field will not have it, and a signature is not something to lose to a format
 *  gamble — those fall back to a cropped PNG, which is still ~2x better than
 *  the full-canvas PNG that shipped before. */
let _webpOk: boolean | null = null;
export function canEncodeWebp(): boolean {
  if (_webpOk === null) {
    try {
      const c = document.createElement('canvas');
      c.width = 1; c.height = 1;
      _webpOk = c.toDataURL('image/webp').startsWith('data:image/webp');
    } catch {
      _webpOk = false;
    }
  }
  return _webpOk;
}

/**
 * Encode a signature canvas: crop to the ink, then WebP.
 *
 * Returns '' when the canvas holds no ink, so a caller can treat "nothing was
 * drawn" and "encoding failed" the same way it always has.
 *
 * The crop is deliberately generous (SIGNATURE_PAD_PX) — a signature that
 * touches the edge of its own bounding box looks clipped on the PDF even when
 * every stroke is present.
 */
export function encodeSignature(canvas: HTMLCanvasElement): string {
  const w = canvas.width, h = canvas.height;
  if (!w || !h) return '';
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return '';

  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, w, h).data;
  } catch {
    // Tainted canvas (a loaded cross-origin image) — cannot inspect pixels, so
    // encode whole rather than fail. Still far better than the old PNG.
    return canEncodeWebp()
      ? canvas.toDataURL('image/webp', SIGNATURE_WEBP_QUAL)
      : canvas.toDataURL('image/png');
  }

  // Ink = anything not transparent AND not white. Both tests are needed: the
  // full-screen pad draws on a white fill, the inline pad on transparency.
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = data[i + 3];
      if (a < 12) continue;
      if (data[i] > 244 && data[i + 1] > 244 && data[i + 2] > 244) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return '';                                  // nothing drawn

  const p = SIGNATURE_PAD_PX;
  const sx = Math.max(0, x0 - p), sy = Math.max(0, y0 - p);
  const sw = Math.min(w - sx, x1 - x0 + p * 2);
  const sh = Math.min(h - sy, y1 - y0 + p * 2);

  const out = document.createElement('canvas');
  out.width = sw; out.height = sh;
  const octx = out.getContext('2d');
  if (!octx) return canvas.toDataURL('image/png');
  // NOT downscaled — see the header. Resizing anti-aliases the stroke and the
  // file gets BIGGER while looking worse.
  octx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);

  return canEncodeWebp()
    ? out.toDataURL('image/webp', SIGNATURE_WEBP_QUAL)
    : out.toDataURL('image/png');
}

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
