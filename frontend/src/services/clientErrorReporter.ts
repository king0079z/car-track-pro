/**
 * Auto-reports runtime problems to /api/audit/client-error (authenticated sessions).
 * Uses fetch — not axios — so a 401 never triggers the global redirect interceptor loop.
 *
 * Covers: uncaught JS, resources, promises, React (boundary), console.error/warn (throttled),
 * CSP violations, Reporting API (deprecations / interventions), axios HTTP failures,
 * dynamic-import / chunk failures, and WebSocket faults (via useWebSocket hooks).
 */
import type { AxiosInstance } from 'axios';
import { API_BASE_URL } from './apiConfig';

const DEDUP_MS = 50_000;
const CONSOLE_WINDOW_MS = 600_000;
const CONSOLE_MAX_IN_WINDOW = 12;
const WARN_WINDOW_MS = 900_000;
const WARN_MAX_IN_WINDOW = 6;
const HTTP_WINDOW_MS = 600_000;
const HTTP_MAX_IN_WINDOW = 24;
const REPORTING_WINDOW_MS = 3_600_000;
const REPORTING_MAX_IN_WINDOW = 8;

const QUEUE_KEY = 'cartrack_pending_client_errors';
const QUEUE_MAX = 28;

const lastSent = new Map<string, number>();
let consoleWindowStart = 0;
let consoleCountInWindow = 0;
let warnWindowStart = 0;
let warnCountInWindow = 0;
let httpWindowStart = 0;
let httpCountInWindow = 0;
let reportingWindowStart = 0;
let reportingCountInWindow = 0;

const SKIP_CONSOLE_SUBSTRINGS = [
  'ResizeObserver loop',
  'ResizeObserver loop completed',
  'Download the React DevTools',
  'react.dev/link/react-devtools',
  'React DevTools',
  '[vite]',
  'Non-Error promise rejection captured',
  '[DOM] Password field is not contained in a form',
  'width(-1) and height(-1) of chart',
];

function shouldSkipConsole(text: string): boolean {
  const t = text.trim();
  if (!t || t.length < 4) return true;
  return SKIP_CONSOLE_SUBSTRINGS.some(s => t.includes(s));
}

/** Normalize volatile segments so duplicate incidents collapse sensibly in dedupe. */
export function normalizeForFingerprint(text: string): string {
  return text
    .replace(/\/\d{1,12}(?=\/|$|\?|#)/g, '/:id')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, ':uuid')
    .replace(/\?[^\s)]*/g, '')
    .slice(0, 520);
}

export function fingerprint(kind: string, message: string, stack?: string): string {
  const basis = `${kind}|${normalizeForFingerprint(message)}|${(stack || '').slice(0, 240)}`;
  let h = 0;
  for (let i = 0; i < basis.length; i++) {
    h = ((h << 5) - h + basis.charCodeAt(i)) | 0;
  }
  return `fp_${Math.abs(h).toString(36)}_${kind}`;
}

function pagePath(): string {
  return `${window.location.pathname}${window.location.search || ''}`;
}

type SendPayload = {
  kind: string;
  message: string;
  stack?: string;
  source?: string;
  lineno?: number;
  colno?: number;
  page_path?: string;
  href?: string;
  component_stack?: string;
  console_preview?: string;
  fingerprint: string;
};

function readQueue(): SendPayload[] {
  try {
    const raw = sessionStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SendPayload[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeQueue(items: SendPayload[]): void {
  try {
    sessionStorage.setItem(QUEUE_KEY, JSON.stringify(items.slice(-QUEUE_MAX)));
  } catch {
    /* quota */
  }
}

function enqueuePending(payload: SendPayload): void {
  const q = readQueue();
  q.push(payload);
  writeQueue(q);
}

declare global {
  interface Window {
    /** Set from `/api/settings/public` — when false, auto client errors are not sent */
    __CARTRACK_REPORT_ERRORS__?: boolean;
  }
}

async function deliver(payload: SendPayload, options?: { allowQueue?: boolean }): Promise<boolean> {
  const allowQueue = options?.allowQueue !== false;
  if (typeof window !== 'undefined' && window.__CARTRACK_REPORT_ERRORS__ === false) {
    return false;
  }
  const token = localStorage.getItem('cartrack_token');
  if (!token) {
    if (allowQueue) enqueuePending(payload);
    return false;
  }

  const now = Date.now();
  const prev = lastSent.get(payload.fingerprint);
  if (prev !== undefined && now - prev < DEDUP_MS) return true;

  const base = (API_BASE_URL || '').replace(/\/$/, '');
  const url = base ? `${base}/api/audit/client-error` : '/api/audit/client-error';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        ...payload,
        page_path: payload.page_path ?? pagePath(),
        href: payload.href ?? window.location.href,
      }),
    });
    if (res.status === 401) return false;
    if (!res.ok) {
      if (allowQueue) enqueuePending(payload);
      return false;
    }
    lastSent.set(payload.fingerprint, now);
    if (lastSent.size > 100) {
      const cutoff = now - DEDUP_MS * 4;
      for (const [k, t] of lastSent) {
        if (t < cutoff) lastSent.delete(k);
      }
    }
    return true;
  } catch {
    if (allowQueue) enqueuePending(payload);
    return false;
  }
}

