/**
 * Organization-facing calendar and clock: driven by the IANA timezone from Settings
 * (synced from GET /api/settings/public into localStorage). Default Asia/Qatar.
 */

const STORAGE_KEY = 'cartrack_org_timezone';
export const DEFAULT_ORG_TIMEZONE = 'Asia/Qatar';

/** @deprecated use DEFAULT_ORG_TIMEZONE or getClientTimeZone() */
export const ASIA_QATAR = DEFAULT_ORG_TIMEZONE;

function isValidIanaTimeZone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export function getClientTimeZone(): string {
  if (typeof window === 'undefined') return DEFAULT_ORG_TIMEZONE;
  try {
    const v = window.localStorage.getItem(STORAGE_KEY)?.trim();
    if (v && isValidIanaTimeZone(v)) return v;
  } catch {
    /* ignore */
  }
  return DEFAULT_ORG_TIMEZONE;
}

export function setClientTimeZone(iana: string): void {
  const z = iana.trim();
  if (!z || !isValidIanaTimeZone(z) || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, z);
  } catch {
    /* ignore */
  }
}

export function syncClientTimeFromPublicSettings(data: { timezone?: string } | null | undefined): void {
  const z = data?.timezone?.trim();
  if (z && isValidIanaTimeZone(z)) setClientTimeZone(z);
}

function calendarDateInTz(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

/** First instant (UTC) of calendar day `ymd` (YYYY-MM-DD) in `timeZone`. */
export function utcInstantAtStartOfZonedDay(ymd: string, timeZone: string): Date {
  const parts = ymd.split('-').map(Number);
  const y = parts[0];
  const mo = parts[1];
  const d = parts[2];
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return new Date(NaN);

  let u = Date.UTC(y, mo - 1, d, 12, 0, 0, 0);
  for (let i = 0; i < 96; i++) {
    const cur = calendarDateInTz(u, timeZone);
    if (cur === ymd) break;
    u += (cur < ymd ? 1 : -1) * 3600000;
  }

  let step = 3600000;
  while (step >= 1) {
    while (calendarDateInTz(u - step, timeZone) === ymd) u -= step;
    if (step === 3600000) step = 60000;
    else if (step === 60000) step = 1000;
    else if (step === 1000) step = 1;
    else break;
  }
  while (calendarDateInTz(u - 1, timeZone) === ymd) u -= 1;
  return new Date(u);
}

/** Last millisecond of calendar day `ymd` in `timeZone` (as UTC Date). */
export function utcInstantAtEndOfZonedDay(ymd: string, timeZone: string): Date {
  const startMs = utcInstantAtStartOfZonedDay(ymd, timeZone).getTime();
  let hi = startMs + 3600000;
  let guard = 0;
  while (calendarDateInTz(hi, timeZone) === ymd && guard++ < 168) hi += 3600000;

  let lo = startMs;
  if (calendarDateInTz(hi, timeZone) === ymd) {
    return new Date(startMs);
  }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (calendarDateInTz(mid, timeZone) === ymd) lo = mid;
    else hi = mid;
  }
  return new Date(lo);
}

/** Today's calendar date YYYY-MM-DD in the active org timezone. */
export function qatarYmd(d: Date = new Date()): string {
  const tz = getClientTimeZone();
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** Add signed calendar days to a YMD in the org timezone (midnight-to-midnight semantics). */
export function qatarYmdAddDays(ymd: string, deltaDays: number): string {
  const tz = getClientTimeZone();
  const start = utcInstantAtStartOfZonedDay(ymd, tz).getTime();
  return qatarYmd(new Date(start + deltaDays * 86400000));
}

export function zonedBoundsFromYmd(ymd: string): { start: Date; end: Date } {
  const tz = getClientTimeZone();
  return {
    start: utcInstantAtStartOfZonedDay(ymd, tz),
    end: utcInstantAtEndOfZonedDay(ymd, tz),
  };
}

export function qatarStartOfToday(d: Date = new Date()): Date {
  return zonedBoundsFromYmd(qatarYmd(d)).start;
}

export function qatarEndOfToday(d: Date = new Date()): Date {
  return zonedBoundsFromYmd(qatarYmd(d)).end;
}

function zonedYearMonth(d: Date): { y: number; m: number } {
  const tz = getClientTimeZone();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric',
    month: 'numeric',
  }).formatToParts(d);
  const y = Number(parts.find(p => p.type === 'year')?.value ?? 0);
  const m = Number(parts.find(p => p.type === 'month')?.value ?? 1);
  return { y, m };
}

