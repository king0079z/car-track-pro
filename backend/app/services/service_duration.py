"""
Service duration intelligence.

Canonical shop timing: vehicle entry (visit.entry_time) → supervisor work-order
sign-off (visit.signature_captured_at). Falls back to exit_time when unsigned.
Catalog estimated_duration_minutes is a rolling average from signed work orders.
"""
from __future__ import annotations

from sqlalchemy.orm import Session, joinedload

from ..models.service import Service, ServiceItem
from ..models.visit import Visit
from ..utils.helpers import calculate_duration
from ..utils.qatar_time import qatar_rolling_range_days

DEFAULT_DURATION = 30


def visit_shop_duration_minutes(visit: Visit | None) -> float | None:
    """Minutes from shop entry until supervisor sign-off (or checkout exit)."""
    if not visit or not visit.entry_time:
        return None
    end = visit.signature_captured_at or visit.exit_time
    if not end:
        return None
    return calculate_duration(visit.entry_time, end)


def visit_service_counts(db: Session) -> dict[int, int]:
    from sqlalchemy import func as sqlfunc

    return dict(
        db.query(ServiceItem.visit_id, sqlfunc.count(ServiceItem.id))
        .group_by(ServiceItem.visit_id)
        .all()
    )


def infer_service_item_minutes(
    item: ServiceItem,
    svc: Service,
    visit: Visit | None,
    visit_service_counts: dict[int, int],
) -> tuple[float | None, str]:
    """
    Return (minutes, source).
    Priority: line-item measured time → allocated shop entry→sign-off duration.
    """
    if item.actual_duration_minutes:
        return float(item.actual_duration_minutes), "measured"

    shop_mins = visit_shop_duration_minutes(visit)
    if shop_mins is None:
        return None, "none"

    svc_count = visit_service_counts.get(item.visit_id, 1)
    if svc_count == 1:
        return float(shop_mins), "shop_signature"

    total_est = sum(
        (si.service.estimated_duration_minutes or DEFAULT_DURATION)
        for si in (visit.service_items or [])
        if si.service
    )
    if total_est <= 0:
        return float(shop_mins) / max(svc_count, 1), "shop_signature"

    share = (svc.estimated_duration_minutes or DEFAULT_DURATION) / total_est
    return float(shop_mins) * share, "shop_signature"


def collect_service_duration_samples(
    db: Session,
    *,
    service_id: int | None = None,
    days: int = 365,
) -> list[tuple[float, str]]:
    """Duration samples from work orders with shop timing (signed or checked out)."""
    if service_id is None:
        return []

    start_dt, end_dt = qatar_rolling_range_days(days)
    rows = (
        db.query(ServiceItem, Service, Visit)
        .join(Service, ServiceItem.service_id == Service.id)
        .join(Visit, ServiceItem.visit_id == Visit.id)
        .options(
            joinedload(ServiceItem.visit).joinedload(Visit.service_items).joinedload(ServiceItem.service)
        )
        .filter(
            Service.id == service_id,
            Visit.entry_time >= start_dt,
            Visit.entry_time <= end_dt,
        )
        .all()
    )

    counts = visit_service_counts(db)
    samples: list[tuple[float, str]] = []
    for item, svc, visit in rows:
        if not visit.signature_captured_at and not visit.exit_time:
            continue
        item.visit = visit
        minutes, source = infer_service_item_minutes(item, svc, visit, counts)
        if minutes is not None and minutes > 0:
            samples.append((minutes, source))
    return samples


def compute_average_duration(samples: list[tuple[float, str]]) -> tuple[int | None, str]:
    if not samples:
        return None, "default"
    avg = round(sum(s[0] for s in samples) / len(samples))
    sources = {s[1] for s in samples}
    if "shop_signature" in sources:
        src = "shop_signature"
    elif "measured" in sources:
        src = "measured"
    else:
        src = "default"
    return max(1, avg), src


def category_default_duration(db: Session, category) -> int:
    rows = (
        db.query(Service.estimated_duration_minutes)
        .filter(Service.is_active.is_(True), Service.category == category)
        .all()
    )
    vals = [r[0] for r in rows if r[0] and r[0] > 0]
    return max(1, round(sum(vals) / len(vals))) if vals else DEFAULT_DURATION


def recompute_and_update_service_duration(db: Session, service_id: int) -> int:
    samples = collect_service_duration_samples(db, service_id=service_id)
    avg, _src = compute_average_duration(samples)
    svc = db.query(Service).filter(Service.id == service_id).first()
    if not svc:
        return DEFAULT_DURATION
    if avg is not None:
        svc.estimated_duration_minutes = avg
    elif not svc.estimated_duration_minutes:
        svc.estimated_duration_minutes = category_default_duration(db, svc.category)
    return svc.estimated_duration_minutes or DEFAULT_DURATION


def sync_visit_shop_duration(db: Session, visit: Visit) -> None:
    """Persist visit shop duration and refresh catalog averages for its services."""
    mins = visit_shop_duration_minutes(visit)
    if mins is not None:
        visit.duration_minutes = mins

    if visit.id and not visit.service_items:
        visit = (
            db.query(Visit)
            .options(joinedload(Visit.service_items))
            .filter(Visit.id == visit.id)
            .first()
        ) or visit

    service_ids = {si.service_id for si in (visit.service_items or [])}
    for sid in service_ids:
        recompute_and_update_service_duration(db, sid)


def service_duration_insight(db: Session, service: Service) -> dict:
    samples = collect_service_duration_samples(db, service_id=service.id)
    avg, src = compute_average_duration(samples)
    if samples:
        return {
            "estimated_duration_minutes": avg,
            "duration_job_count": len(samples),
            "duration_source": src,
            "is_auto_calculated": True,
        }
    est = service.estimated_duration_minutes or category_default_duration(db, service.category)
    return {
        "estimated_duration_minutes": est,
        "duration_job_count": 0,
        "duration_source": "category_default",
        "is_auto_calculated": False,
    }
