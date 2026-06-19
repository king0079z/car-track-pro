"""
Service duration intelligence.

Canonical shop timing: first camera presence / shop entry until work order
checkout (Done) or live now for open visits. Supervisor sign-off at issuance
does NOT end the timer — payment/checkout does.
"""
from __future__ import annotations

from sqlalchemy.orm import Session, joinedload

from ..models.service import Service, ServiceItem
from ..models.visit import Visit, VisitStatus
from ..utils.helpers import calculate_duration
from ..utils.qatar_time import qatar_rolling_range_days

DEFAULT_DURATION = 30


def visit_shop_duration_minutes(visit: Visit | None) -> float | None:
    """
    Minutes in shop: camera-tracked ANPR presence when available, else entry → exit/now.

    Camera dwell is authoritative — a work order can stay open for hours while the
    vehicle is only visible on camera for minutes.
    """
    if not visit or not visit.entry_time:
        return None

    cam_mins: float | None = None
    if visit.anpr_camera_seconds and float(visit.anpr_camera_seconds) > 0:
        cam_mins = round(float(visit.anpr_camera_seconds) / 60, 2)

    if cam_mins is not None:
        return cam_mins

    if visit.exit_time is not None or visit.status == VisitStatus.COMPLETED:
        end = visit.exit_time
        if end is not None:
            wall = calculate_duration(visit.entry_time, end)
            if wall > 0:
                return wall
        stored = visit.duration_minutes
        return float(stored) if stored and stored > 0 else 0.0

    return calculate_duration(visit.entry_time, None)


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
    Priority: line-item measured time → allocated shop entry→checkout duration.
    """
    if item.actual_duration_minutes and float(item.actual_duration_minutes) > 0:
        return float(item.actual_duration_minutes), "measured"

    shop_mins = visit_shop_duration_minutes(visit)
    if shop_mins is None or shop_mins <= 0:
        return None, "none"

    svc_count = visit_service_counts.get(item.visit_id, 1)
    if svc_count == 1:
        return float(shop_mins), "shop_presence"

    total_est = sum(
        (si.service.estimated_duration_minutes or DEFAULT_DURATION)
        for si in (visit.service_items or [])
        if si.service
    )
    if total_est <= 0:
        return float(shop_mins) / max(svc_count, 1), "shop_presence"

    share = (svc.estimated_duration_minutes or DEFAULT_DURATION) / total_est
    return float(shop_mins) * share, "shop_presence"


def collect_service_duration_samples(
    db: Session,
    *,
    service_id: int | None = None,
    days: int = 365,
) -> list[tuple[float, str]]:
    """Duration samples from completed work orders with shop timing."""
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
            Visit.status == VisitStatus.COMPLETED,
        )
        .all()
    )

    counts = visit_service_counts(db)
    samples: list[tuple[float, str]] = []
    for item, svc, visit in rows:
        if not visit.exit_time and visit.status != VisitStatus.COMPLETED:
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
    if "shop_presence" in sources:
        src = "shop_presence"
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
    from .camera_presence import recompute_visit_camera_seconds

    if visit.id and visit.status != VisitStatus.COMPLETED:
        recompute_visit_camera_seconds(db, visit)

    mins = visit_shop_duration_minutes(visit)
    if mins is not None and mins > 0:
        visit.duration_minutes = mins

    if visit.id and not visit.service_items:
        visit = (
            db.query(Visit)
            .options(joinedload(Visit.service_items))
            .filter(Visit.id == visit.id)
            .first()
        ) or visit

    if visit.status == VisitStatus.COMPLETED:
        service_ids = {si.service_id for si in (visit.service_items or [])}
        for sid in service_ids:
            recompute_and_update_service_duration(db, sid)


def backfill_completed_visit_durations(db: Session) -> int:
    """Recalculate duration on completed visits (camera-first when ANPR data exists)."""
    from .camera_presence import recompute_visit_camera_seconds

    rows = (
        db.query(Visit)
        .filter(Visit.status == VisitStatus.COMPLETED)
        .all()
    )
    fixed = 0
    for visit in rows:
        if visit.id:
            recompute_visit_camera_seconds(db, visit)
        mins = visit_shop_duration_minutes(visit)
        if mins is not None and mins >= 0:
            if visit.duration_minutes != mins:
                visit.duration_minutes = mins
                fixed += 1
    if fixed:
        db.commit()
    return fixed


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
