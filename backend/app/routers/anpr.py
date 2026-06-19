"""
ANPR integration router — bridges VisionFlow plate detections with the CarTrack database.

POST /api/anpr/sync          — called by the frontend after a VisionFlow job finishes;
                               bulk-inserts detections & auto-links to existing vehicles.
GET  /api/anpr/recent        — last N detections with linked vehicle / visit info.
GET  /api/anpr/plate/{plate} — all detections for a specific plate number.
POST /api/anpr/{id}/visit    — create a Visit (and optionally a Vehicle) from one detection.
GET  /api/anpr/stats         — today's detection count, unique plates, avg speed.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session, joinedload

from ..database import get_db
from ..models.anpr import ANPRDetection
from ..models.vehicle import Vehicle
from ..models.visit import Visit, VisitStatus, EntryMethod
from ..schemas.vehicle import VehicleOut
from ..utils.auth import get_current_user, require_any_page, require_page
from ..utils.helpers import generate_visit_number
from ..utils.qatar_time import qatar_day_start_end, qatar_today
from ..services.bay_inference import resolve_bay_for_detection, resolve_bay_for_job
from ..models.user import User

router = APIRouter(prefix="/api/anpr", tags=["ANPR"])

_MAX_ENTRY_ANCHOR_SEC = 6 * 3600


def _detections_same_job_open(db: Session, det: ANPRDetection) -> list[ANPRDetection]:
    """Unlinked ANPR rows for this plate in the same VisionFlow job (includes ``det``)."""
    plate = det.plate.upper()
    if not det.job_id:
        return [det]
    rows = (
        db.query(ANPRDetection)
        .filter(
            ANPRDetection.job_id == det.job_id,
            ANPRDetection.plate == plate,
            ANPRDetection.visit_id.is_(None),
        )
        .order_by(ANPRDetection.id.asc())
        .all()
    )
    return rows if rows else [det]


# ── Pydantic schemas ──────────────────────────────────────────────────────────

class DetectionIn(BaseModel):
    plate: str
    speed_kmh: Optional[float] = None
    track_id: Optional[int] = None
    t_enter_sec: Optional[float] = None
    t_exit_sec: Optional[float] = None
    duration_sec: Optional[float] = None


class SyncRequest(BaseModel):
    job_id: str
    video_name: Optional[str] = None
    detections: List[DetectionIn]


class CreateVisitFromANPR(BaseModel):
    vehicle_type:   Optional[str] = "sedan"
    make:           Optional[str] = None
    model:          Optional[str] = None
    color:          Optional[str] = None
    owner_name:     Optional[str] = None
    owner_phone:    Optional[str] = None
    notes:          Optional[str] = None
    assigned_bay:   Optional[int] = None


# ── Helpers ───────────────────────────────────────────────────────────────────

def _vehicle_out(v: Vehicle) -> dict:
    return VehicleOut.model_validate(v).model_dump()


def _det_dict(d: ANPRDetection) -> dict:
    bay_info = resolve_bay_for_detection(d)
    return {
        "id":          d.id,
        "plate":       d.plate,
        "speed_kmh":   d.speed_kmh,
        "track_id":    d.track_id,
        "job_id":      d.job_id,
        "video_name":  d.video_name,
        "detected_at": d.detected_at.isoformat() if d.detected_at else None,
        "vehicle_id":  d.vehicle_id,
        "visit_id":    d.visit_id,
        "vehicle":     _vehicle_out(d.vehicle) if d.vehicle else None,
        "t_enter_sec": d.t_enter_sec,
        "t_exit_sec":  d.t_exit_sec,
        "duration_sec": d.duration_sec,
        "presence_duration_sec": d.presence_duration_sec,
        "suggested_bay": bay_info.get("bay"),
        "camera_name": bay_info.get("camera_name"),
        "camera_slot": bay_info.get("slot_index"),
    }


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("/sync")
def sync_detections(
    body: SyncRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_page("visionflow")),
):
    """
    Receive the vehicle manifest from a completed VisionFlow job.
    - Deduplicates by (job_id, plate) — safe to call multiple times.
    - Auto-links each plate to an existing Vehicle (case-insensitive).
    Returns the saved detection rows.
    """
    saved = []
    for det in body.detections:
        plate = det.plate.strip().upper()
        if not plate or plate in ("—", "…", ""):
            continue

        # Skip if already synced for this job
        existing = (
            db.query(ANPRDetection)
            .filter(ANPRDetection.job_id == body.job_id, ANPRDetection.plate == plate)
            .first()
        )
        if existing:
            saved.append(_det_dict(existing))
            continue

        # Try to link to an existing vehicle (fuzzy: OCR drift still links)
        from ..services.vehicle_identity import find_vehicle_for_plate

        vehicle = find_vehicle_for_plate(db, plate, fuzzy=True)

        row = ANPRDetection(
            plate=plate,
            speed_kmh=det.speed_kmh,
            track_id=det.track_id,
            job_id=body.job_id,
            video_name=body.video_name,
            vehicle_id=vehicle.id if vehicle else None,
            detected_at=datetime.now(UTC),
            t_enter_sec=det.t_enter_sec,
            t_exit_sec=det.t_exit_sec,
            duration_sec=det.duration_sec,
        )
        db.add(row)
        db.flush()
        if vehicle:
            row.vehicle = vehicle
        saved.append(_det_dict(row))

    db.commit()
    return {"synced": len(saved), "detections": saved}


@router.get("/recent")
def recent_detections(
    limit: int = Query(default=30, le=200),
    job_id: Optional[str] = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_any_page("dashboard", "visionflow")),
):
    """Last `limit` ANPR detections ordered newest-first, with vehicle/visit info.
    Optionally filter by job_id to fetch all detections for one VisionFlow job.
    """
    q = (
        db.query(ANPRDetection)
        .options(
            joinedload(ANPRDetection.vehicle),
            joinedload(ANPRDetection.visit),
        )
        .order_by(ANPRDetection.detected_at.desc())
    )
    if job_id:
        q = q.filter(ANPRDetection.job_id == job_id)
    rows = q.limit(limit).all()
    return [_det_dict(r) for r in rows]


@router.get("/plate/{plate}")
def detections_for_plate(
    plate: str,
    limit: int = Query(default=50, le=200),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_any_page("visionflow", "visits")),
):
    """All ANPR detections for a specific plate number (returns vehicle info too)."""
    rows = (
        db.query(ANPRDetection)
        .options(joinedload(ANPRDetection.vehicle), joinedload(ANPRDetection.visit))
        .filter(ANPRDetection.plate == plate.strip().upper())
        .order_by(ANPRDetection.detected_at.desc())
        .limit(limit)
        .all()
    )
    vehicle = db.query(Vehicle).filter(Vehicle.plate_number == plate.strip().upper()).first()
    return {
        "plate": plate.upper(),
        "vehicle": _vehicle_out(vehicle) if vehicle else None,
        "detections": [_det_dict(r) for r in rows],
        "total": len(rows),
    }


@router.get("/detections/{detection_id}")
def get_detection(
    detection_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_any_page("visionflow", "visits")),
):
    """Single ANPR detection with suggested bay from its source camera."""
    row = (
        db.query(ANPRDetection)
        .options(joinedload(ANPRDetection.vehicle), joinedload(ANPRDetection.visit))
        .filter(ANPRDetection.id == detection_id)
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="Detection not found")
    return _det_dict(row)


@router.get("/stats")
def anpr_stats(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_any_page("dashboard", "visionflow")),
):
    """Quick stats for the dashboard widget (today = calendar day in Asia/Qatar)."""
    today_start, _today_end = qatar_day_start_end(qatar_today())
    week_first = qatar_today() - timedelta(days=6)
    week_start, _week_end = qatar_day_start_end(week_first)

    today_count = (
        db.query(ANPRDetection)
        .filter(ANPRDetection.detected_at >= today_start)
        .count()
    )
    today_unique = (
        db.query(ANPRDetection.plate)
        .filter(ANPRDetection.detected_at >= today_start)
        .distinct()
        .count()
    )
    week_count = (
        db.query(ANPRDetection)
        .filter(ANPRDetection.detected_at >= week_start)
        .count()
    )

    # Average speed (non-null, today)
    from sqlalchemy import func
    avg_spd = (
        db.query(func.avg(ANPRDetection.speed_kmh))
        .filter(ANPRDetection.detected_at >= today_start, ANPRDetection.speed_kmh.isnot(None))
        .scalar()
    )

    # Linked ratio (detections that matched a vehicle)
    total_synced = db.query(ANPRDetection).count()
    linked = db.query(ANPRDetection).filter(ANPRDetection.vehicle_id.isnot(None)).count()

    return {
        "today_detections":  today_count,
        "today_unique_plates": today_unique,
        "week_detections":   week_count,
        "avg_speed_kmh":     round(float(avg_spd), 1) if avg_spd else None,
        "total_synced":      total_synced,
        "linked_to_vehicle": linked,
    }


def _plate_shop_seconds(segments: list[dict]) -> tuple[float, float]:
    """Return (presence_total, in_frame_total) for a plate's detection segments."""
    presence_vals = [
        float(s["presence_duration_sec"])
        for s in segments
        if s.get("presence_duration_sec") is not None
    ]
    if presence_vals:
        total_presence = max(presence_vals)
    else:
        total_presence = sum(float(s.get("duration_sec") or 0.0) for s in segments)
    total_dwell = sum(float(s.get("duration_sec") or 0.0) for s in segments)
    return round(total_presence, 3), round(total_dwell, 3)