export function qatarStartOfMonth(d: Date = new Date()): Date {
  const { y, m } = zonedYearMonth(d);
  const ymd = `${y}-${String(m).padStart(2, '0')}-01`;
  return utcInstantAtStartOfZonedDay(ymd, getClientTimeZone());
}

/** Monday 00:00 org TZ of the week containing `d` (ISO week: Mon–Sun). */
export function qatarStartOfWeekMonday(d: Date = new Date()): Date {
  const tz = getClientTimeZone();
  const ymd = qatarYmd(d);
  const wd = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long' }).format(d);
  const order = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const idx = order.indexOf(wd);
  const back = idx >= 0 ? idx : 0;
  return zonedBoundsFromYmd(qatarYmdAddDays(ymd, -back)).start;
}

export function qatarHour(d: Date = new Date()): number {
  const tz = getClientTimeZone();
  const v = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' })
    .formatToParts(d)
    .find(p => p.type === 'hour')?.value;
  return Number(v ?? 0);
}

export function qatarYearNow(d: Date = new Date()): number {
  const tz = getClientTimeZone();
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric' }).format(d));
}

export function fmtQatarDateLong(d: Date = new Date()): string {
  const tz = getClientTimeZone();
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(d);
}

export function fmtQatarClock(d: Date): string {
  const tz = getClientTimeZone();
  return new Intl.DateTimeFormat(undefined, {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(d);
}

export function fmtQatarEntryHm(iso: string): string {
  const tz = getClientTimeZone();
  return new Intl.DateTimeFormat(undefined, {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

export type QatarFmt =
  | 'full'
  | 'dateMed'
  | 'shortDate'
  | 'hm'
  | 'dmyHm'
  | 'md'
  | 'yyyyMmDd'
  | 'csvDmyHm'
  | 'pp'
  | 'dayMonEn'
  | 'medDate';

/** Format an instant in the org timezone for display. */
export function fmtQatar(iso: string | Date | null | undefined, pattern: QatarFmt): string {
  if (iso == null || iso === '') return '—';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return '—';
  const tz = getClientTimeZone();
  switch (pattern) {
    case 'yyyyMmDd':
      return qatarYmd(d);
    case 'md':
      return new Intl.DateTimeFormat(undefined, { timeZone: tz, month: 'short', day: 'numeric' }).format(d);
    case 'hm':
      return new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
    case 'shortDate':
      return new Intl.DateTimeFormat(undefined, { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
    case 'csvDmyHm':
      return new Intl.DateTimeFormat(undefined, {
        timeZone: tz,
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(d);
    case 'dmyHm':
      return new Intl.DateTimeFormat(undefined, {
        timeZone: tz,
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(d);
    case 'dateMed':
      return new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(d);
    case 'pp':
      return new Intl.DateTimeFormat(undefined, {
        timeZone: tz,
        dateStyle: 'long',
        timeStyle: 'short',
      }).format(d);
    case 'dayMonEn':
      return new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        day: '2-digit',
        month: 'short',
      }).format(d);
    case 'medDate':
      return new Intl.DateTimeFormat(undefined, { timeZone: tz, dateStyle: 'medium' }).format(d);
    case 'full':
    default:
      return new Intl.DateTimeFormat(undefined, {
        timeZone: tz,
        weekday: 'long',
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(d);
  }
}
