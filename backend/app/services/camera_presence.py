"""
Camera presence → work order duration.

Rules:
- Accumulate in-frame dwell (VisionFlow segment seconds) on open work orders.
- Same plate may leave frame (Done) and return within PLATE_RESUME_GAP_SEC — recording resumes.
- Supervisor sign-off freezes camera accumulation immediately (work confirmed complete).
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import func
from sqlalchemy.orm import Session

from ..config import settings
from ..models.anpr import ANPRDetection
from ..models.visit import Visit, VisitStatus
from ..models.vehicle import Vehicle
from ..utils.plates import format_qatar_plate, plates_match, plates_match


def resume_gap() -> timedelta:
    return timedelta(seconds=float(settings.PLATE_RESUME_GAP_SEC))


def camera_recording_frozen(visit: Visit | None) -> bool:
    """True once supervisor has signed — camera dwell must not increase."""
    return bool(visit and visit.signature_captured_at)


def _vehicle_for_plate(db: Session, plate: str) -> Vehicle | None:
    plate_u = format_qatar_plate(plate).upper()
    exact = db.query(Vehicle).filter(Vehicle.plate_number == plate_u).first()
    if exact:
        return exact
    for v in db.query(Vehicle).order_by(Vehicle.id.desc()).limit(500):
        if plates_match(v.plate_number or "", plate_u):
            return v
    return None


def last_plate_activity_at(db: Session, plate: str, *, visit_id: int | None = None) -> datetime | None:
    plate_u = format_qatar_plate(plate).upper()
    rows = db.query(ANPRDetection).filter(ANPRDetection.detected_at.isnot(None))
    if visit_id is not None:
        rows = rows.filter(
            (ANPRDetection.visit_id == visit_id) | (ANPRDetection.plate == plate_u)
        )
    else:
        rows = rows.filter(ANPRDetection.plate == plate_u)
    candidates = rows.all()
    if visit_id is not None:
        matched = [r for r in candidates if r.visit_id == visit_id or plates_match(r.plate, plate_u)]
    else:
        matched = [r for r in candidates if plates_match(r.plate, plate_u)]
    if not matched:
        return None
    return max(r.detected_at for r in matched if r.detected_at)


def find_recording_visit(db: Session, plate: str) -> Visit | None:
    """
    Latest open, unsigned work order for this plate that is still within the resume window.
    """
    plate_u = format_qatar_plate(plate).upper()
    vehicle = _vehicle_for_plate(db, plate_u)
    if not vehicle:
        return None

    visit = (
        db.query(Visit)
        .filter(
            Visit.vehicle_id == vehicle.id,
            Visit.signature_captured_at.is_(None),
            Visit.status.in_([
                VisitStatus.WAITING,
                VisitStatus.IN_SERVICE,
                VisitStatus.ON_HOLD,
            ]),
        )
        .order_by(Visit.entry_time.desc())
        .first()
    )
    if not visit:
        return None

    last = last_plate_activity_at(db, plate_u, visit_id=visit.id)
    if last is not None:
        now = datetime.now(UTC)
        last_utc = last if last.tzinfo else last.replace(tzinfo=UTC)
        if now - last_utc > resume_gap():
            return None
    return visit


def segment_already_synced(
    existing_rows: list[ANPRDetection],
    plate: str,
    track_id: int | None,
    t_exit_sec: float | None,
) -> bool:
    """Per-segment dedupe — same plate may sync many times across bay moves in one live job."""
    for row in existing_rows:
        if not plates_match(plate, row.plate):
            continue
        if track_id is not None and row.track_id == track_id:
            if t_exit_sec is None or row.t_exit_sec is None:
                return True
            if abs(float(row.t_exit_sec) - float(t_exit_sec)) < 0.35:
                return True
    return False


def recompute_visit_camera_seconds(db: Session, visit: Visit) -> float:
    """Sum in-frame seconds from all ANPR rows linked to this visit."""
    db.flush()
    rows = db.query(ANPRDetection).filter(ANPRDetection.visit_id == visit.id).all()
    total = sum(float(r.duration_sec or 0) for r in rows)
    visit.anpr_camera_seconds = round(total, 3)
    db.flush()
    return visit.anpr_camera_seconds


def apply_camera_segment(
    db: Session,
    *,
    plate: str,
    detection: ANPRDetection,
) -> Visit | None:
    """
    Link an exited camera segment to an eligible work order and refresh cumulative dwell.
    Returns the visit if linked; None if pending registration or recording is frozen.
    """
    visit = find_recording_visit(db, plate)
    if visit is None:
        return None
    if camera_recording_frozen(visit):
        return None

    detection.visit_id = visit.id
    if detection.vehicle_id is None and visit.vehicle_id:
        detection.vehicle_id = visit.vehicle_id

    recompute_visit_camera_seconds(db, visit)
    return visit


def link_job_segments_to_visits(db: Session, job_id: str) -> int:
    """
    After syncing exited segments for a live job, attach every segment for the same plate
    to the current unsigned work order (within the resume window) and refresh dwell totals.
    """
    rows = (
        db.query(ANPRDetection)
        .filter(ANPRDetection.job_id == job_id)
        .order_by(ANPRDetection.id.asc())
        .all()
    )
    if not rows:
        return 0
    visit_by_plate: dict[str, Visit] = {}
    linked = 0
    for row in rows:
        plate_key = format_qatar_plate(row.plate or "").upper()
        if not plate_key:
            continue
        visit = visit_by_plate.get(plate_key)
        if visit is None:
            visit = find_recording_visit(db, plate_key)
            if visit is not None:
                visit_by_plate[plate_key] = visit
        if visit is None or camera_recording_frozen(visit):
            continue
        row.visit_id = visit.id
        if row.vehicle_id is None and visit.vehicle_id:
            row.vehicle_id = visit.vehicle_id
        linked += 1
    db.flush()
    for visit in visit_by_plate.values():
        recompute_visit_camera_seconds(db, visit)
    return linked


def freeze_visit_camera_recording(db: Session, visit: Visit) -> None:
    """Call when supervisor signs — stop adding camera dwell; shop timing takes over."""
    if visit.id:
        recompute_visit_camera_seconds(db, visit)