@router.get("/summary")
def anpr_plate_summary(
    limit_plates: int = Query(default=50, le=100),
    lookback_days: int = Query(default=7, ge=1, le=30),
    segment_limit: int = Query(default=500, le=2000),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_any_page("dashboard", "visionflow")),
):
    """
    Dashboard feed — detections grouped by plate with shop duration totals and
    expandable segment history (Camera wall / ANPR & Speed sync).
    """
    since = datetime.now(UTC) - timedelta(days=lookback_days)
    rows = (
        db.query(ANPRDetection)
        .options(
            joinedload(ANPRDetection.vehicle),
            joinedload(ANPRDetection.visit),
        )
        .filter(ANPRDetection.detected_at >= since)
        .order_by(ANPRDetection.detected_at.desc())
        .limit(segment_limit)
        .all()
    )

    groups: dict[str, dict] = {}
    for row in rows:
        plate = (row.plate or "").strip().upper()
        if not plate:
            continue
        seg = _det_dict(row)
        bucket = groups.get(plate)
        if bucket is None:
            bucket = {
                "plate": plate,
                "segments": [],
                "latest_at": seg.get("detected_at"),
                "latest_job_id": seg.get("job_id"),
                "camera_name": seg.get("camera_name"),
                "camera_slot": seg.get("camera_slot"),
                "vehicle": seg.get("vehicle"),
                "visit_id": seg.get("visit_id"),
                "max_speed_kmh": seg.get("speed_kmh"),
            }
            groups[plate] = bucket
        bucket["segments"].append(seg)
        spd = seg.get("speed_kmh")
        if spd is not None:
            prev = bucket.get("max_speed_kmh")
            bucket["max_speed_kmh"] = max(float(prev or 0), float(spd)) or spd
        if seg.get("vehicle") and not bucket.get("vehicle"):
            bucket["vehicle"] = seg["vehicle"]
        if seg.get("visit_id") and not bucket.get("visit_id"):
            bucket["visit_id"] = seg["visit_id"]
        if seg.get("detected_at") and (
            not bucket.get("latest_at") or seg["detected_at"] > bucket["latest_at"]
        ):
            bucket["latest_at"] = seg["detected_at"]
            bucket["latest_job_id"] = seg.get("job_id")
            bucket["camera_name"] = seg.get("camera_name")
            bucket["camera_slot"] = seg.get("camera_slot")

    plates_out: list[dict] = []
    for plate, bucket in groups.items():
        segs = sorted(
            bucket["segments"],
            key=lambda s: s.get("detected_at") or "",
            reverse=True,
        )
        total_presence, total_dwell = _plate_shop_seconds(segs)
        plates_out.append({
            "plate": plate,
            "segment_count": len(segs),
            "total_presence_sec": total_presence,
            "total_duration_sec": total_dwell,
            "latest_at": bucket.get("latest_at"),
            "latest_job_id": bucket.get("latest_job_id"),
            "camera_name": bucket.get("camera_name"),
            "camera_slot": bucket.get("camera_slot"),
            "max_speed_kmh": bucket.get("max_speed_kmh"),
            "vehicle": bucket.get("vehicle"),
            "visit_id": bucket.get("visit_id"),
            "segments": segs,
        })

    plates_out.sort(key=lambda p: p.get("latest_at") or "", reverse=True)
    total_segments = sum(p["segment_count"] for p in plates_out)

    return {
        "lookback_days": lookback_days,
        "total_plates": len(plates_out),
        "total_segments": total_segments,
        "plates": plates_out[:limit_plates],
    }


