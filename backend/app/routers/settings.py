"""
Organization settings persisted in settings.json (merged with defaults).
PATCH accepts only known keys and coerces types — unknown keys are ignored.
"""
from __future__ import annotations

import json
import os
from typing import Any

from fastapi import APIRouter, Depends
from zoneinfo import available_timezones

from ..models.user import User
from ..utils.auth import require_admin
from ..utils.qatar_time import invalidate_business_timezone_cache

router = APIRouter(prefix="/api/settings", tags=["Settings"])

SETTINGS_FILE = os.path.join(os.path.dirname(__file__), "..", "..", "settings.json")

DEFAULT_SETTINGS: dict[str, Any] = {
    # —— Organization ——
    "business_name": "CarTrack Pro",
    "business_email": "",
    "phone": "",
    "address": "Doha, Qatar",
    "tax_id": "",
    "currency": "QAR",
    "timezone": "Asia/Qatar",
    "default_locale": "en",
    # —— Operations ——
    "total_bays": 5,
    "max_service_hours": 8,
    "overstay_threshold_minutes": 120,
    "grace_period_minutes": 15,
    "idle_warning_minutes": 45,
    "opening_time": "07:00",
    "closing_time": "22:00",
    "require_signature": True,
    "auto_checkout": False,
    "week_starts_on": "sunday",
    "max_concurrent_active_visits": 0,
    # —— Revenue / display ——
    "tax_rate_percent": 0.0,
    "prices_include_tax": False,
    "show_revenue_to_staff": False,
    # —— Notifications ——
    "email_notifications": False,
    "sms_notifications": False,
    "whatsapp_notifications": True,
    "overstay_alerts": True,
    "new_entry_alerts": False,
    "daily_report": False,
    "notification_email": "",
    # —— Integrations / AI ——
    "ai_lpr_enabled": False,
    "vehicle_detection_enabled": False,
    "debug_mode": False,
    "ai_confidence": 0.7,
    "camera_poll_interval": 30,
    "visionflow_deep_analysis_default": False,
    "anpr_auto_suggest_visit": True,
    # Re-entry / dwell continuity: when a tracked vehicle leaves the camera view
    # (e.g. moves to another bay), its record is "Paused" and keeps waiting this
    # long. If the SAME plate reappears within the window the in-shop duration
    # resumes; if not, the record flips Paused → Done. 0 disables (always Done).
    "plate_resume_wait_minutes": 120,
    # —— Privacy / audit ——
    "admin_2fa": False,
    "audit_all": True,
    "client_error_auto_capture": True,
    # —— Security ——
    "session_timeout_minutes": 480,
    "max_login_attempts": 5,
    "allowed_ips": "",
    # —— Experience ——
    "maintenance_message": "",
    "compact_ui_density": False,
}


def _truthy(v: Any) -> bool:
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return v != 0
    if isinstance(v, str):
        return v.strip().lower() in ("1", "true", "yes", "on")
    return False


def _coerce_value(key: str, val: Any) -> Any:
    if key not in DEFAULT_SETTINGS:
        return None
    default = DEFAULT_SETTINGS[key]
    if isinstance(default, bool):
        return _truthy(val)
    if isinstance(default, int):
        if val in ("", None):
            return None
        try:
            return int(float(val))
        except (TypeError, ValueError):
            return None
    if isinstance(default, float):
        if val in ("", None):
            return None
        try:
            return float(val)
        except (TypeError, ValueError):
            return None
    if isinstance(default, str):
        return str(val).strip() if val is not None else ""
    return val


def _sanitize_patch(body: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k, raw in body.items():
        if k not in DEFAULT_SETTINGS:
            continue
        coerced = _coerce_value(k, raw)
        if coerced is None:
            continue
        # Light clamps for numeric safety
        if k == "tax_rate_percent":
            out[k] = max(0.0, min(100.0, float(coerced)))
        elif k == "ai_confidence":
            out[k] = max(0.05, min(0.99, float(coerced)))
        elif k in ("total_bays", "max_service_hours", "overstay_threshold_minutes", "grace_period_minutes"):
            out[k] = max(0, min(10_000, int(coerced)))
        elif k == "plate_resume_wait_minutes":
            # 0 = always finalize on exit; cap at 7 days so the timer can't run forever.
            out[k] = max(0, min(60 * 24 * 7, int(coerced)))
        elif k == "idle_warning_minutes":
            out[k] = max(5, min(24 * 60, int(coerced)))
        elif k == "camera_poll_interval":
            out[k] = max(5, min(3600, int(coerced)))
        elif k == "session_timeout_minutes":
            out[k] = max(15, min(60 * 24 * 14, int(coerced)))
        elif k == "max_login_attempts":
            out[k] = max(3, min(50, int(coerced)))
        elif k == "max_concurrent_active_visits":
            out[k] = max(0, min(5000, int(coerced)))
        elif k == "week_starts_on":
            s = str(coerced).lower()
            out[k] = s if s in ("sunday", "monday") else DEFAULT_SETTINGS[k]
        elif k == "default_locale":
            s = str(coerced).lower()[:12]
            out[k] = s if s else "en"
        elif k == "timezone":
            s = str(coerced).strip()
            if s and s in available_timezones():
                out[k] = s
        else:
            out[k] = coerced
    return out


import threading
import time as _time

# Short-TTL cache so the high-frequency engine consolidation (called every couple
# of frames per live camera) doesn't re-read settings.json from disk each time,
# while still picking up UI changes within a few seconds.
_resume_gap_cache: dict[str, float] = {"value": -1.0, "expires": 0.0}
_resume_gap_lock = threading.Lock()
_RESUME_GAP_TTL_SEC = 5.0


def get_resume_gap_seconds() -> float:
    """Operator-configured vehicle re-entry waiting period, in seconds.

    Reads ``plate_resume_wait_minutes`` from settings.json (cached). Falls back to
    ``settings.PLATE_RESUME_GAP_SEC`` when unset/invalid. ``0`` minutes means a
    track is finalized (Done) as soon as it exits — no waiting/resume window.
    """
    now = _time.monotonic()
    cached = _resume_gap_cache
    if cached["value"] >= 0 and now < cached["expires"]:
        return cached["value"]
    with _resume_gap_lock:
        if cached["value"] >= 0 and now < cached["expires"]:
            return cached["value"]
        from ..config import settings
        value = float(settings.PLATE_RESUME_GAP_SEC)
        try:
            mins = _load().get("plate_resume_wait_minutes")
            if mins is not None:
                value = max(0.0, float(mins) * 60.0)
        except Exception:
            pass
        cached["value"] = value
        cached["expires"] = now + _RESUME_GAP_TTL_SEC
        return value


def _load() -> dict[str, Any]:
    try:
        if os.path.exists(SETTINGS_FILE):
            with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, dict):
                    merged = {**DEFAULT_SETTINGS, **data}
                    return {k: merged[k] for k in DEFAULT_SETTINGS}
    except Exception:
        pass
    return DEFAULT_SETTINGS.copy()


