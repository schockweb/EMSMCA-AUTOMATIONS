/**
 * pdfToImages — rasterise an attached PDF's pages to JPEG data-URLs on the
 * device, at attach time.
 *
 * Why: the PRF export pipeline snapshots rendered HTML to canvas, and a
 * canvas cannot paint the pages of an embedded PDF file — so a raw PDF
 * attachment can only ever print as a "PDF attached" placeholder. Converting
 * the pages to images up front means the exported PRF carries the document's
 * actual contents, exactly like a photographed document.
 *
 * pdf.js is imported lazily so its ~350KB chunk stays out of the main
 * bundle; the worker ships as a hashed asset (the PWA precache includes
 * .mjs so this also works offline once the app is installed).
 */
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// Long edge of a rendered page in px. 1600px ≈ 190 DPI for A4 — the same
// budget the in-app document camera uses, readable in print without
// bloating the PRF payload (~150-300KB/page as JPEG).
const PAGE_MAX_DIM = 1600;
const PAGE_JPEG_QUAL = 0.85;

// Safety cap so a book-sized PDF cannot balloon the PRF payload. Real
// attachments here (payslips, OARs, medical reports) run 1-5 pages.
export const PDF_MAX_PAGES = 10;

export async function pdfFileToImages(f: File): Promise<{ pages: string[]; totalPages: number }> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  const data = await f.arrayBuffer();
  // The file is whatever the user picked, so this call is the one place the app
  // hands attacker-controllable bytes to a parser. Two advisories were checked
  // against this line rather than assumed:
  //
  //  GHSA-hq66-cqwq-w95j (pdfjs-dist <6.2.108, "arbitrary JS on opening a
  //    malicious PDF") does NOT apply. It needs enableScripting, which is a
  //    VIEWER option; this module never builds a viewer — it rasterises pages
  //    — and pdf.sandbox is never imported, so the scripting layer is not even
  //    in the bundle. The 6.x upgrade is a major bump, tracked separately.
  //  CVE-2024-4367 (JS via a crafted font) is structurally gone: the eval-based
  //    font path was removed upstream, and with it the isEvalSupported switch —
  //    it is no longer a member of DocumentInitParameters in 5.x, so passing it
  //    is a type error rather than hardening.
  //
  // enableXfa is already false by default. It is pinned because XFA is a whole
  // second parser, and a default flip upstream would silently widen this
  // surface on the one call that takes untrusted input.
  const doc = await pdfjs.getDocument({ data, enableXfa: false }).promise;
  try {
    const totalPages = doc.numPages;
    const n = Math.min(totalPages, PDF_MAX_PAGES);
    const pages: string[] = [];
    for (let i = 1; i <= n; i++) {
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: PAGE_MAX_DIM / Math.max(base.width, base.height) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('canvas 2d context unavailable');
      // White ground first — PDF pages are allowed a transparent background,
      // which a JPEG would otherwise turn black.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, viewport }).promise;
      pages.push(canvas.toDataURL('image/jpeg', PAGE_JPEG_QUAL));
    }
    return { pages, totalPages };
  } finally {
    doc.destroy().catch(() => { /* already torn down */ });
  }
}
