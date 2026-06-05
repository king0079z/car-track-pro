import json
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response, StreamingResponse
from sqlalchemy.orm import Session, joinedload
from typing import Optional

from ..database import get_db
from ..models.audit import AuditLog
from ..models.user import User
from ..schemas.audit import ClientAutoErrorCreate, IncidentReportCreate
from ..utils.auth import require_manager, get_current_user
from ..utils.qatar_time import qatar_today
from ..services.audit_service import (
    build_audit_report_payload,
    create_audit_log,
    render_audit_report_csv,
    run_periodic_system_audit,
)

router = APIRouter(prefix="/api/audit", tags=["Audit"])


@router.get("")
def list_audit_logs(
    user_id: Optional[int] = None,
    entity_type: Optional[str] = None,
    action: Optional[str] = None,
    actions: Optional[str] = Query(
        None,
        description="Comma-separated action names; rows match any listed action (OR). Ignores single `action` when non-empty.",
    ),
    page: int = Query(default=1, ge=1),
    limit: int = Query(default=40, le=200),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_manager),
):
    skip = (page - 1) * limit
    q = db.query(AuditLog).options(joinedload(AuditLog.user))
    if user_id:
        q = q.filter(AuditLog.user_id == user_id)
    if entity_type:
        q = q.filter(AuditLog.entity_type == entity_type)
    action_names = [p.strip() for p in actions.split(",") if p.strip()] if actions else []
    if action_names:
        q = q.filter(AuditLog.action.in_(action_names))
    elif action:
        q = q.filter(AuditLog.action == action)
    return q.order_by(AuditLog.created_at.desc()).offset(skip).limit(limit).all()


def _dedupe_client_auto_error(db: Session, user_id: int, fingerprint: str) -> bool:
    cutoff = datetime.now(UTC) - timedelta(seconds=120)
    recent = (
        db.query(AuditLog)
        .filter(
            AuditLog.user_id == user_id,
            AuditLog.action == "client_auto_error",
            AuditLog.created_at >= cutoff,
        )
        .order_by(AuditLog.created_at.desc())
        .limit(50)
        .all()
    )
    for row in recent:
        nv = row.new_values if isinstance(row.new_values, dict) else {}
        if nv.get("fingerprint") == fingerprint:
            return True
    return False


@router.post("/client-error")
def ingest_client_auto_error(
    body: ClientAutoErrorCreate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Browser-captured errors (uncaught JS, unhandled promise, React boundary, console.error).
    Deduplicates identical fingerprints within ~2 minutes per user.
    """
    if _dedupe_client_auto_error(db, current_user.id, body.fingerprint):
        return {"ok": True, "deduplicated": True}

    ua = request.headers.get("user-agent")
    ip = request.client.host if request.client else None
    msg_preview = body.message.strip().replace("\n", " ")[:220]
    desc = f"[auto:{body.kind}] {msg_preview}"

    payload = {
        "fingerprint": body.fingerprint,
        "kind": body.kind,
        "message": body.message.strip(),
        "stack": body.stack,
        "source": body.source,
        "lineno": body.lineno,
        "colno": body.colno,
        "page_path": body.page_path,
        "href": body.href,
        "component_stack": body.component_stack,
        "console_preview": body.console_preview,
        "reporter_username": current_user.username,
        "reporter_role": current_user.role.value if current_user.role else None,
    }

    row = create_audit_log(
        db,
        user_id=current_user.id,
        action="client_auto_error",
        entity_type="client_error",
        entity_id=None,
        description=desc[:2000],
        new_values=payload,
        ip_address=ip,
        user_agent=ua[:4000] if ua else None,
        commit=True,
    )

    from ..services.error_recorder import record_application_error

    sev = "warning" if body.kind in ("console_warn",) else "error"
    record_application_error(
        db,
        severity=sev,
        category="client",
        source=f"browser.{body.kind}",
        message=body.message.strip()[:8000],
        detail=desc[:2000],
        stack_trace=body.stack,
        user_id=current_user.id,
        ip_address=ip,
        fingerprint=body.fingerprint,
        context={
            "audit_log_id": row.id,
            "page_path": body.page_path,
            "href": body.href,
            "source_file": body.source,
            "kind": body.kind,
        },
        dedupe_seconds=120,
    )
    return {"ok": True, "id": row.id}


@router.post("/incident")
def report_system_incident(
    body: IncidentReportCreate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Record a user-observed error or malfunction into the audit log for traceability.
    Any authenticated user may submit (not limited to managers).
    """
    ua = request.headers.get("user-agent")
    ip = request.client.host if request.client else None
    payload = {
        "details": body.details.strip(),
        "page_path": body.page_path.strip() if body.page_path else None,
        "reporter_username": current_user.username,
        "reporter_full_name": current_user.full_name,
        "reporter_role": current_user.role.value if current_user.role else None,
    }
    row = create_audit_log(
        db,
        user_id=current_user.id,
        action="system_error_report",
        entity_type="incident",
        entity_id=None,
        description=body.summary.strip(),
        new_values=payload,
        ip_address=ip,
        user_agent=ua[:4000] if ua else None,
        commit=True,
    )
    return {
        "ok": True,
        "id": row.id,
        "created_at": row.created_at.isoformat() if row.created_at else None,
    }


@router.post("/snapshot")
def trigger_periodic_audit_snapshot(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_manager),
):
    """Managers can run the same scheduled operational snapshot immediately."""
    row = run_periodic_system_audit(db)
    return {
        "ok": True,
        "id": row.id,
        "description": row.description,
        "created_at": row.created_at.isoformat() if row.created_at else None,
    }


@router.get("/report")
def download_audit_report(
    format: str = Query("csv"),
    days: int = Query(30, ge=1, le=365),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_manager),
):
    if format not in ("csv", "json"):
        raise HTTPException(status_code=400, detail='format must be "csv" or "json"')
    payload = build_audit_report_payload(db, days=days)
    fname = f"cartrack-audit-report-{qatar_today().isoformat()}"

    if format == "json":
        body = json.dumps(payload, indent=2, default=str).encode("utf-8")
        return Response(
            content=body,
            media_type="application/json; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{fname}.json"'},
        )

    csv_bytes = render_audit_report_csv(payload)
    return StreamingResponse(
        iter([csv_bytes]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{fname}.csv"'},
    )
