"""World-class structured error recording for CarTrack + VisionFlow."""

from __future__ import annotations

import hashlib
import logging
import traceback
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy.orm import Session

from ..database import SessionLocal
from ..models.application_error import ApplicationError

_log = logging.getLogger(__name__)

PLATE_CATEGORIES = frozenset({"visionflow", "anpr", "camera"})
VALID_SEVERITIES = frozenset({"debug", "info", "warning", "error", "critical"})
VALID_CATEGORIES = frozenset({"visionflow", "anpr", "camera", "api", "client", "database", "system"})


def make_fingerprint(*parts: str) -> str:
    basis = "|".join(p.strip() for p in parts if p and str(p).strip())[:900]
    return hashlib.sha256(basis.encode("utf-8", errors="replace")).hexdigest()[:48]


def _normalize_severity(severity: str) -> str:
    s = (severity or "error").strip().lower()
    return s if s in VALID_SEVERITIES else "error"


def _normalize_category(category: str) -> str:
    c = (category or "system").strip().lower()
    return c if c in VALID_CATEGORIES else "system"


def record_application_error(
    db: Session | None = None,
    *,
    severity: str = "error",
    category: str = "system",
    source: str,
    message: str,
    detail: str | None = None,
    stack_trace: str | None = None,
    context: dict[str, Any] | None = None,
    user_id: int | None = None,
    job_id: str | None = None,
    plate: str | None = None,
    track_id: int | None = None,
    ip_address: str | None = None,
    fingerprint: str | None = None,
    dedupe_seconds: int = 120,
    commit: bool = True,
) -> ApplicationError | None:
    """
    Persist or dedupe an error row. Returns the row or None if recording failed silently.
    """
    msg = (message or "").strip()
    if not msg:
        return None

    sev = _normalize_severity(severity)
    cat = _normalize_category(category)
    src = (source or "unknown")[:120]
    fp = (fingerprint or make_fingerprint(cat, src, sev, msg[:400])).strip()[:128]

    own_session = db is None
    session = db or SessionLocal()
    try:
        cutoff = datetime.now(UTC) - timedelta(seconds=max(30, int(dedupe_seconds)))
        existing = (
            session.query(ApplicationError)
            .filter(
                ApplicationError.fingerprint == fp,
                ApplicationError.resolved.is_(False),
                ApplicationError.last_seen_at >= cutoff,
            )
            .order_by(ApplicationError.id.desc())
            .first()
        )
        now = datetime.now(UTC)
        if existing is not None:
            existing.occurrence_count = int(existing.occurrence_count or 1) + 1
            existing.last_seen_at = now
            if detail and not existing.detail:
                existing.detail = detail[:32000]
            if context:
                prev = existing.context if isinstance(existing.context, dict) else {}
                merged = {**prev, **context}
                existing.context = merged
            if commit:
                session.commit()
                session.refresh(existing)
            return existing

        row = ApplicationError(
            severity=sev,
            category=cat,
            source=src,
            message=msg[:8000],
            detail=(detail or "")[:32000] or None,
            stack_trace=(stack_trace or "")[:48000] or None,
            context=context,
            fingerprint=fp,
            occurrence_count=1,
            user_id=user_id,
            job_id=(job_id or "")[:64] or None,
            plate=(plate or "")[:32] or None,
            track_id=track_id,
            ip_address=(ip_address or "")[:45] or None,
            resolved=False,
            last_seen_at=now,
        )
        session.add(row)
        if commit:
            session.commit()
            session.refresh(row)
        else:
            session.flush()
        if sev in ("error", "critical"):
            _log.warning("[%s/%s] %s — %s", cat, src, sev, msg[:240])
        return row
    except Exception:
        _log.exception("Failed to record application error")
        if commit:
            try:
                session.rollback()
            except Exception:
                pass
        return None
    finally:
        if own_session:
            session.close()


def record_exception(
    exc: BaseException,
    *,
    category: str = "system",
    source: str,
    message: str | None = None,
    context: dict[str, Any] | None = None,
    **kwargs: Any,
) -> ApplicationError | None:
    return record_application_error(
        severity=kwargs.pop("severity", "error"),
        category=category,
        source=source,
        message=message or str(exc) or exc.__class__.__name__,
        stack_trace=traceback.format_exc(),
        context={**(context or {}), "exception_type": exc.__class__.__name__},
        fingerprint=kwargs.pop("fingerprint", None)
        or make_fingerprint(category, source, exc.__class__.__name__, str(exc)[:300]),
        **kwargs,
    )
