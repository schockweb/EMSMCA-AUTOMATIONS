/**
 * Loads the Google Maps Places library, from the bundle rather than from an
 * inline <script> in index.html.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The loader used to be an inline <script> block in index.html. One inline
 * script is enough to require `'unsafe-inline'` in the Content-Security-Policy
 * `script-src`, and `'unsafe-inline'` defeats essentially the whole point of
 * the policy: it permits any injected <script> the attacker can get onto the
 * page, which is exactly the class of attack that would read the auth tokens
 * out of localStorage.
 *
 * That mattered more here than usual, because the strict CSP was recorded in
 * "Security Fixes.md" as the compensating control for deferring the move of
 * tokens from localStorage to httpOnly cookies. With `'unsafe-inline'` present
 * the compensating control was inert — the item was ticked and protected
 * nothing.
 *
 * Bundled code is served from /assets with the app's own origin, so `'self'`
 * covers it and the allowance can go.
 *
 * The key is a BUILD-TIME substitution (import.meta.env), same as before — it
 * is a browser-visible key restricted by HTTP referrer at the Google console,
 * not a secret. Nothing about that changes here.
 */

let started = false;

export function loadGoogleMaps(): void {
  // Idempotent: React StrictMode double-invokes effects in development, and a
  // second <script> tag for the Maps API logs a duplicate-loader warning and
  // can re-initialise the Places service under the app.
  if (started) return;

  const key = import.meta.env.VITE_GOOGLE_MAPS_KEY;
  // Vite leaves the literal placeholder in place when the variable is unset at
  // build time; the old inline script guarded against exactly that string.
  if (!key || key === '%VITE_GOOGLE_MAPS_KEY%' || key === 'ci-placeholder') return;

  if (document.querySelector('script[data-google-maps]')) {
    started = true;
    return;
  }

  const s = document.createElement('script');
  s.src =
    `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}` +
    '&libraries=places&loading=async';
  s.async = true;
  s.defer = true;
  s.dataset.googleMaps = 'true';
  document.head.appendChild(s);
  started = true;
}
