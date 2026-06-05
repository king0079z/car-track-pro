"""Application error log — admin diagnostics for plate monitoring and full stack."""

from __future__ import annotations

import csv
import io
import json
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response, StreamingResponse
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..database import get_db
from ..models.application_error import ApplicationError
from ..models.user import User
from ..schemas.application_error import ApplicationErrorOut, ErrorResolveBody, ErrorStatsOut
from ..services.error_recorder import PLATE_CATEGORIES, record_application_error
from ..utils.auth import require_admin
from ..utils.qatar_time import qatar_today

router = APIRouter(prefix="/api/errors", tags=["Errors"])


@router.get("/stats", response_model=ErrorStatsOut)
def error_stats(
    days: int = Query(7, ge=1, le=90),
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    cutoff = datetime.now(UTC) - timedelta(days=days)
    cutoff_24h = datetime.now(UTC) - timedelta(hours=24)
    base = db.query(ApplicationError).filter(ApplicationError.created_at >= cutoff)
    total = base.count()
    unresolved = base.filter(ApplicationError.resolved.is_(False)).count()
    last_24h = base.filter(ApplicationError.last_seen_at >= cutoff_24h).count()

    by_category: dict[str, int] = {}
    for cat, cnt in (
        db.query(ApplicationError.category, func.count(ApplicationError.id))
        .filter(ApplicationError.created_at >= cutoff)
        .group_by(ApplicationError.category)
        .all()
    ):
        by_category[str(cat)] = int(cnt)

    by_severity: dict[str, int] = {}
    for sev, cnt in (
        db.query(ApplicationError.severity, func.count(ApplicationError.id))
        .filter(ApplicationError.created_at >= cutoff)
        .group_by(ApplicationError.severity)
        .all()
    ):
        by_severity[str(sev)] = int(cnt)

    plate_monitoring = sum(by_category.get(c, 0) for c in PLATE_CATEGORIES)

    return ErrorStatsOut(
        total=total,
        unresolved=unresolved,
        last_24h=last_24h,
        by_category=by_category,
        by_severity=by_severity,
        plate_monitoring=plate_monitoring,
    )


@router.get("", response_model=list[ApplicationErrorOut])
def list_errors(
    page: int = Query(1, ge=1),
    limit: int = Query(50, le=200),
    category: str | None = Query(None, description="visionflow|anpr|camera|api|client|database|system"),
    categories: str | None = Query(None, description="Comma-separated categories (OR)"),
    severity: str | None = None,
    resolved: bool | None = None,
    job_id: str | None = None,
    plate: str | None = None,
    search: str | None = Query(None, max_length=120),
    days: int = Query(30, ge=1, le=365),
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    skip = (page - 1) * limit
    cutoff = datetime.now(UTC) - timedelta(days=days)
    q = db.query(ApplicationError).filter(ApplicationError.created_at >= cutoff)

    cat_list = [c.strip().lower() for c in (categories or "").split(",") if c.strip()]
    if cat_list:
        q = q.filter(ApplicationError.category.in_(cat_list))
    elif category:
        q = q.filter(ApplicationError.category == category.strip().lower())

    if severity:
        q = q.filter(ApplicationError.severity == severity.strip().lower())
    if resolved is not None:
        q = q.filter(ApplicationError.resolved.is_(resolved))
    if job_id:
        q = q.filter(ApplicationError.job_id == job_id.strip())
    if plate:
        q = q.filter(ApplicationError.plate.ilike(f"%{plate.strip()}%"))
    if search:
        term = f"%{search.strip()}%"
        q = q.filter(
            (ApplicationError.message.ilike(term))
            | (ApplicationError.detail.ilike(term))
            | (ApplicationError.source.ilike(term))
        )

    return q.order_by(ApplicationError.last_seen_at.desc()).offset(skip).limit(limit).all()


@router.patch("/{error_id}", response_model=ApplicationErrorOut)
def resolve_error(
    error_id: int,
    body: ErrorResolveBody,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    row = db.query(ApplicationError).filter(ApplicationError.id == error_id).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Error not found")
    row.resolved = bool(body.resolved)
    if row.resolved:
        row.resolved_at = datetime.now(UTC)
        row.resolved_by = current_user.id
    else:
        row.resolved_at = None
        row.resolved_by = None
    db.commit()
    db.refresh(row)
    return row


@router.post("/{error_id}/resolve", response_model=ApplicationErrorOut)
def resolve_error_post(
    error_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    return resolve_error(error_id, ErrorResolveBody(resolved=True), db, current_user)


@router.get("/export")
def export_errors(
    format: str = Query("csv"),
    days: int = Query(30, ge=1, le=365),
    category: str | None = None,
    categories: str | None = Query(None, description="Comma-separated categories (OR)"),
    unresolved_only: bool = False,
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    if format not in ("csv", "json"):
        raise HTTPException(status_code=400, detail='format must be "csv" or "json"')
    cutoff = datetime.now(UTC) - timedelta(days=days)
    q = db.query(ApplicationError).filter(ApplicationError.created_at >= cutoff)
    cat_list = [c.strip().lower() for c in (categories or "").split(",") if c.strip()]
    if cat_list:
        q = q.filter(ApplicationError.category.in_(cat_list))
    elif category:
        q = q.filter(ApplicationError.category == category.strip().lower())
    if unresolved_only:
        q = q.filter(ApplicationError.resolved.is_(False))
    rows = q.order_by(ApplicationError.last_seen_at.desc()).limit(5000).all()
    fname = f"cartrack-errors-{qatar_today().isoformat()}"

    if format == "json":
        payload = [
            {
                "id": r.id,
                "severity": r.severity,
                "category": r.category,
                "source": r.source,
                "message": r.message,
                "detail": r.detail,
                "occurrence_count": r.occurrence_count,
                "job_id": r.job_id,
                "plate": r.plate,
                "track_id": r.track_id,
                "resolved": r.resolved,
                "last_seen_at": r.last_seen_at.isoformat() if r.last_seen_at else None,
                "created_at": r.created_at.isoformat() if r.created_at else None,
                "context": r.context,
            }
            for r in rows
        ]
        body = json.dumps(payload, indent=2, default=str).encode("utf-8")
        return Response(
            content=body,
            media_type="application/json; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{fname}.json"'},
        )

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow([
        "id", "severity", "category", "source", "message", "detail",
        "occurrence_count", "job_id", "plate", "track_id", "resolved",
        "last_seen_at", "created_at",
    ])
    for r in rows:
        writer.writerow([
            r.id, r.severity, r.category, r.source,
            (r.message or "").replace("\n", " ")[:500],
            (r.detail or "").replace("\n", " ")[:500],
            r.occurrence_count, r.job_id, r.plate, r.track_id, r.resolved,
            r.last_seen_at, r.created_at,
        ])
    return StreamingResponse(
        iter([buf.getvalue().encode("utf-8")]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{fname}.csv"'},
    )


@router.post("/record-test")
def record_test_error(
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    """Smoke-test error pipeline (admin only)."""
    row = record_application_error(
        db,
        severity="info",
        category="system",
        source="errors.record_test",
        message="Test error recorded successfully",
        detail="Admin triggered diagnostics test",
        user_id=current_user.id,
        ip_address=request.client.host if request.client else None,
        context={"test": True},
    )
    if row is None:
        raise HTTPException(status_code=500, detail="Could not record test error")
    return {"ok": True, "id": row.id}
