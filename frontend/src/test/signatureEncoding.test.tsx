/**
 * encodeSignature — crops a signature to its ink and encodes it small.
 *
 * The value being protected here is storage: this pad was writing ~30 KB per
 * signature and there are up to five on a PRF, which cost more than the
 * hospital sticker. These tests pin the behaviour that produces the saving, and
 * the behaviour that must NOT regress with it: an unsigned pad still reports
 * nothing, and ink at the very edge is never cropped away.
 *
 * jsdom has no real codec, so byte-for-byte sizes are not assertable here — the
 * measured ratios live in imageUtils' header, taken from a real browser. What
 * IS assertable, and what actually broke before, is the geometry.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { encodeSignature } from '../utils/imageUtils';

// The crop is performed by drawing the SOURCE canvas onto a NEW one, so the
// call to assert on belongs to the canvas encodeSignature creates itself — not
// to the one handed in. Recording it on the source (the obvious place) captures
// nothing, which is what the first version of this test did.
let drawn: Array<Record<string, number>> = [];

/** jsdom's canvas is a stub; give it just enough to exercise the crop logic. */
function makeCanvas(w: number, h: number, ink: Array<[number, number]>): HTMLCanvasElement {
  const data = new Uint8ClampedArray(w * h * 4);           // all transparent
  for (const [x, y] of ink) {
    const i = (y * w + x) * 4;
    data[i] = 17; data[i + 1] = 17; data[i + 2] = 17; data[i + 3] = 255;
  }
  return {
    width: w, height: h,
    getContext: () => ({ getImageData: () => ({ data }), drawImage: () => {} }),
    toDataURL: (type = 'image/png') => `data:${type};base64,AAAA`,
  } as unknown as HTMLCanvasElement;
}

beforeEach(() => { drawn = []; });

beforeAll(() => {
  const orig = document.createElement.bind(document);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (document as any).createElement = (tag: string, ...rest: unknown[]) => {
    if (tag !== 'canvas') return orig(tag, ...(rest as []));
    const out: Record<string, unknown> = { width: 0, height: 0 };
    out.getContext = () => ({
      drawImage: (_src: unknown, sx: number, sy: number, sw: number, sh: number) => {
        if (typeof sx === 'number') drawn.push({ sx, sy, sw, sh });
      },
    });
    out.toDataURL = (type = 'image/png') => `data:${type};base64,BBBB`;
    return out as unknown as HTMLCanvasElement;
  };
});

describe('encodeSignature', () => {
  it('returns empty string for a pad nobody signed', () => {
    expect(encodeSignature(makeCanvas(600, 996, []))).toBe('');
  });

  it('crops to the ink rather than storing the whole canvas', () => {
    // A signature in the middle of a tall phone pad — the real geometry.
    const ink: Array<[number, number]> = [];
    for (let x = 200; x < 400; x++) ink.push([x, 500], [x, 510]);
    encodeSignature(makeCanvas(600, 996, ink));
    const d = drawn[0];
    // Source rect must be the ink box plus padding — NOT the full 600x996.
    expect(d.sw).toBeLessThan(600);
    expect(d.sh).toBeLessThan(996);
    expect(d.sw).toBeGreaterThanOrEqual(200);   // covers the stroke
    expect(d.sh).toBeGreaterThanOrEqual(10);
    // The crop must fully contain the ink, with margin on each side.
    expect(d.sx).toBeLessThanOrEqual(200);
    expect(d.sy).toBeLessThanOrEqual(500);
    expect(d.sx + d.sw).toBeGreaterThanOrEqual(400);
    expect(d.sy + d.sh).toBeGreaterThanOrEqual(510);
  });

  it('never crops away ink drawn hard against the canvas edge', () => {
    encodeSignature(makeCanvas(300, 200, [[0, 0], [299, 199]]));
    const d = drawn[0];
    expect(d.sx).toBe(0);
    expect(d.sy).toBe(0);
    expect(d.sx + d.sw).toBe(300);
    expect(d.sy + d.sh).toBe(200);
  });

  it('treats a white-filled pad as blank, not as ink', () => {
    // The fullscreen pad draws on white; only non-white marks are a signature.
    const w = 40, h = 20;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = 255;
    }
    const canvas = {
      width: w, height: h,
      getContext: () => ({ getImageData: () => ({ data }), drawImage: () => {} }),
      toDataURL: () => 'data:image/png;base64,AAAA',
    } as unknown as HTMLCanvasElement;
    expect(encodeSignature(canvas)).toBe('');
  });

  it('produces a data URL when the pad holds ink', () => {
    const out = encodeSignature(makeCanvas(120, 80, [[10, 10], [11, 11], [12, 12]]));
    expect(out.startsWith('data:image/')).toBe(true);
  });
});