/** Retry payloads saved when offline or before login. Call after successful login. */
export async function flushPendingClientErrors(): Promise<void> {
  const pending = readQueue();
  if (!pending.length) return;
  writeQueue([]);
  const remaining: SendPayload[] = [];
  for (const item of pending) {
    const ok = await deliver(item, { allowQueue: false });
    if (!ok) remaining.push(item);
  }
  if (remaining.length) {
    const merged = [...readQueue(), ...remaining];
    writeQueue(merged);
  }
}

function send(payload: SendPayload): void {
  void deliver(payload);
}

export function reportClientErrorCapture(args: {
  kind: string;
  message: string;
  stack?: string;
  source?: string;
  lineno?: number;
  colno?: number;
  component_stack?: string;
  console_preview?: string;
  /** Optional stable basis for fingerprint (e.g. HTTP method + normalized path + status). */
  fingerprintBasis?: string;
}): void {
  const fp = args.fingerprintBasis
    ? fingerprint(args.kind, args.fingerprintBasis, args.stack)
    : fingerprint(args.kind, args.message, args.stack);
  void send({
    kind: args.kind,
    message: args.message.slice(0, 8000),
    stack: args.stack?.slice(0, 48000),
    source: args.source,
    lineno: args.lineno,
    colno: args.colno,
    component_stack: args.component_stack?.slice(0, 16000),
    console_preview: args.console_preview?.slice(0, 8000),
    fingerprint: fp,
  });
}

function bumpConsoleQuota(): boolean {
  const now = Date.now();
  if (now - consoleWindowStart > CONSOLE_WINDOW_MS) {
    consoleWindowStart = now;
    consoleCountInWindow = 0;
  }
  if (consoleCountInWindow >= CONSOLE_MAX_IN_WINDOW) return false;
  consoleCountInWindow += 1;
  return true;
}

function bumpWarnQuota(): boolean {
  const now = Date.now();
  if (now - warnWindowStart > WARN_WINDOW_MS) {
    warnWindowStart = now;
    warnCountInWindow = 0;
  }
  if (warnCountInWindow >= WARN_MAX_IN_WINDOW) return false;
  warnCountInWindow += 1;
  return true;
}

function bumpHttpQuota(): boolean {
  const now = Date.now();
  if (now - httpWindowStart > HTTP_WINDOW_MS) {
    httpWindowStart = now;
    httpCountInWindow = 0;
  }
  if (httpCountInWindow >= HTTP_MAX_IN_WINDOW) return false;
  httpCountInWindow += 1;
  return true;
}

function bumpReportingQuota(): boolean {
  const now = Date.now();
  if (now - reportingWindowStart > REPORTING_WINDOW_MS) {
    reportingWindowStart = now;
    reportingCountInWindow = 0;
  }
  if (reportingCountInWindow >= REPORTING_MAX_IN_WINDOW) return false;
  reportingCountInWindow += 1;
  return true;
}

