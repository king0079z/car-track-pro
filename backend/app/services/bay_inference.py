"""Infer service bay from VisionFlow job / camera registry."""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

from . import live_persistence as persist
from .camera_config import list_cameras
from .live_camera import normalize_live_source
from .dahua_camera import source_for_camera, dahua_id_from_source, is_dahua_alias


def _live_sessions_db() -> Path:
    data = os.environ.get("CARTRACK_DATA_DIR")
    if data and os.path.isdir(data):
        return Path(data) / "live_sessions.db"
    return Path(__file__).resolve().parents[2] / "live_sessions.db"


def parse_bay_from_text(text: str | None) -> int | None:
    """Extract bay number from labels like 'Bay 1', 'bay_2', 'Panel 3 — …'."""
    if not text or not str(text).strip():
        return None
    s = str(text).strip()
    for pat in (
        r"bay[\s_\-]*#?\s*(\d{1,2})",
        r"panel[\s_\-]*#?\s*(\d{1,2})",
        r"slot[\s_\-]*(\d{1,2})",
    ):
        m = re.search(pat, s, re.I)
        if m:
            n = int(m.group(1))
            if 1 <= n <= 32:
                return n
    return None


def _camera_for_slot(slot_index: int | None) -> dict[str, Any] | None:
    if slot_index is None:
        return None
    for cam in list_cameras():
        if int(cam.get("slot_index") or -1) == int(slot_index):
            return cam
    return None


def _camera_for_source(source: str | None) -> dict[str, Any] | None:
    if not source:
        return None
    norm = normalize_live_source(source)
    for cam in list_cameras():
        try:
            if normalize_live_source(source_for_camera(cam)) == norm:
                return cam
        except Exception:
            continue
    if is_dahua_alias(norm):
        cid = dahua_id_from_source(norm)
        if cid:
            for cam in list_cameras():
                if str(cam.get("id") or "") == cid:
                    return cam
    return None


def _bay_from_camera(cam: dict[str, Any] | None) -> int | None:
    if not cam:
        return None
    raw = cam.get("assigned_bay")
    if raw is not None:
        try:
            n = int(raw)
            if 1 <= n <= 32:
                return n
        except (TypeError, ValueError):
            pass
    for field in ("name", "label"):
        parsed = parse_bay_from_text(str(cam.get(field) or ""))
        if parsed:
            return parsed
    slot = cam.get("slot_index")
    if slot is not None:
        try:
            return int(slot) + 1
        except (TypeError, ValueError):
            pass
    return None


def _session_for_job(job_id: str | None) -> dict[str, Any] | None:
    if not job_id or not str(job_id).strip():
        return None
    db = _live_sessions_db()
    if not db.is_file():
        return None
    jid = str(job_id).strip()
    for sess in persist.list_sessions(db):
        if str(sess.get("job_id") or "") == jid:
            return sess
    return None


def resolve_bay_for_job(
    job_id: str | None,
    *,
    video_name: str | None = None,
) -> dict[str, Any]:
    """
    Resolve bay + camera metadata for a VisionFlow job id.
    Returns { bay, camera_name, slot_index, source, method }.
    """
    out: dict[str, Any] = {
        "bay": None,
        "camera_name": None,
        "slot_index": None,
        "source": None,
        "method": None,
    }
    sess = _session_for_job(job_id)
    slot_index = None
    source = None
    label = None
    if sess:
        slot_index = sess.get("slot_index")
        source = sess.get("source")
        label = sess.get("label")
        out["slot_index"] = slot_index
        out["source"] = source

    cam = _camera_for_slot(slot_index) if slot_index is not None else None
    if not cam and source:
        cam = _camera_for_source(source)

    if cam:
        out["camera_name"] = str(cam.get("name") or cam.get("label") or "").strip() or None

    bay = _bay_from_camera(cam)
    method = "camera_registry" if bay else None

    if not bay and label:
        bay = parse_bay_from_text(label)
        if bay:
            method = "session_label"
    if not bay and video_name:
        bay = parse_bay_from_text(video_name)
        if bay:
            method = "video_name"
    if not bay and slot_index is not None:
        try:
            bay = int(slot_index) + 1
            method = "slot_index"
        except (TypeError, ValueError):
            pass

    out["bay"] = bay
    out["method"] = method
    return out


def resolve_bay_for_detection(det) -> dict[str, Any]:
    """Resolve bay from an ANPRDetection ORM row."""
    info = resolve_bay_for_job(getattr(det, "job_id", None), video_name=getattr(det, "video_name", None))
    info["job_id"] = getattr(det, "job_id", None)
    info["detection_id"] = getattr(det, "id", None)
    return info
