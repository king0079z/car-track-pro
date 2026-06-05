"""Business calendar using the organization timezone from settings.json (IANA, default Asia/Qatar)."""

from __future__ import annotations

import json
import threading
import time
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo, available_timezones

_SETTINGS_JSON = Path(__file__).resolve().parents[2] / "settings.json"
_DEFAULT_TZ_NAME = "Asia/Qatar"
_LOCK = threading.Lock()
_CACHE_NAME: str | None = None
_CACHE_MONO: float = -1e9
_CACHE_TTL_SEC = 2.0


def invalidate_business_timezone_cache() -> None:
    """Call after settings.json is updated so the next read picks up the new zone."""
    global _CACHE_NAME, _CACHE_MONO
    with _LOCK:
        _CACHE_NAME = None
        _CACHE_MONO = -1e9


def _read_timezone_from_file() -> str:
    try:
        if _SETTINGS_JSON.exists():
            data = json.loads(_SETTINGS_JSON.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                raw = (data.get("timezone") or "").strip()
                if raw and raw in available_timezones():
                    return raw
    except Exception:
        pass
    return _DEFAULT_TZ_NAME


def get_business_timezone_name() -> str:
    """IANA zone name from persisted settings (cached briefly)."""
    global _CACHE_NAME, _CACHE_MONO
    now = time.monotonic()
    with _LOCK:
        if _CACHE_NAME is not None and now - _CACHE_MONO < _CACHE_TTL_SEC:
            return _CACHE_NAME
    name = _read_timezone_from_file()
    with _LOCK:
        _CACHE_NAME = name
        _CACHE_MONO = now
    return name


def get_business_zoneinfo() -> ZoneInfo:
    return ZoneInfo(get_business_timezone_name())


def qatar_today() -> date:
    """Current calendar date in the configured business timezone."""
    return datetime.now(get_business_zoneinfo()).date()


def qatar_year_now() -> int:
    """Gregorian year as of the current instant in the business timezone."""
    return datetime.now(get_business_zoneinfo()).year


def qatar_day_start_end(d: date) -> tuple[datetime, datetime]:
    """
    Inclusive [start, end] for local calendar day ``d`` in the business timezone,
    as timezone-aware datetimes (safe for DateTime(timezone=True) columns).
    """
    tz = get_business_zoneinfo()
    start = datetime(d.year, d.month, d.day, 0, 0, 0, tzinfo=tz)
    end = datetime(d.year, d.month, d.day, 23, 59, 59, 999999, tzinfo=tz)
    return start, end


def qatar_rolling_range_days(days: int) -> tuple[datetime, datetime]:
    """
    From 00:00 business TZ on (today − (days − 1)) through end of today in that zone.
    """
    today = qatar_today()
    start_day = today - timedelta(days=days - 1)
    start, _ = qatar_day_start_end(start_day)
    _, end = qatar_day_start_end(today)
    return start, end


def hour_key_qatar(dt: datetime | None) -> str:
    """Hour bucket 00–23 as string, using wall clock in the business timezone."""
    if dt is None:
        return "00"
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    h = dt.astimezone(get_business_zoneinfo()).hour
    return f"{h:02d}"


def date_key_qatar(dt: datetime | None) -> str:
    """ISO calendar date (YYYY-MM-DD) in the business timezone for grouping."""
    if dt is None:
        return qatar_today().isoformat()
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone(get_business_zoneinfo()).date().isoformat()


def month_key_qatar(dt: datetime | None) -> int:
    """Month 1–12 in the business timezone."""
    if dt is None:
        return datetime.now(get_business_zoneinfo()).month
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone(get_business_zoneinfo()).month