def _save(data: dict[str, Any]) -> None:
    try:
        with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
    except Exception:
        pass


@router.get("/public")
def get_public_settings():
    """Unauthenticated branding, notices, and coarse feature flags for all clients."""
    s = _load()
    return {
        "business_name": s.get("business_name") or DEFAULT_SETTINGS["business_name"],
        "maintenance_message": (s.get("maintenance_message") or "").strip(),
        "client_error_auto_capture": bool(s.get("client_error_auto_capture", True)),
        "timezone": (s.get("timezone") or DEFAULT_SETTINGS["timezone"] or "Asia/Qatar").strip(),
    }


@router.get("")
def get_settings(current_user: User = Depends(require_admin)):
    return _load()


@router.patch("")
def update_settings(body: dict[str, Any], current_user: User = Depends(require_admin)):
    current = _load()
    patch = _sanitize_patch(body)
    current.update(patch)
    _save(current)
    invalidate_business_timezone_cache()
    return current


@router.post("/reset")
def reset_settings(current_user: User = Depends(require_admin)):
    data = DEFAULT_SETTINGS.copy()
    _save(data)
    invalidate_business_timezone_cache()
    return data


# ── Backups (admin) ───────────────────────────────────────────────────────────

@router.post("/backup-now")
def backup_now(current_user: User = Depends(require_admin)):
    """Trigger an immediate backup set and return its summary."""
    from ..services.backup_service import run_backup

    return run_backup()


@router.get("/backups")
def get_backups(current_user: User = Depends(require_admin)):
    from ..config import settings as cfg
    from ..services.backup_service import backup_root, last_backup_status, list_backups

    return {
        "enabled": bool(getattr(cfg, "BACKUP_ENABLED", True)),
        "interval_hours": float(getattr(cfg, "BACKUP_INTERVAL_HOURS", 6.0)),
        "retention_days": int(getattr(cfg, "BACKUP_RETENTION_DAYS", 14)),
        "backup_dir": backup_root(),
        "last_run": last_backup_status(),
        "backups": list_backups(),
    }


@router.get("/whatsapp-status")
def whatsapp_status(current_user: User = Depends(require_admin)):
    """Whether WhatsApp completion notifications are wired up."""
    from ..services.whatsapp_notify import status_summary

    return status_summary()


@router.get("/ocr-training")
def ocr_training_status(current_user: User = Depends(require_admin)):
    """Qatar OCR fine-tuning harness — dataset stats and next steps."""
    from pathlib import Path

    import csv

    backend = Path(__file__).resolve().parents[2]
    dataset = backend / "training" / "ocr_dataset"
    labels = dataset / "labels.csv"
    crops_dir = dataset / "crops"
    out: dict[str, Any] = {
        "dataset_dir": str(dataset),
        "labels_csv": labels.is_file(),
        "doc_path": str(backend / "training" / "OCR_FINETUNING.md"),
        "harvest_script": "python backend/training/harvest_plate_dataset.py",
        "evaluate_script": "python backend/training/evaluate_ocr.py",
    }
    if labels.is_file():
        try:
            with labels.open(newline="", encoding="utf-8") as f:
                rows = list(csv.DictReader(f))
            labeled = sum(1 for r in rows if (r.get("ground_truth") or "").strip())
            out.update({
                "total_crops": len(rows),
                "labeled_crops": labeled,
                "unlabeled_crops": len(rows) - labeled,
            })
        except Exception as exc:
            out["labels_error"] = str(exc)
    if crops_dir.is_dir():
        out["crop_files"] = sum(1 for p in crops_dir.glob("*") if p.is_file())
    return out
