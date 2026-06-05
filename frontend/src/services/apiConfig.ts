/** Shared API base URL — kept separate from `api.ts` so error reporting can import without circular deps. */

function resolveApiBase(): string {
  if (import.meta.env.VITE_GATEWAY_MODE === 'true') return '';
  // Dev: same-origin via Vite proxy (/api → :8001) — avoids ERR_CONNECTION_RESET when backend reloads.
  if (import.meta.env.DEV && import.meta.env.VITE_API_DIRECT !== 'true') return '';
  const explicit = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '');
  if (explicit) return explicit;
  // Vercel / HTTPS hosting: must set VITE_API_URL to your FastAPI backend (see docs/VERCEL.md).
  if (typeof location !== 'undefined' && location.hostname.includes('vercel.app')) {
    return '';
  }
  return 'http://localhost:8001';
}

export const API_BASE_URL = resolveApiBase();

function resolveWsUrl(): string {
  const explicit = import.meta.env.VITE_WS_URL as string | undefined;
  if (explicit) return explicit.replace(/\/$/, '');
  if (API_BASE_URL) {
    return API_BASE_URL.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:') + '/ws';
  }
  if (typeof location !== 'undefined') {
    return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  }
  return '';
}

export const WS_URL = resolveWsUrl();

/** True when the UI is on Vercel but no backend URL was baked in at build time. */
export const VERCEL_MISSING_API =
  typeof location !== 'undefined'
  && location.hostname.includes('vercel.app')
  && !API_BASE_URL;