@router.post("/{detection_id}/visit", status_code=201)
def create_visit_from_detection(
    detection_id: int,
    body: CreateVisitFromANPR,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_any_page("visionflow", "visits")),
):
    """
    Create (or reuse) a Vehicle and open a new Visit from an ANPR detection row.
    The detection row is updated with the new visit_id.
    """
    det = db.query(ANPRDetection).filter(ANPRDetection.id == detection_id).first()
    if not det:
        raise HTTPException(status_code=404, detail="Detection not found")

    plate = det.plate.upper()

    # Get or create vehicle — fuzzy match folds OCR misreads onto the
    # existing record instead of creating a duplicate vehicle row.
    from ..services.vehicle_identity import find_vehicle_for_plate

    vehicle = find_vehicle_for_plate(db, plate, fuzzy=True)
    if not vehicle:
        vehicle = Vehicle(
            plate_number=plate,
            vehicle_type=body.vehicle_type or "sedan",
            make=body.make,
            model=body.model,
            color=body.color,
            owner_name=body.owner_name,
            owner_phone=body.owner_phone,
            notes=body.notes,
        )
        db.add(vehicle)
        db.flush()

    rows = _detections_same_job_open(db, det)
    total_cam = sum(float(r.duration_sec or 0) for r in rows)
    anchor_sec = min(total_cam, float(_MAX_ENTRY_ANCHOR_SEC)) if total_cam > 0 else 0.0
    entry_at = datetime.now(UTC) - timedelta(seconds=anchor_sec) if anchor_sec > 0 else datetime.now(UTC)

    # Create visit
    visit = Visit(
        visit_number=generate_visit_number(),
        vehicle_id=vehicle.id,
        created_by=current_user.id,
        entry_time=entry_at,
        status=VisitStatus.WAITING,
        entry_method=EntryMethod.AUTO_CAMERA,
        assigned_bay=body.assigned_bay,
        customer_name=body.owner_name or vehicle.owner_name,
        customer_phone=body.owner_phone or vehicle.owner_phone,
        notes=body.notes,
        plate_confidence=None,
        anpr_camera_seconds=total_cam if total_cam > 0 else None,
    )
    db.add(visit)
    db.flush()

    # Update vehicle visit count
    vehicle.total_visits = (vehicle.total_visits or 0) + 1

    # Link every open job row for this plate → vehicle + visit
    for r in rows:
        r.vehicle_id = vehicle.id
        r.visit_id = visit.id

    db.commit()
    db.refresh(visit)

    return {
        "visit_id":      visit.id,
        "visit_number":  visit.visit_number,
        "vehicle_id":    vehicle.id,
        "plate":         plate,
        "status":        visit.status.value,
        "anpr_camera_seconds": visit.anpr_camera_seconds,
    }
