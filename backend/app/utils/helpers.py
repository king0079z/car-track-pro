from datetime import UTC, datetime
import random
import string
from typing import Optional

from .qatar_time import get_business_zoneinfo


def generate_visit_number() -> str:
    """Unique work order number stored in visits.visit_number."""
    date_part = datetime.now(get_business_zoneinfo()).strftime("%Y%m%d")
    rand_part = "".join(random.choices(string.ascii_uppercase + string.digits, k=5))
    return f"WO-{date_part}-{rand_part}"


def calculate_duration(entry: datetime, exit: Optional[datetime] = None) -> float:
    """Minutes between entry and exit (or now), normalized to UTC for mixed naive/aware DB values."""
    end = exit or datetime.now(UTC)
    e = entry
    x = end
    if e.tzinfo is None:
        e = e.replace(tzinfo=UTC)
    else:
        e = e.astimezone(UTC)
    if x.tzinfo is None:
        x = x.replace(tzinfo=UTC)
    else:
        x = x.astimezone(UTC)
    sec = max(0.0, (x - e).total_seconds())
    return round(sec / 60, 2)


def format_duration(minutes: float) -> str:
    if minutes < 60:
        return f"{int(minutes)}m"
    hours = int(minutes // 60)
    mins = int(minutes % 60)
    return f"{hours}h {mins}m"
