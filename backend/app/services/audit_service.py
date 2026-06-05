"""
Operational audit trail — persist logs + periodic system snapshots + CSV/JSON report payload.
"""
from __future__ import annotations

import csv
import io
import json
from datetime import UTC, datetime, timedelta
from typing import Any, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload

from ..models.audit import AuditLog
from ..models.anpr import ANPRDetection
from ..models.user import User
from ..models.vehicle import Vehicle
from ..models.visit import Visit, VisitStatus
from ..utils.qatar_time import qatar_day_start_end, qatar_today


def create_audit_log(
    db: Session,
    *,
    user_id: Optional[int],
    action: str,
    entity_type: Optional[str] = None,
    entity_id: Optional[int] = None,
    visit_id: Optional[int] = None,
    description: Optional[str] = None,
    old_values: Any = None,
    new_values: Any = None,
    ip_address: Optional[str] = None,
    user_agent: Optional[str] = None,
    commit: bool = False,
) -> AuditLog:
    row = AuditLog(
        user_id=user_id,
        visit_id=visit_id,
        action=action,
        entity_type=entity_type,
        entity_id=entity_id,
        description=description,
        old_values=old_values,
        new_values=new_values,
        ip_address=ip_address,
        user_agent=user_agent,
    )
    db.add(row)
    if commit:
        db.commit()
    else:
        db.flush()
    return row


def collect_operational_snapshot(db: Session) -> dict[str, Any]:
    """Point-in-time metrics stored on periodic_audit rows (JSON) and reports."""
    now = datetime.now(UTC)
    today = qatar_today()
    today_start, today_end = qatar_day_start_end(today)
    window_start = now - timedelta(days=30)

    visits_30d = db.query(func.count(Visit.id)).filter(Visit.entry_time >= window_start).scalar() or 0
    active_visits = (
        db.query(func.count(Visit.id))
        .filter(Visit.status.in_([VisitStatus.WAITING, VisitStatus.IN_SERVICE, VisitStatus.ON_HOLD]))
        .scalar()
        or 0
    )
    completed_30d = (
        db.query(func.count(Visit.id))
        .filter(
            Visit.entry_time >= window_start,
            Visit.status == VisitStatus.COMPLETED,
        )
        .scalar()
        or 0
    )
    revenue_30d = (
        db.query(func.sum(Visit.total_price))
        .filter(
            Visit.entry_time >= window_start,
            Visit.status == VisitStatus.COMPLETED,
        )
        .scalar()
        or 0
    )

    vehicles_n = db.query(func.count(Vehicle.id)).scalar() or 0
    users_n = db.query(func.count(User.id)).scalar() or 0

    anpr_today = (
        db.query(func.count(ANPRDetection.id))
        .filter(ANPRDetection.detected_at >= today_start, ANPRDetection.detected_at <= today_end)
        .scalar()
        or 0
    )
    anpr_pending_today = (
        db.query(func.count(ANPRDetection.id))
        .filter(
            ANPRDetection.detected_at >= today_start,
            ANPRDetection.detected_at <= today_end,
            ANPRDetection.visit_id.is_(None),
        )
        .scalar()
        or 0
    )
    anpr_total = db.query(func.count(ANPRDetection.id)).scalar() or 0
    anpr_linked = db.query(func.count(ANPRDetection.id)).filter(ANPRDetection.vehicle_id.isnot(None)).scalar() or 0

    return {
        "generated_at_utc": now.isoformat() + "Z",
        "visits_last_30d": visits_30d,
        "completed_visits_last_30d": completed_30d,
        "active_visits_now": active_visits,
        "revenue_qar_completed_30d": round(float(revenue_30d), 2),
        "vehicles_registered": vehicles_n,
        "users": users_n,
        "anpr_detections_today": anpr_today,
        "anpr_pending_link_today": anpr_pending_today,
        "anpr_total_rows": anpr_total,
        "anpr_linked_to_vehicle": anpr_linked,
        "anpr_link_pct": round((anpr_linked / anpr_total) * 100, 1) if anpr_total else None,
    }