function classifyChunkFailure(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('failed to fetch dynamically imported module') ||
    m.includes('error loading dynamically imported module') ||
    m.includes('importing a module script failed') ||
    m.includes('chunk load error') ||
    m.includes('loading css chunk')
  );
}

/** Axios: capture server faults, rate limits, timeouts, and network failures. */
export function installAxiosErrorReporting(instance: AxiosInstance): void {
  instance.interceptors.response.use(
    res => res,
    err => {
      const status = err.response?.status as number | undefined;
      const cfg = err.config;
      const rawUrl = cfg?.url || '';
      const url = rawUrl.startsWith('http') ? rawUrl.split('/').slice(3).join('/') || rawUrl : rawUrl;
      const method = String(cfg?.method || 'get').toUpperCase();

      if (status === 401 || err.code === 'ERR_CANCELED') {
        return Promise.reject(err);
      }

      const shouldReportHttp =
        !status ||
        status >= 500 ||
        status === 429 ||
        status === 408 ||
        status === 502 ||
        status === 503 ||
        status === 504;

      if (!shouldReportHttp) {
        return Promise.reject(err);
      }

      if (!bumpHttpQuota()) {
        return Promise.reject(err);
      }

      const pathOnly = url.split('?')[0];
      const pathNorm = pathOnly.replace(/\/\d{1,12}(?=\/|$)/g, '/:id');
      let detailStr = '';
      const d = err.response?.data?.detail;
      if (Array.isArray(d)) {
        try {
          detailStr = JSON.stringify(d[0]).slice(0, 280);
        } catch {
          detailStr = '';
        }
      } else if (typeof d === 'string') {
        detailStr = d.slice(0, 280);
      }

      let kind = 'http_client';
      let message: string;
      if (!err.response) {
        kind = 'http_network';
        message = `${method} ${pathNorm}: ${err.code || 'NETWORK'} — ${err.message || 'no response'}`;
      } else {
        message = `${method} ${pathNorm} → HTTP ${status}${detailStr ? ` — ${detailStr}` : ''}`;
        if (status === 429) kind = 'http_rate_limit';
      }

      reportClientErrorCapture({
        kind,
        message: message.slice(0, 8000),
        stack: typeof err.stack === 'string' ? err.stack : undefined,
        console_preview: message.slice(0, 3500),
        fingerprintBasis: `${kind}|${method}|${pathNorm}|${status ?? 'none'}`,
      });

      return Promise.reject(err);
    },
  );
}

/** Call from WebSocket layer — abnormal closes and error events. */
export function reportWebSocketFault(args: { phase: 'error' | 'close'; code?: number; reason?: string }): void {
  const { phase, code, reason } = args;
  if (phase === 'close') {
    if (code === undefined || code === 1000 || code === 1001) return;
    if (code === 1005) return;
  }
  const msg =
    phase === 'error'
      ? 'WebSocket error event (connection fault)'
      : `WebSocket closed abnormally (code ${code ?? '?'}${reason ? `: ${reason.slice(0, 120)}` : ''})`;

  reportClientErrorCapture({
    kind: 'websocket',
    message: msg,
    fingerprintBasis: `websocket|${phase}|${code ?? 'na'}`,
  });
}

