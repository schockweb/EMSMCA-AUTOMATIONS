/**
 * Manual mock for the `axios` package (Vitest picks this up whenever a test
 * calls `vi.mock('axios')` with no inline factory).
 *
 * Why this exists: `src/api/client.ts` does `const api = axios.create()` and
 * immediately wires `api.interceptors.request/response.use(...)`. Vitest's
 * automatic mock makes `axios.create()` return `undefined`, so the client blew
 * up at import time ("Cannot read properties of undefined (reading
 * 'interceptors')") and took every suite that transitively imports it down with
 * it (PRFView -> client.ts).
 *
 * The instance returned by `create()` re-uses the SAME top-level mock fns
 * (`get`, `post`, ...), so a test that configures `vi.mocked(axios.get)` also
 * controls what the `api` instance returns — which is exactly what the PDF
 * suites rely on (PRFView imports the instance but calls `.get` on it).
 */
import { vi } from 'vitest';

const get = vi.fn();
const post = vi.fn();
const put = vi.fn();
const patch = vi.fn();
const del = vi.fn();

const interceptors = {
  request: { use: vi.fn(), eject: vi.fn() },
  response: { use: vi.fn(), eject: vi.fn() },
};

// The object `axios.create()` hands back — same method refs as the top-level
// export so `vi.mocked(axios.get)` and `api.get` are one and the same mock.
const instance = {
  get,
  post,
  put,
  patch,
  delete: del,
  request: vi.fn(),
  interceptors,
  defaults: { headers: { common: {} } },
};

// The default export mirrors the instance and adds `create()`.
const axios: any = {
  ...instance,
  create: vi.fn(() => instance),
  isAxiosError: (e: any) => Boolean(e && e.isAxiosError),
};

export default axios;
export { get, post, put, patch, del as delete };