def run_periodic_system_audit(db: Session) -> AuditLog:
    snap = collect_operational_snapshot(db)
    desc = (
        f"Scheduled operational audit — {snap['visits_last_30d']} visits (30d), "
        f"{snap['active_visits_now']} active on floor, "
        f"QAR {snap['revenue_qar_completed_30d']:.2f} revenue (completed 30d), "
        f"{snap['anpr_pending_link_today']} ANPR reads today awaiting visit link."
    )
    return create_audit_log(
        db,
        user_id=None,
        action="periodic_audit",
        entity_type="system",
        entity_id=None,
        description=desc,
        new_values=snap,
        commit=True,
    )


def build_audit_report_payload(db: Session, days: int = 30) -> dict[str, Any]:
    """Aggregate data for downloadable manager report."""
    now = datetime.now(UTC)
    start = now - timedelta(days=days)

    snapshot = collect_operational_snapshot(db)

    periodic_rows = (
        db.query(AuditLog)
        .options(joinedload(AuditLog.user))
        .filter(
            AuditLog.action == "periodic_audit",
            AuditLog.created_at >= start,
        )
        .order_by(AuditLog.created_at.desc())
        .limit(500)
        .all()
    )

    recent_actions = (
        db.query(AuditLog)
        .options(joinedload(AuditLog.user))
        .filter(AuditLog.created_at >= start)
        .order_by(AuditLog.created_at.desc())
        .limit(800)
        .all()
    )

    def log_row(r: AuditLog) -> dict[str, Any]:
        return {
            "id": r.id,
            "created_at": r.created_at.isoformat() if r.created_at else None,
            "action": r.action,
            "entity_type": r.entity_type,
            "entity_id": r.entity_id,
            "user_id": r.user_id,
            "username": r.user.username if r.user else None,
            "description": r.description,
        }

    return {
        "report_title": "CarTrack Pro — operational audit report",
        "generated_at_utc": now.isoformat() + "Z",
        "period_days": days,
        "period_start_utc": start.isoformat() + "Z",
        "current_snapshot": snapshot,
        "periodic_audits_in_period": [log_row(r) for r in periodic_rows],
        "all_audit_events_in_period": [log_row(r) for r in recent_actions],
        "event_counts_by_action": _count_actions(recent_actions),
    }


def _count_actions(rows: list[AuditLog]) -> dict[str, int]:
    out: dict[str, int] = {}
    for r in rows:
        a = r.action or "unknown"
        out[a] = out.get(a, 0) + 1
    return dict(sorted(out.items(), key=lambda x: -x[1]))


def render_audit_report_csv(payload: dict[str, Any]) -> bytes:
    buf = io.StringIO()
    w = csv.writer(buf)

    w.writerow(["CarTrack Pro — Operational Audit Report"])
    w.writerow(["Generated (UTC)", payload["generated_at_utc"]])
    w.writerow(["Period (days)", payload["period_days"]])
    w.writerow([])

    w.writerow(["=== CURRENT SNAPSHOT ==="])
    for k, v in payload["current_snapshot"].items():
        w.writerow([k, json.dumps(v) if isinstance(v, (dict, list)) else v])
    w.writerow([])

    w.writerow(["=== EVENT COUNTS (period) ==="])
    for k, v in payload["event_counts_by_action"].items():
        w.writerow([k, v])
    w.writerow([])

    w.writerow(["=== SCHEDULED AUDITS IN PERIOD ==="])
    w.writerow(["created_at_utc", "action", "description"])
    for r in payload["periodic_audits_in_period"]:
        w.writerow([r.get("created_at"), r.get("action"), (r.get("description") or "").replace("\n", " ")[:500]])
    w.writerow([])

    w.writerow(["=== ALL EVENTS IN PERIOD (latest 800) ==="])
    w.writerow(["created_at_utc", "action", "entity_type", "entity_id", "user", "description"])
    for r in payload["all_audit_events_in_period"]:
        w.writerow([
            r.get("created_at"),
            r.get("action"),
            r.get("entity_type"),
            r.get("entity_id"),
            r.get("username"),
            (r.get("description") or "").replace("\n", " ")[:400],
        ])

    return buf.getvalue().encode("utf-8-sig")
