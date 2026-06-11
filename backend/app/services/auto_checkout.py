"""
ANPR auto-checkout — closes open work orders after the vehicle has left.

Implements the ``auto_checkout`` operations setting (previously a stored
toggle with no behavior). Every few minutes:

  1. Find open visits (waiting / in service / on hold) whose vehicle was seen
     by the cameras at least once (≥1 linked ANPR detection — manual visits
     for cars the cameras never saw are NEVER auto-closed).
  2. If the vehicle's most recent camera sighting is older than the departure
     grace window (the operator's ``plate_resume_wait_minutes`` re-entry
     window, minimum 30 min), the car has left the shop → the visit is
     checked out automatically: exit time = last sighting, duration computed,
     audit-logged as "auto_checkout", and the customer gets the WhatsApp
     completion message.

Conservative by design: a visit signed/created seconds ago is not touched
(entry must also be older than the grace window), and the toggle in
Settings → Operations turns the whole behavior on/off at runtime.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import func as sa_func

from ..utils.helpers import calculate_duration

_log = logging.getLogger(__name__)

_MIN_GRACE_SEC = 30 * 60.0  # never auto-checkout sooner than 30 min after last sighting


def _enabled() -> bool:
    try:
        from ..routers.settings import _load

        return bool(_load().get("auto_checkout", False))
    except Exception:
        return False


def _grace_seconds() -> float:
    try:
        from ..routers.settings import get_resume_gap_seconds

        return max(_MIN_GRACE_SEC, float(get_resume_gap_seconds()))
    except Exception:
        return max(_MIN_GRACE_SEC, 7200.0)


def _as_utc(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt.astimezone(UTC)


def run_auto_checkout_pass() -> int:
    """One sweep; returns the number of visits auto-checked-out."""
    if not _enabled():
        return 0

    from ..database import SessionLocal
    from ..models.anpr import ANPRDetection
    from ..models.visit import Visit, VisitStatus
    from .audit_service import create_audit_log
    from .camera_presence import freeze_visit_camera_recording
    from .service_duration import sync_visit_shop_duration

    grace = _grace_seconds()
    now = datetime.now(UTC)
    cutoff = now - timedelta(seconds=grace)
    closed = 0

    db = SessionLocal()
    try:
        open_visits = (
            db.query(Visit)
            .filter(Visit.status.in_([VisitStatus.WAITING, VisitStatus.IN_SERVICE, VisitStatus.ON_HOLD]))
            .all()
        )
        for visit in open_visits:
            entry = _as_utc(visit.entry_time)
            if entry is None or entry > cutoff:
                continue  # too fresh — give the car time
            # Only camera-verified visits: the vehicle must have ANPR history.
            last_seen_raw = (
                db.query(sa_func.max(ANPRDetection.detected_at))
                .filter(ANPRDetection.vehicle_id == visit.vehicle_id)
                .scalar()
            )
            last_seen = _as_utc(last_seen_raw)
            if last_seen is None:
                continue  # never seen by a camera — manual visit, leave alone
            if last_seen > cutoff:
                continue  # still (recently) in view

            exit_at = max(last_seen, entry)
            visit.exit_time = exit_at
            visit.status = VisitStatus.COMPLETED
            visit.duration_minutes = calculate_duration(visit.entry_time, visit.exit_time)
            freeze_visit_camera_recording(db, visit)
            sync_visit_shop_duration(db, visit)
            create_audit_log(
                db,
                user_id=None,
                action="auto_checkout",
                entity_type="visit",
                entity_id=visit.id,
                visit_id=visit.id,
                description=(
                    f"Auto checkout {visit.visit_number} — vehicle not seen on camera "
                    f"for {grace / 60:.0f}+ min (last sighting {last_seen.strftime('%H:%M')})"
                ),
                new_values={
                    "duration_minutes": visit.duration_minutes,
                    "last_camera_sighting": last_seen.isoformat(),
                },
                commit=False,
            )
            db.commit()
            closed += 1
            _log.info(
                "Auto-checked-out visit %s (vehicle %s, last seen %s)",
                visit.visit_number, visit.vehicle_id, last_seen.isoformat(),
            )
            try:
                from .whatsapp_notify import notify_work_order_completed

                notify_work_order_completed(visit.id)
            except Exception:
                _log.exception("WhatsApp notify after auto-checkout failed")
    except Exception:
        db.rollback()
        _log.exception("Auto-checkout pass failed")
    finally:
        db.close()
    return closed


async def periodic_auto_checkout_loop() -> None:
    """Asyncio task started from the app lifespan (checks every 5 minutes)."""
    import asyncio

    await asyncio.sleep(120.0)  # let startup settle
    while True:
        try:
            await asyncio.to_thread(run_auto_checkout_pass)
        except Exception:
            _log.exception("Periodic auto-checkout failed")
        await asyncio.sleep(300.0)
