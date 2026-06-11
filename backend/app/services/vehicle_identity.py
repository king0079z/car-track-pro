"""
Vehicle identity — DB-layer plate dedupe, duplicate discovery, and merging.

The vision engine already fuzzy-merges OCR drift *within* a session
(``plates.py``), but the Vehicle table itself only had an exact-match unique
constraint, so a single misread ("8174HG" vs "8174HGL") could create a second
vehicle row. This module closes that gap:

  * ``find_vehicle_for_plate``  — exact match first, then a conservative fuzzy
    match (same logic the engine uses) so ANPR-originated flows reuse the
    existing vehicle instead of spawning a duplicate.
  * ``find_duplicate_groups``   — scan for likely-duplicate vehicle rows for
    the admin "Merge duplicates" UI.
  * ``merge_vehicles``          — fold one vehicle into another: re-points
    visits + ANPR detections, backfills missing fields, sums visit counts,
    deletes the duplicate.
"""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy.orm import Session

from ..models.anpr import ANPRDetection
from ..models.vehicle import Vehicle
from ..models.visit import Visit
from ..utils.plates import _plates_same_vehicle, normalize_plate

_log = logging.getLogger(__name__)

# Only consider recent vehicles for fuzzy matching — keeps the scan cheap and
# avoids matching against years-old rows for shops with large registries.
_FUZZY_SCAN_LIMIT = 800


def find_vehicle_for_plate(
    db: Session, plate: str, *, fuzzy: bool = True
) -> Vehicle | None:
    """Resolve a plate to an existing Vehicle. Exact match first; with
    ``fuzzy=True`` also accept a conservative same-physical-plate match
    (truncation or single-char OCR drift) to prevent duplicate rows."""
    p = (plate or "").strip().upper()
    if not p:
        return None
    exact = db.query(Vehicle).filter(Vehicle.plate_number == p).first()
    if exact or not fuzzy:
        return exact
    norm = normalize_plate(p)
    if len(norm) < 4:
        return None
    candidates = (
        db.query(Vehicle).order_by(Vehicle.id.desc()).limit(_FUZZY_SCAN_LIMIT).all()
    )
    for v in candidates:
        if _plates_same_vehicle(p, v.plate_number or ""):
            _log.info(
                "Fuzzy plate match: %r resolved to existing vehicle #%s (%r)",
                p, v.id, v.plate_number,
            )
            return v
    return None


def find_duplicate_groups(db: Session, *, limit: int = 40) -> list[dict[str, Any]]:
    """Group vehicles whose plates almost certainly belong to the same car.

    Returns groups sorted so the best merge target (most visits, then oldest)
    is first in each group."""
    vehicles = db.query(Vehicle).order_by(Vehicle.id.asc()).all()
    used: set[int] = set()
    groups: list[dict[str, Any]] = []
    for i, a in enumerate(vehicles):
        if a.id in used:
            continue
        members = [a]
        for b in vehicles[i + 1:]:
            if b.id in used:
                continue
            if _plates_same_vehicle(a.plate_number or "", b.plate_number or ""):
                members.append(b)
                used.add(b.id)
        if len(members) < 2:
            continue
        used.update(m.id for m in members)
        members.sort(key=lambda v: (-(v.total_visits or 0), v.id))
        groups.append({
            "suggested_target_id": members[0].id,
            "vehicles": [
                {
                    "id": m.id,
                    "plate_number": m.plate_number,
                    "make": m.make,
                    "model": m.model,
                    "color": m.color,
                    "owner_name": m.owner_name,
                    "total_visits": m.total_visits or 0,
                    "created_at": m.created_at.isoformat() if m.created_at else None,
                }
                for m in members
            ],
        })
        if len(groups) >= limit:
            break
    return groups


_BACKFILL_FIELDS = (
    "plate_country", "make", "model", "year", "color", "vehicle_type",
    "vin", "owner_name", "owner_phone", "owner_email", "notes", "image_url",
)


def merge_vehicles(db: Session, *, target: Vehicle, source: Vehicle) -> dict[str, Any]:
    """Fold ``source`` into ``target`` and delete ``source``.

    Visits and ANPR detections are re-pointed; blank target fields are
    backfilled from the source. Caller commits."""
    if target.id == source.id:
        raise ValueError("Cannot merge a vehicle into itself")

    moved_visits = (
        db.query(Visit)
        .filter(Visit.vehicle_id == source.id)
        .update({Visit.vehicle_id: target.id}, synchronize_session=False)
    )
    moved_dets = (
        db.query(ANPRDetection)
        .filter(ANPRDetection.vehicle_id == source.id)
        .update({ANPRDetection.vehicle_id: target.id}, synchronize_session=False)
    )

    for field in _BACKFILL_FIELDS:
        if not getattr(target, field, None) and getattr(source, field, None):
            setattr(target, field, getattr(source, field))

    target.total_visits = (target.total_visits or 0) + (source.total_visits or 0)

    merged_plate = source.plate_number
    # Expire so the ORM doesn't try to cascade-delete the already re-pointed visits.
    db.expire(source, ["visits"])
    db.delete(source)
    db.flush()
    _log.info(
        "Merged vehicle #%s (%r) into #%s (%r): %d visits, %d detections moved",
        source.id, merged_plate, target.id, target.plate_number, moved_visits, moved_dets,
    )
    return {
        "merged_plate": merged_plate,
        "visits_moved": int(moved_visits),
        "detections_moved": int(moved_dets),
    }
