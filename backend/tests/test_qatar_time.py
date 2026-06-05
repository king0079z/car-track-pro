"""Sanity checks for Asia/Qatar business-day helpers."""

from datetime import UTC, date, datetime

import pytest

import app.utils.qatar_time as qt
from app.utils.qatar_time import (
    date_key_qatar,
    hour_key_qatar,
    month_key_qatar,
    qatar_day_start_end,
    qatar_rolling_range_days,
    qatar_today,
    qatar_year_now,
)


@pytest.fixture(autouse=True)
def _fixed_org_timezone_asia_qatar(monkeypatch):
    """Tests assume Asia/Qatar regardless of repo settings.json."""
    monkeypatch.setattr(qt, "_read_timezone_from_file", lambda: "Asia/Qatar")
    qt.invalidate_business_timezone_cache()
    yield
    qt.invalidate_business_timezone_cache()


def test_qatar_day_start_end_bounds():
    d = date(2026, 5, 12)
    start, end = qatar_day_start_end(d)
    assert start.tzinfo is not None and end.tzinfo is not None
    assert start.hour == 0 and start.minute == 0
    assert end.hour == 23
    assert start.utcoffset().total_seconds() == 3 * 3600


def test_hour_key_qatar_from_utc():
    # 2026-05-12 21:30 UTC = 2026-05-13 00:30 Qatar → hour 00
    dt = datetime(2026, 5, 12, 21, 30, tzinfo=UTC)
    assert hour_key_qatar(dt) == "00"


def test_qatar_rolling_range_days_bounds():
    a, b = qatar_rolling_range_days(7)
    assert a.tzinfo is not None and b.tzinfo is not None
    assert a <= b


def test_date_key_qatar():
    dt = datetime(2026, 5, 12, 21, 30, tzinfo=UTC)
    assert date_key_qatar(dt) == "2026-05-13"


def test_month_key_qatar():
    dt = datetime(2026, 5, 12, 21, 30, tzinfo=UTC)
    assert month_key_qatar(dt) == 5


def test_qatar_year_now():
    assert isinstance(qatar_year_now(), int)


def test_hour_key_qatar_naive_treated_as_utc():
    dt = datetime(2026, 5, 12, 21, 30)
    assert hour_key_qatar(dt) == "00"


def test_qatar_today_returns_date():
    assert isinstance(qatar_today(), date)
