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
from ..utils.plates import format_qatar_plate, plates_match


def resume_gap() -> timedelta:
    return timedelta(seconds=float(settings.PLATE_RESUME_GAP_SEC))


def camera_recording_frozen(visit: Visit | None) -> bool:
    """True once the work order is checked out — camera dwell must not increase."""
    if not visit:
        return False
    return visit.status == VisitStatus.COMPLETED or visit.exit_time is not None


def _vehicle_for_plate(db: Session, plate: str) -> Vehicle | None:
    plate_u = format_qatar_plate(plate).upper()
    exact = db.query(Vehicle).filter(Vehicle.plate_number == plate_u).first()
    if exact:
        return exact
    for v in db.query(Vehicle).order_by(Vehicle.id.desc()).limit(500):
        if plates_match(v.plate_number or "", plate_u):
            return v
    return None


def _as_utc(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt.astimezone(UTC)


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
    latest = max(_as_utc(r.detected_at) for r in matched if r.detected_at)
    return latest


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
        if datetime.now(UTC) - last > resume_gap():
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
    """Sum shop presence time from ANPR rows (falls back to in-frame segment dwell)."""
    db.flush()
    rows = db.query(ANPRDetection).filter(ANPRDetection.visit_id == visit.id).all()
    presence = [float(r.presence_duration_sec) for r in rows if r.presence_duration_sec is not None]
    if presence:
        total = max(presence)
    else:
        total = sum(float(r.duration_sec or 0) for r in rows)
    visit.anpr_camera_seconds = round(total, 3)
    db.flush()
    return visit.anpr_camera_seconds


def refresh_live_presence_from_manifest(
    db: Session,
    *,
    job_id: str,
    rows: list[dict],
) -> int:
    """Push live shop-presence seconds to open unsigned work orders."""
    from ..utils.plates import format_qatar_plate, sync_eligible_plate

    updated = 0
    jurisdiction = str(getattr(settings, "PLATE_JURISDICTION", "qa_uk") or "qa_uk")
    seen_plates: set[str] = set()
    for v in rows or []:
        pds = v.get("presence_duration_sec")
        if pds is None:
            continue
        plate_raw = str(v.get("plate") or "").strip()
        if not plate_raw or plate_raw in ("—", "…", "Unknown", "UNKNOWN"):
            continue
        if not sync_eligible_plate(plate_raw, jurisdiction=jurisdiction):
            continue
        plate_key = format_qatar_plate(plate_raw).upper()
        if plate_key in seen_plates:
            continue
        seen_plates.add(plate_key)
        visit = find_recording_visit(db, plate_key)
        if visit is None or camera_recording_frozen(visit):
            continue
        secs = round(float(pds), 3)
        visit.anpr_camera_seconds = secs
        latest = (
            db.query(ANPRDetection)
            .filter(ANPRDetection.job_id == job_id, ANPRDetection.plate == plate_key)
            .order_by(ANPRDetection.id.desc())
            .first()
        )
        if latest is not None:
            latest.presence_duration_sec = secs
        updated += 1
    if updated:
        db.flush()
    return updated


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
    """Call on checkout — finalize camera dwell totals."""
    if visit.id:
        recompute_visit_camera_seconds(db, visit)