export function initClientErrorReporting(): void {
  if (typeof window === 'undefined') return;

  void flushPendingClientErrors();

  window.addEventListener(
    'error',
    event => {
      const err = event.error as Error | undefined;
      const tgt = event.target;
      if (tgt instanceof HTMLElement) {
        const tag = String(tgt.tagName || '').toUpperCase();
        if (['SCRIPT', 'IMG', 'LINK', 'VIDEO', 'AUDIO', 'SOURCE', 'TRACK', 'OBJECT', 'EMBED', 'IFRAME'].includes(tag)) {
          let src =
            (tgt as HTMLImageElement).src ||
            (tgt as HTMLScriptElement).src ||
            (tgt as HTMLLinkElement).href ||
            (tgt as HTMLObjectElement).data ||
            (tgt as HTMLEmbedElement).src ||
            '';
          if (!src && 'currentSrc' in tgt && typeof (tgt as HTMLMediaElement).currentSrc === 'string') {
            src = (tgt as HTMLMediaElement).currentSrc;
          }
          reportClientErrorCapture({
            kind: 'resource',
            message: `Failed to load ${tag}${src ? `: ${src.slice(0, 600)}` : ''}`,
            fingerprintBasis: `resource|${tag}|${normalizeForFingerprint(src)}`,
          });
          return;
        }
      }

      const msg = event.message || err?.message || 'Unknown error';
      const isOpaqueScript = msg === 'Script error.' || msg === 'Uncaught exception: Script error.';
      reportClientErrorCapture({
        kind: isOpaqueScript ? 'uncaught_cross_origin' : 'uncaught',
        message: isOpaqueScript
          ? `${msg} (likely cross-origin script — enable CORS or source maps for full stacks)`
          : msg,
        stack: err?.stack,
        source: event.filename,
        lineno: event.lineno,
        colno: event.colno,
      });
    },
    true,
  );

  window.addEventListener('unhandledrejection', event => {
    const r = event.reason;
    let message = 'Unhandled promise rejection';
    let stack: string | undefined;
    if (r instanceof Error) {
      message = r.message || message;
      stack = r.stack;
    } else if (typeof r === 'string') {
      message = r;
    } else {
      try {
        message = JSON.stringify(r).slice(0, 2000);
      } catch {
        message = String(r);
      }
    }

    const kind = classifyChunkFailure(message) ? 'chunk_load' : 'unhandledrejection';
    reportClientErrorCapture({
      kind,
      message,
      stack,
      fingerprintBasis: classifyChunkFailure(message) ? `chunk|${normalizeForFingerprint(message)}` : undefined,
    });
  });

  document.addEventListener(
    'securitypolicyviolation',
    e => {
      const blocked = e.blockedURI || '';
      const msg = `CSP [${e.violatedDirective || '?'}] blocked ${blocked.slice(0, 400)} (effective ${(e.effectiveDirective || '').slice(0, 80)})`;
      reportClientErrorCapture({
        kind: 'csp',
        message: msg,
        fingerprintBasis: `csp|${e.violatedDirective}|${normalizeForFingerprint(blocked)}`,
      });
    },
    true,
  );

  try {
    if ('ReportingObserver' in window) {
      const RO = (window as unknown as { ReportingObserver: typeof ReportingObserver }).ReportingObserver;
      const obs = new RO(
        list => {
          if (!bumpReportingQuota()) return;
          for (const rep of list) {
            let bodyText = '';
            try {
              bodyText = JSON.stringify(rep.body).slice(0, 4500);
            } catch {
              bodyText = String(rep.body);
            }
            reportClientErrorCapture({
              kind: 'reporting_api',
              message: `[${rep.type}] ${bodyText}`,
              fingerprintBasis: `reporting|${rep.type}|${bodyText.slice(0, 160)}`,
            });
          }
        },
        { types: ['deprecation', 'intervention'], buffered: true },
      );
      obs.observe();
    }
  } catch {
    /* ignore */
  }

  const origErr = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    origErr(...args);
    try {
      const text = args
        .map(a => {
          if (a instanceof Error) return `${a.message}\n${a.stack || ''}`;
          if (typeof a === 'string') return a;
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        })
        .join(' ');
      if (shouldSkipConsole(text)) return;
      if (!bumpConsoleQuota()) return;
      reportClientErrorCapture({
        kind: 'console',
        message: text.slice(0, 6000),
        console_preview: text.slice(0, 4000),
      });
    } catch {
      /* ignore */
    }
  };

  const origWarn = console.warn.bind(console);
  console.warn = (...args: unknown[]) => {
    origWarn(...args);
    try {
      const text = args
        .map(a => {
          if (a instanceof Error) return `${a.message}\n${a.stack || ''}`;
          if (typeof a === 'string') return a;
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        })
        .join(' ');
      if (shouldSkipConsole(text)) return;
      if (!bumpWarnQuota()) return;
      reportClientErrorCapture({
        kind: 'console_warn',
        message: text.slice(0, 5000),
        console_preview: text.slice(0, 2500),
      });
    } catch {
      /* ignore */
    }
  };
}
