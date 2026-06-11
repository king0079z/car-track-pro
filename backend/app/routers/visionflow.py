"""
VisionFlow API router — mounted at /vf/api.
Provides video upload, background YOLO11+EasyOCR analysis, job polling,
live JPEG preview, annotated-video download, and analysis history.
"""

from __future__ import annotations

import logging
import os
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path

import cv2
from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse

from ..database import SessionLocal
from ..services import analysis_history as hist
from ..services.visionflow_engine import (
    _BACKEND_DIR,
    analyze_live_stream,
    analyze_video_path,
    default_analyze_args,
)
from ..services.live_supervisor import get_live_supervisor
from ..services.visionflow_model import model_status, resolve_yolo_weights
from ..config import settings

_log = logging.getLogger(__name__)

# ── Paths ─────────────────────────────────────────────────────────────────────
# In the cloud deploy CARTRACK_DATA_DIR (e.g. /app/data) is a bind-mounted folder
# so every SQLite file *and* its WAL sidecars persist across container recreates.
# Absent the env var (local dev) we keep the historical backend-dir locations.
_DATA_DIR = Path(os.environ.get("CARTRACK_DATA_DIR") or _BACKEND_DIR)
UPLOAD_DIR = _BACKEND_DIR / "uploads"
OUTPUT_DIR = _BACKEND_DIR / "outputs"
HISTORY_DB = _DATA_DIR / "analysis_history.db"
LIVE_SESSIONS_DB = _DATA_DIR / "live_sessions.db"

ALLOWED_EXT = {".mp4", ".avi", ".mov", ".mkv", ".webm", ".m4v"}

# Single-worker thread pool — YOLO is single-GPU; queue jobs one at a time
_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="visionflow")
_jobs_lock = threading.Lock()
_jobs: dict[str, dict] = {}
_preview_lock = threading.Lock()
_preview_jpeg: dict[str, bytes] = {}
_live_stop_events: dict[str, threading.Event] = {}
_live_threads: dict[str, threading.Thread] = {}


def _evict_finished_jobs() -> None:
    """Cap retained terminal (done/error) job records so _jobs can't grow forever.

    Running/queued jobs are never evicted. dict preserves insertion order, so the
    oldest finished jobs are dropped first along with their preview/stop-event state.
    """
    keep = max(8, int(getattr(settings, "LIVE_JOB_RETENTION", 64)))
    victims: list[str] = []
    with _jobs_lock:
        terminal = [
            jid for jid, j in _jobs.items()
            if str(j.get("status") or "") in ("done", "error")
        ]
        excess = len(terminal) - keep
        if excess > 0:
            victims = terminal[:excess]
            for jid in victims:
                _jobs.pop(jid, None)
                _live_stop_events.pop(jid, None)
                _live_threads.pop(jid, None)
    if victims:
        with _preview_lock:
            for jid in victims:
                _preview_jpeg.pop(jid, None)


def _stop_usb_webcam_live_jobs(keep_job_id: str | None = None) -> None:
    """Stop live jobs on USB/PC indices (0,1,…) so a Dahua RTSP feed is not mixed with webcam."""
    from ..services.live_camera import normalize_live_source

    with _jobs_lock:
        victims = [
            jid
            for jid, j in _jobs.items()
            if jid != keep_job_id
            and j.get("is_live")
            and str(j.get("status") or "") in ("queued", "running")
            and normalize_live_source(str(j.get("live_source") or "")).isdigit()
        ]
    for jid in victims:
        ev = _live_stop_events.get(jid)
        if ev is not None:
            ev.set()


def _stop_other_live_jobs(keep_job_id: str | None = None) -> None:
    """Stop every other in-memory live session (legacy single-feed mode)."""
    with _jobs_lock:
        victims = [
            jid for jid, j in _jobs.items()
            if jid != keep_job_id
            and j.get("is_live")
            and str(j.get("status") or "") in ("queued", "running")
        ]
    for jid in victims:
        ev = _live_stop_events.get(jid)
        if ev is not None:
            ev.set()
        with _jobs_lock:
            j = _jobs.get(jid)
            if j is not None and j.get("status") == "queued":
                j["status"] = "done"
                j["message"] = "Stopped — replaced by a new live session."


def _stop_live_for_source(source: str, keep_job_id: str | None = None) -> None:
    """Stop live jobs using the same camera / stream source (multi-camera safe)."""
    from ..services.live_camera import normalize_live_source

    norm = normalize_live_source(source)
    with _jobs_lock:
        victims = []
        for jid, j in _jobs.items():
            if jid == keep_job_id:
                continue
            if not j.get("is_live"):
                continue
            if str(j.get("status") or "") not in ("queued", "running"):
                continue
            js = normalize_live_source(str(j.get("live_source") or ""))
            if js == norm:
                victims.append(jid)
    for jid in victims:
        ev = _live_stop_events.get(jid)
        if ev is not None:
            ev.set()
        with _jobs_lock:
            j = _jobs.get(jid)
            if j is not None and j.get("status") == "queued":
                j["status"] = "done"
                j["message"] = "Stopped — replaced on the same camera source."


def _disable_stale_always_on_sessions(
    *,
    keep_session_id: str | None = None,
    source: str | None = None,
) -> int:
    """Turn off persisted 24/7 sessions that would conflict with a new live job."""
    from ..services import live_persistence as persist

    if source is not None:
        return persist.disable_sessions_for_source(
            LIVE_SESSIONS_DB, source, keep_session_id=keep_session_id
        )
    if keep_session_id:
        return persist.disable_all_except(LIVE_SESSIONS_DB, keep_session_id)
    return persist.disable_all_enabled(LIVE_SESSIONS_DB)


def _multi_cam_pipeline_opts(**overrides) -> dict:
    """Lighter defaults when up to four live analysis feeds run in parallel."""
    opts = _coerce_opts(
        conf=0.18,
        iou=0.55,
        stride=2,
        width=960,
        meter_per_pixel=0.05,
        max_speed=130.0,
        speed_smooth=0.4,
        fps=0.0,
        ocr_interval=3,
        min_ocr_conf=0.3,
        track_imgsz=896,
        prefer_fast_encoder=False,
        preview_jpeg_quality=72,
    )
    opts.update(overrides)
    return opts


# ── Helpers ───────────────────────────────────────────────────────────────────

def _coerce_opts(
    conf, iou, stride, width, meter_per_pixel, max_speed,
    speed_smooth, fps, ocr_interval, min_ocr_conf,
    track_imgsz, prefer_fast_encoder, preview_jpeg_quality,
) -> dict:
    return {
        "conf": max(0.02, min(0.95, float(conf))),
        "iou": max(0.1, min(0.95, float(iou))),
        "stride": max(1, min(8, int(stride))),
        "width": max(480, min(1920, int(width))),
        "meter_per_pixel": max(1e-4, min(0.5, float(meter_per_pixel))),
        "max_speed": max(5.0, min(300.0, float(max_speed))),
        "speed_smooth": max(0.05, min(0.95, float(speed_smooth))),
        "fps": max(0.0, min(240.0, float(fps))),
        "ocr_interval": max(1, min(12, int(ocr_interval))),
        "min_ocr_conf": max(0.0, min(1.0, float(min_ocr_conf))),
        "track_imgsz": max(640, min(1600, int(track_imgsz))),
        "prefer_fast_encoder": bool(prefer_fast_encoder),
        "preview_jpeg_quality": max(45, min(95, int(preview_jpeg_quality))),
    }


def _probe_video_meta(path: Path, stride: int) -> tuple[float, int]:
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        return 30.0, 0
    vfps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
    raw = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    cap.release()
    if vfps < 1.0 or vfps > 240.0:
        vfps = 30.0
    stride = max(1, int(stride))
    total_est = max(1, (raw + stride - 1) // stride) if raw > 0 else 1
    return vfps, total_est


def _persist_job(job_id: str) -> None:
    with _jobs_lock:
        j = _jobs.get(job_id)
        if j is None:
            return
        snap = dict(j)
    hist.save_snapshot(HISTORY_DB, job_id, snap)


def _auto_sync_to_cartrack(job_id: str, video_name: str, vehicles: list) -> int:
    """
    Server-side sync: insert every valid plate segment detected by VisionFlow into
    the CarTrack `anpr_detections` table, link to open unsigned work orders when
    the plate returns within PLATE_RESUME_GAP_SEC, and accumulate in-frame dwell.

    Returns the number of rows inserted. Safe to call multiple times — deduplicates
    per (job_id, plate, track_id, exit time), not per plate alone (bay-move segments).
    """
    from ..models.anpr import ANPRDetection
    from ..models.vehicle import Vehicle
    from ..services.camera_presence import link_job_segments_to_visits, segment_already_synced
    from ..utils.plates import accept_plate_read, format_qatar_plate, sync_eligible_plate

    valid = [
        v for v in (vehicles or [])
        if v.get("plate")
        and str(v["plate"]).strip().upper() not in ("", "—", "…", "UNKNOWN")
        and sync_eligible_plate(
            str(v["plate"]),
            jurisdiction=settings.PLATE_JURISDICTION,
        )
    ]
    if not valid:
        return 0

    saved = 0
    inserted = 0
    db = SessionLocal()
    try:
        existing_rows = (
            db.query(ANPRDetection)
            .filter(ANPRDetection.job_id == job_id)
            .all()
        )
        for v in valid:
            plate = format_qatar_plate(str(v["plate"]).strip()).upper()
            tid = v.get("track_id")
            tx = v.get("t_exit_sec")
            if segment_already_synced(existing_rows, plate, tid, float(tx) if tx is not None else None):
                saved += 1
                continue

            vehicle = db.query(Vehicle).filter(Vehicle.plate_number == plate).first()
            te = v.get("t_enter_sec")
            ds = v.get("duration_sec")
            row = ANPRDetection(
                plate=plate,
                speed_kmh=v.get("speed_kmh_avg") or v.get("speed_kmh_max") or v.get("speed_kmh_last"),
                track_id=tid,
                job_id=job_id,
                video_name=video_name,
                vehicle_id=vehicle.id if vehicle else None,
                detected_at=datetime.now(UTC),
                t_enter_sec=float(te) if te is not None else None,
                t_exit_sec=float(tx) if tx is not None else None,
                duration_sec=float(ds) if ds is not None else None,
            )
            db.add(row)
            db.flush()
            existing_rows.append(row)
            saved += 1
            inserted += 1

        link_job_segments_to_visits(db, job_id)
        db.commit()
        # Only log when rows were actually inserted. This runs on the hot
        # frame-processing thread during live/analyze; logging on every dedup
        # tick floods the output pipe and can block (freezing the frame loop).
        if inserted:
            _log.info(
                "ANPR auto-sync: job=%s  +%d new (%d total)  video=%s",
                job_id, inserted, saved, video_name,
            )
    except Exception as exc:
        db.rollback()
        _log.error("ANPR auto-sync failed for job %s: %s", job_id, exc)
        from ..services.error_recorder import record_exception

        record_exception(
            exc,
            category="anpr",
            source="visionflow.auto_sync",
            message=f"ANPR auto-sync failed for job {job_id}",
            job_id=job_id,
            context={"video_name": video_name, "segment_count": len(valid)},
        )
        saved = 0
    finally:
        db.close()
    return saved


def _collect_syncable_rows(rows: list, synced_keys: set[str]) -> list:
    """
    Pick manifest rows to persist mid-session.

    A car is captured when its track cleanly exits OR when it has a confident,
    plate-eligible read and has lingered long enough — the latter rescues cars
    whose track fragments (BoT-SORT re-IDs) so they never emit a clean "exit",
    which previously caused stable plates (e.g. fast-moving lane traffic) to be
    detected on-screen yet never saved. Dedup is by normalized plate so the same
    vehicle isn't re-synced every tick or across re-ID fragments.
    """
    newly_done = []
    for v in rows:
        plate = str(v.get("plate") or "").strip().upper()
        if not plate or plate in ("", "—", "…", "UNKNOWN"):
            continue
        norm = "".join(ch for ch in plate if ch.isalnum())
        if len(norm) < 3 or norm in synced_keys:
            continue
        vst = str(v.get("status") or "").lower()
        exited = vst in ("exited", "done", "exit")
        dwell = float(v.get("duration_sec") or 0.0)
        votes = int(v.get("ocr_vote_count") or 0)
        confident_active = (not exited) and dwell >= 1.5 and votes >= 2
        if exited or confident_active:
            synced_keys.add(norm)
            newly_done.append(v)
    return newly_done


def _job_payload(job_id: str) -> dict | None:
    with _jobs_lock:
        j = _jobs.get(job_id)
    if j is not None:
        out = dict(j)
        out["job_id"] = job_id
        return out
    row = hist.get_job(HISTORY_DB, job_id)
    if row is None:
        return None
    row["job_id"] = job_id
    return row


def _validate_live_source(source: str) -> str:
    from ..services.dahua_camera import is_dahua_alias, resolve_dahua_source
    from ..services.live_camera import normalize_live_source, local_camera_label

    raw = (source or "").strip()
    if is_dahua_alias(raw):
        resolved = resolve_dahua_source(raw)
        if not resolved:
            raise HTTPException(
                status_code=400,
                detail=(
                    "Dahua Hero A1 is not configured yet. Open Settings → AI & vision, "
                    "enter the camera IP from the DMSS app, then use source dahua-hero-a1."
                ),
            )
        return resolved

    s = normalize_live_source(source)
    if s.isdigit():
        idx = int(s)
        if idx < 0 or idx > 64:
            raise HTTPException(status_code=400, detail="Camera index must be between 0 and 64.")
        return s
    low = s.lower()
    if low.startswith("rtsp://") or low.startswith("rtsps://"):
        return s
    if low.startswith("http://") or low.startswith("https://"):
        return s
    raise HTTPException(
        status_code=400,
        detail="Unsupported source. Leave empty or use 0 for the PC/laptop camera, "
        "a USB index (1, 2, …), dahua-hero-a1 for the configured Dahua Hero A1, "
        "or an rtsp(s):// / http(s):// URL reachable from the server.",
    )


def _live_input_label(source: str) -> str:
    from ..services.dahua_camera import hero_profile_for_config, is_dahua_alias
    from ..services.live_camera import local_camera_label, normalize_live_source

    raw = (source or "").strip()
    if is_dahua_alias(raw):
        prof = hero_profile_for_config()
        return f"Live: {prof.get('model', 'Dahua')} ({prof.get('name', 'Wi-Fi camera')})"
    s = normalize_live_source(source)
    if s.isdigit():
        return f"Live: {local_camera_label(s)}"
    if "/cam/realmonitor" in s.lower():
        prof = hero_profile_for_config()
        return f"Live: {prof.get('model', 'Dahua')} (RTSP)"
    return f"Live: {s[:160]}"


def _is_dahua_live_source(source: str, raw: str | None = None) -> bool:
    from ..services.dahua_camera import is_dahua_alias

    raw = (raw or source or "").strip()
    if is_dahua_alias(raw):
        return True
    low = (source or "").lower()
    return "/cam/realmonitor" in low or "dahua" in low.split("@")[0]


def _live_start_message(source: str, raw: str | None = None) -> str:
    if _is_dahua_live_source(source, raw):
        return "Connecting to Dahua camera (RTSP)…"
    if (source or "").strip().isdigit():
        return "Starting PC camera…"
    if (source or "").lower().startswith("rtsp"):
        return "Connecting to RTSP stream…"
    return "Connecting to camera…"


def _run_job(job_id: str, input_path: Path, output_path: Path, opts: dict) -> None:
    os.environ["TRACK_IMGSZ"] = str(int(opts["track_imgsz"]))
    args = default_analyze_args(
        conf=opts["conf"],
        iou=opts["iou"],
        stride=opts["stride"],
        width=opts["width"],
        meter_per_pixel=opts["meter_per_pixel"],
        max_speed=opts["max_speed"],
        speed_smooth=opts["speed_smooth"],
        fps=opts["fps"],
        ocr_interval=opts["ocr_interval"],
        min_ocr_conf=opts["min_ocr_conf"],
    )

    progress_ticks = [0]
    last_manifest_persist = [0.0]
    last_live_sync = [0.0]
    # Track keys already synced to CarTrack mid-analysis so we don't duplicate
    _synced_keys: set[str] = set()   # key = f"{track_id}:{plate}"

    input_name_ref: list[str] = [""]
    with _jobs_lock:
        input_name_ref[0] = _jobs.get(job_id, {}).get("input_name", "")

    def progress(done: int, total: int) -> None:
        with _jobs_lock:
            j = _jobs.get(job_id)
            if j is None:
                return
            j["progress"] = min(100.0, 100.0 * float(done) / float(max(total, 1)))
            j["processed_frames"] = done
        progress_ticks[0] += 1
        if progress_ticks[0] % 20 == 0:
            _persist_job(job_id)

    def phase(msg: str) -> None:
        with _jobs_lock:
            j = _jobs.get(job_id)
            if j is None:
                return
            j["message"] = msg

    def push_preview(jpeg: bytes) -> None:
        with _preview_lock:
            _preview_jpeg[job_id] = jpeg

    def push_manifest(rows: list) -> None:
        with _jobs_lock:
            j = _jobs.get(job_id)
            if j is not None:
                j["vehicles"] = list(rows)
        now = time.monotonic()
        if now - last_manifest_persist[0] >= 1.25:
            last_manifest_persist[0] = now
            _persist_job(job_id)

        # ── Live incremental sync: push any EXITED vehicle to CarTrack immediately ──
        # Rate-limit to at most once per 0.5 s to avoid hammering the DB
        if now - last_live_sync[0] < 0.5:
            return
        last_live_sync[0] = now

        newly_done = _collect_syncable_rows(rows, _synced_keys)
        if newly_done:
            _auto_sync_to_cartrack(job_id, input_name_ref[0], newly_done)

    try:
        with _jobs_lock:
            _jobs[job_id]["status"] = "running"
            _jobs[job_id]["message"] = "Starting…"
            _jobs[job_id]["vehicles"] = []
        _persist_job(job_id)

        os.environ.setdefault("HEADLESS", "1")
        result = analyze_video_path(
            input_path,
            args,
            output_video_path=output_path,
            progress_callback=progress,
            phase_callback=phase,
            prefer_fast_encoder=bool(opts.get("prefer_fast_encoder", False)),
            preview_jpeg_callback=push_preview,
            preview_stream_fps=12.0,
            preview_jpeg_quality=int(opts.get("preview_jpeg_quality", 78)),
            manifest_callback=push_manifest,
            show_window=False,
            max_frames=0,
        )

        final_vehicles = result.get("vehicles") or []
        input_name = ""
        with _jobs_lock:
            _jobs[job_id]["status"] = "done"
            _jobs[job_id]["progress"] = 100.0
            _jobs[job_id]["output_file"] = output_path.name
            _jobs[job_id]["message"] = "Done. Download your annotated video."
            _jobs[job_id]["vehicles"] = final_vehicles
            _jobs[job_id]["video_fps"] = result.get("video_fps")
            input_name = _jobs[job_id].get("input_name", "")
        _persist_job(job_id)

        # ── Final sync: catch any plates still active at end of video ──────────
        # (exited vehicles were already synced live; dedup handles duplicates)
        _auto_sync_to_cartrack(job_id, input_name, final_vehicles)
    except Exception as err:
        with _jobs_lock:
            j = _jobs.get(job_id)
            if j is not None:
                j["status"] = "error"
                j["message"] = str(err)
                j["error_detail"] = str(err)
        _persist_job(job_id)
        from ..services.error_recorder import record_exception

        record_exception(
            err,
            category="visionflow",
            source="visionflow.analyze_job",
            message=str(err),
            job_id=job_id,
        )
    finally:
        with _preview_lock:
            _preview_jpeg.pop(job_id, None)


def _run_live_job(
    job_id: str,
    source: str,
    output_path: Path | None,
    opts: dict,
    *,
    always_on: bool = False,
    session_id: str | None = None,
    input_label: str | None = None,
) -> None:
    stop_event = threading.Event()
    with _jobs_lock:
        _live_stop_events[job_id] = stop_event

    os.environ["TRACK_IMGSZ"] = str(int(opts["track_imgsz"]))
    args = default_analyze_args(
        conf=opts["conf"],
        iou=opts["iou"],
        stride=opts["stride"],
        width=opts["width"],
        meter_per_pixel=opts["meter_per_pixel"],
        max_speed=opts["max_speed"],
        speed_smooth=opts["speed_smooth"],
        fps=opts["fps"],
        ocr_interval=opts["ocr_interval"],
        min_ocr_conf=opts["min_ocr_conf"],
    )

    progress_ticks = [0]
    last_manifest_persist = [0.0]
    last_live_sync = [0.0]
    _synced_keys: set[str] = set()
    session_started = time.monotonic()

    input_name_ref: list[str] = [input_label or ""]
    with _jobs_lock:
        if not input_name_ref[0]:
            input_name_ref[0] = _jobs.get(job_id, {}).get("input_name", "")

    def progress(done: int, total: int) -> None:
        with _jobs_lock:
            j = _jobs.get(job_id)
            if j is None:
                return
            j["processed_frames"] = done
            j["progress"] = None
            lh = j.get("live_health") or {}
            lh["processed_frames"] = done
            lh["uptime_sec"] = round(time.monotonic() - session_started, 1)
            j["live_health"] = lh
        progress_ticks[0] += 1
        if progress_ticks[0] % 25 == 0:
            _persist_job(job_id)

    def phase(msg: str) -> None:
        with _jobs_lock:
            j = _jobs.get(job_id)
            if j is None:
                return
            j["message"] = msg
            lh = j.get("live_health") or {}
            lh["message"] = msg
            j["live_health"] = lh

    def push_health(data: dict) -> None:
        with _jobs_lock:
            j = _jobs.get(job_id)
            if j is None:
                return
            prev = j.get("live_health") or {}
            prev.update(data)
            j["live_health"] = prev

    def push_preview(jpeg: bytes) -> None:
        with _preview_lock:
            _preview_jpeg[job_id] = jpeg

    def push_manifest(rows: list) -> None:
        with _jobs_lock:
            j = _jobs.get(job_id)
            if j is not None:
                j["vehicles"] = list(rows)
        now = time.monotonic()
        if now - last_manifest_persist[0] >= 1.25:
            last_manifest_persist[0] = now
            _persist_job(job_id)

        if now - last_live_sync[0] < 0.5:
            return
        last_live_sync[0] = now

        newly_done = _collect_syncable_rows(rows, _synced_keys)
        if newly_done:
            _auto_sync_to_cartrack(job_id, input_name_ref[0], newly_done)

    try:
        with _jobs_lock:
            _jobs[job_id]["status"] = "running"
            _jobs[job_id]["message"] = "Live — connecting…"
            _jobs[job_id]["vehicles"] = []
            _jobs[job_id]["live_health"] = {
                "stream_connected": False,
                "reconnect_count": 0,
                "uptime_sec": 0,
                "processed_frames": 0,
                "segments": [],
                "message": "Connecting…",
            }
        _persist_job(job_id)

        from ..services.opencv_headless import ensure_headless_opencv

        ensure_headless_opencv()
        other_live = _active_live_job_count_excluding(job_id)
        result = analyze_live_stream(
            source,
            args,
            stop_event=stop_event,
            output_video_path=output_path,
            progress_callback=progress,
            phase_callback=phase,
            prefer_fast_encoder=bool(opts.get("prefer_fast_encoder", False)),
            preview_jpeg_callback=push_preview,
            preview_stream_fps=12.0,
            preview_jpeg_quality=int(opts.get("preview_jpeg_quality", 78)),
            manifest_callback=push_manifest,
            show_window=False,
            always_on=always_on,
            health_callback=push_health,
            skip_preview_warmup=other_live > 0,
        )

        final_vehicles = result.get("vehicles") or []
        input_name = ""
        segments = result.get("output_segments") or []
        latest = segments[-1] if segments else result.get("output_video")
        with _jobs_lock:
            if always_on and not stop_event.is_set():
                # Supervisor will restart; treat as transient end.
                _jobs[job_id]["status"] = "running"
                _jobs[job_id]["message"] = "Live session recovering…"
            else:
                _jobs[job_id]["status"] = "done"
                _jobs[job_id]["progress"] = 100.0
                _jobs[job_id]["message"] = "Live session ended. Review plates below or download recording."
            if latest:
                seg_name = Path(str(latest)).name
                _jobs[job_id]["output_file"] = (
                    f"{session_id}_live/{seg_name}" if session_id and segments else Path(str(latest)).name
                )
            else:
                _jobs[job_id]["output_file"] = None
            _jobs[job_id]["vehicles"] = final_vehicles
            _jobs[job_id]["video_fps"] = result.get("video_fps")
            lh = _jobs[job_id].get("live_health") or {}
            lh["segments"] = segments
            lh["reconnect_count"] = result.get("reconnect_count", lh.get("reconnect_count", 0))
            _jobs[job_id]["live_health"] = lh
            input_name = _jobs[job_id].get("input_name", "")
        _persist_job(job_id)

        if not always_on or stop_event.is_set():
            _auto_sync_to_cartrack(job_id, input_name, final_vehicles)
    except Exception as err:
        with _jobs_lock:
            j = _jobs.get(job_id)
            if j is not None:
                if always_on and not stop_event.is_set():
                    j["status"] = "running"
                    j["message"] = f"Recovering after error: {err}"
                    lh = j.get("live_health") or {}
                    lh["message"] = str(err)
                    lh["stream_connected"] = False
                    j["live_health"] = lh
                else:
                    j["status"] = "error"
                    j["message"] = str(err)
                    j["error_detail"] = str(err)
        _persist_job(job_id)
        from ..services.error_recorder import record_exception

        record_exception(
            err,
            category="camera" if always_on else "visionflow",
            source="visionflow.live_job",
            message=str(err),
            job_id=job_id,
            context={"always_on": always_on, "source": source},
            severity="warning" if always_on and not stop_event.is_set() else "error",
        )
    finally:
        _live_stop_events.pop(job_id, None)
        _live_threads.pop(job_id, None)
        # Keep last preview frame visible until the job record is removed.


def _enqueue_live_job(
    job_id: str,
    source: str,
    output_path: Path | None,
    opts: dict,
    *,
    label: str,
    always_on: bool = False,
    session_id: str | None = None,
    record: bool = True,
    slot_index: int | None = None,
    stop_scope: str = "source",
) -> None:
    opts_saved = {**opts, "live_source": source, "probe_video_fps": float(opts.get("fps") or 0.0)}
    start_msg = _live_start_message(source)
    with _jobs_lock:
        _jobs[job_id] = {
            "status": "running",
            "progress": None,
            "message": start_msg,
            "processed_frames": 0,
            "total_frames_est": 0,
            "output_file": None,
            "input_name": label,
            "live_source": source,
            "slot_index": slot_index,
            "vehicles": [],
            "analyze_options": opts_saved,
            "is_live": True,
            "always_on": always_on,
            "session_id": session_id,
            "record": record,
            "live_health": {},
        }
    _persist_job(job_id)
    _evict_finished_jobs()
    if stop_scope == "all":
        _stop_other_live_jobs(keep_job_id=job_id)
    else:
        _stop_live_for_source(source, keep_job_id=job_id)
    t = threading.Thread(
        target=_run_live_job,
        args=(job_id, source, output_path, opts),
        kwargs={
            "always_on": always_on,
            "session_id": session_id,
            "input_label": label,
        },
        name=f"visionflow-live-{job_id[:8]}",
        daemon=True,
    )
    _live_threads[job_id] = t
    t.start()


# ── Router ────────────────────────────────────────────────────────────────────

router = APIRouter(prefix="/vf/api", tags=["VisionFlow"])


def _supervisor_launch(
    job_id: str,
    source: str,
    output_path: Path | None,
    opts: dict,
    *,
    always_on: bool = True,
    session_id: str | None = None,
    input_label: str | None = None,
) -> None:
    slot_index: int | None = None
    if session_id:
        from ..services import live_persistence as persist

        row = persist.get_session(LIVE_SESSIONS_DB, session_id)
        if row is not None and row.get("slot_index") is not None:
            slot_index = int(row["slot_index"])
    _enqueue_live_job(
        job_id,
        source,
        output_path,
        opts,
        label=input_label or f"Live: {source[:160]}",
        always_on=always_on,
        session_id=session_id,
        record=output_path is not None,
        slot_index=slot_index,
        stop_scope="source",
    )


def init_visionflow() -> None:
    """Call once at startup to create required directories and init DB."""
    from ..services import live_persistence as persist

    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    hist.init_db(HISTORY_DB)
    persist.init_db(LIVE_SESSIONS_DB)
    removed = persist.dedupe_by_source(LIVE_SESSIONS_DB)
    if removed:
        _log.info("Disabled %d duplicate always-on live session(s) at startup", removed)
    pruned = 0
    if settings.LIVE_PROBE_CAMERAS_ON_STARTUP:
        pruned = persist.prune_sessions_for_missing_usb_cameras(
            LIVE_SESSIONS_DB, max_index=settings.LIVE_MAX_CAMERAS
        )
    if pruned:
        _log.info(
            "Disabled %d always-on session(s) for USB indices not present on this PC",
            pruned,
        )
    get_live_supervisor().bind(
        db_path=LIVE_SESSIONS_DB,
        output_dir=OUTPUT_DIR,
        start_fn=_supervisor_launch,
        jobs_lock=_jobs_lock,
        jobs=_jobs,
    )


@router.get("/history")
async def list_history(limit: int = Query(100, ge=1, le=500)) -> JSONResponse:
    rows = hist.list_recent(HISTORY_DB, limit=limit)
    return JSONResponse({"items": rows})


@router.post("/analyze")
async def analyze_upload(
    file: UploadFile = File(...),
    conf: float = Form(0.16),
    iou: float = Form(0.55),
    stride: int = Form(2),
    width: int = Form(1120),
    meter_per_pixel: float = Form(0.05),
    max_speed: float = Form(130.0),
    speed_smooth: float = Form(0.38),
    fps: float = Form(0.0),
    ocr_interval: int = Form(1),
    min_ocr_conf: float = Form(0.20),
    track_imgsz: int = Form(1088),
    prefer_fast_encoder: str = Form("false"),
    preview_jpeg_quality: int = Form(78),
) -> JSONResponse:
    if not file.filename:
        raise HTTPException(status_code=400, detail="No filename")

    suffix = Path(file.filename).suffix.lower()
    if suffix not in ALLOWED_EXT:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported type {suffix or '(none)'}. Use: {', '.join(sorted(ALLOWED_EXT))}",
        )

    # Check YOLO weights exist before accepting upload
    if resolve_yolo_weights() is None:
        raise HTTPException(
            status_code=503,
            detail=(
                "YOLO weights not found. Place yolo26_best.pt or best.pt in backend/models/, "
                "or set YOLO26_WEIGHTS in .env, then restart the server."
            ),
        )

    fast = str(prefer_fast_encoder).lower() in ("1", "true", "yes", "on")
    opts = _coerce_opts(
        conf, iou, stride, width, meter_per_pixel, max_speed,
        speed_smooth, fps, ocr_interval, min_ocr_conf,
        track_imgsz, fast, preview_jpeg_quality,
    )

    job_id = uuid.uuid4().hex
    stem = Path(file.filename).stem[:80] or "video"
    in_path = UPLOAD_DIR / f"{job_id}_{stem}{suffix}"
    out_path = OUTPUT_DIR / f"{job_id}_{stem}_annotated.mp4"

    data = await file.read()
    if len(data) > 800 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="File too large (max 800 MB).")

    in_path.write_bytes(data)

    vfps_hint, total_est = _probe_video_meta(in_path, opts["stride"])
    opts_saved = {**opts, "probe_video_fps": vfps_hint}

    with _jobs_lock:
        _jobs[job_id] = {
            "status": "queued",
            "progress": 0.0,
            "message": "Queued…",
            "processed_frames": 0,
            "total_frames_est": total_est,
            "output_file": None,
            "input_name": file.filename,
            "vehicles": [],
            "analyze_options": opts_saved,
        }
    _persist_job(job_id)
    _evict_finished_jobs()

    _executor.submit(_run_job, job_id, in_path, out_path, opts)
    return JSONResponse({"job_id": job_id})


@router.post("/live/start")
async def live_start(
    source: str = Form(...),
    conf: float = Form(0.16),
    iou: float = Form(0.55),
    stride: int = Form(2),
    width: int = Form(1120),
    meter_per_pixel: float = Form(0.05),
    max_speed: float = Form(130.0),
    speed_smooth: float = Form(0.38),
    fps: float = Form(0.0),
    ocr_interval: int = Form(2),
    min_ocr_conf: float = Form(0.28),
    track_imgsz: int = Form(1088),
    prefer_fast_encoder: str = Form("false"),
    preview_jpeg_quality: int = Form(78),
    record: str = Form("true"),
    always_on: str = Form("false"),
) -> JSONResponse:
    """
    Start live ANPR + speed analysis from a camera index (0,1,…) on the **server host**
    or from an RTSP / HTTP(S) stream URL that the server can open with OpenCV.

    Set ``always_on=true`` for 24/7 mode: auto-reconnect, segmented recording, and
    automatic resume after server restart.
    """
    if resolve_yolo_weights() is None:
        raise HTTPException(
            status_code=503,
            detail=(
                "YOLO weights not found. Place yolo26_best.pt or best.pt in backend/models/, "
                "or set YOLO26_WEIGHTS in .env, then restart the server."
            ),
        )

    raw_source = (source or "").strip()
    src = _validate_live_source(raw_source)
    fast = str(prefer_fast_encoder).lower() in ("1", "true", "yes", "on")
    opts = _coerce_opts(
        conf, iou, stride, width, meter_per_pixel, max_speed,
        speed_smooth, fps, ocr_interval, min_ocr_conf,
        track_imgsz, fast, preview_jpeg_quality,
    )

    label = _live_input_label(src)
    do_record = str(record).lower() in ("1", "true", "yes", "on")
    do_always = (
        settings.LIVE_24_7_ENABLED
        and str(always_on).lower() in ("1", "true", "yes", "on")
    )

    _stop_live_for_source(src)

    if do_always:
        session_id = uuid.uuid4().hex
        _disable_stale_always_on_sessions(keep_session_id=session_id, source=src)
        out_path: Path | None = OUTPUT_DIR / f"{session_id}_live" if do_record else None
        job_id = get_live_supervisor().register_and_start(
            session_id, src, label, opts, record=do_record, exclusive=True,
        )
        return JSONResponse({
            "job_id": job_id,
            "session_id": session_id,
            "always_on": True,
        })

    _disable_stale_always_on_sessions(source=src)

    job_id = uuid.uuid4().hex
    if do_record:
        out_path = OUTPUT_DIR / f"{job_id}_live" if settings.LIVE_24_7_ENABLED else OUTPUT_DIR / f"{job_id}_live_annotated.mp4"
    else:
        out_path = None
    stop_scope = "all" if _is_dahua_live_source(src, raw_source) else "source"
    _enqueue_live_job(
        job_id, src, out_path, opts,
        label=label,
        always_on=False,
        record=do_record,
        stop_scope=stop_scope,
    )
    return JSONResponse({"job_id": job_id, "always_on": False, "resolved_source": "dahua" if stop_scope == "all" else "other"})


def _active_live_job_count() -> int:
    with _jobs_lock:
        return sum(
            1
            for j in _jobs.values()
            if j.get("is_live") and str(j.get("status") or "") in ("queued", "running")
        )


def _active_live_job_count_excluding(job_id: str) -> int:
    with _jobs_lock:
        return sum(
            1
            for jid, j in _jobs.items()
            if jid != job_id
            and j.get("is_live")
            and str(j.get("status") or "") in ("queued", "running")
        )


def _safe_usb_probe_map(max_slots: int) -> dict[int, dict]:
    """Probe USB cameras only when no live job is using them (avoids false 'not detected')."""
    if _active_live_job_count() > 0:
        return {}
    from ..services.live_camera import probe_local_cameras

    return {c["index"]: c for c in probe_local_cameras(max_index=max_slots)}


def _prune_missing_usb_grid_slots(*, keep_slot: int | None = None) -> int:
    """Stop/disable grid sessions for USB indices that do not exist on this machine."""
    from ..services import live_persistence as persist
    from ..services.live_camera import normalize_live_source

    max_slots = max(1, int(settings.LIVE_MAX_CAMERAS))
    if _active_live_job_count() > 0:
        return 0
    found = set(_safe_usb_probe_map(max_slots).keys())
    if not found:
        return 0
    stopped = 0
    for s in range(max_slots):
        if keep_slot is not None and s == keep_slot:
            continue
        sess = persist.get_session_by_slot(LIVE_SESSIONS_DB, s)
        if not sess or not sess.get("enabled"):
            continue
        src = normalize_live_source(sess["source"])
        if not src.isdigit() or int(src) in found:
            continue
        if sess.get("session_id"):
            get_live_supervisor().disable(str(sess["session_id"]))
        jid = sess.get("job_id")
        if jid:
            ev = _live_stop_events.get(jid)
            if ev is not None:
                ev.set()
        persist.disable_sessions_for_slot(LIVE_SESSIONS_DB, s)
        stopped += 1
    return stopped


def _running_live_job_for_slot(slot: int) -> tuple[str | None, dict | None]:
    """Resolve active in-memory live job for a grid slot (session DB or slot_index fallback)."""
    from ..services import live_persistence as persist

    sess = persist.get_session_by_slot(LIVE_SESSIONS_DB, slot)
    candidates: list[str] = []
    if sess and sess.get("job_id"):
        candidates.append(str(sess["job_id"]))
    with _jobs_lock:
        for jid, j in _jobs.items():
            if jid in candidates:
                continue
            if j.get("slot_index") == slot and j.get("is_live"):
                candidates.append(jid)
        for jid in candidates:
            j = _jobs.get(jid)
            if j and j.get("is_live") and str(j.get("status") or "") in ("queued", "running"):
                out = dict(j)
                out["job_id"] = jid
                return jid, out
    return (str(sess["job_id"]) if sess and sess.get("job_id") else None), None


def _grid_slot_payload(slot: int, *, probe_map: dict[int, dict] | None = None) -> dict:
    from ..services import live_persistence as persist
    from ..services.live_camera import local_camera_label, normalize_live_source

    max_slots = max(1, int(settings.LIVE_MAX_CAMERAS))
    from ..services.dahua_camera import default_dahua_live_token

    dahua_token = default_dahua_live_token()
    default_source = dahua_token if slot == 0 and dahua_token else str(slot)
    sess = persist.get_session_by_slot(LIVE_SESSIONS_DB, slot)
    source = sess["source"] if sess else default_source
    source = normalize_live_source(source)
    job_id, job = _running_live_job_for_slot(slot)
    running = job is not None
    enabled = running
    if probe_map is None:
        probe_map = _safe_usb_probe_map(max_slots)
    cam_idx = int(source) if source.isdigit() else None
    lh = (job or {}).get("live_health") or {}
    if cam_idx is not None:
        if cam_idx in probe_map:
            camera_available = True
        elif running and (lh.get("last_frame_at") or lh.get("stream_connected")):
            camera_available = True
        elif probe_map:
            camera_available = False
        else:
            camera_available = None
    else:
        camera_available = None
    from ..services.dahua_camera import ptz_info_for_source

    ptz_info = ptz_info_for_source(source)
    return {
        "slot": slot,
        "source": source,
        "label": local_camera_label(source),
        "enabled": enabled or running,
        "running": running,
        "session_id": sess.get("session_id") if sess else None,
        "job_id": job_id,
        "job": job,
        "camera_available": camera_available,
        "camera_probe": probe_map.get(cam_idx) if cam_idx is not None else None,
        "camera_id": ptz_info["camera_id"],
        "ptz_supported": ptz_info["ptz_supported"],
        "wifi_supported": ptz_info.get("wifi_supported", False),
    }


@router.get("/live/grid")
async def live_grid() -> JSONResponse:
    """Multi-camera wall status — one entry per grid slot (0 .. LIVE_MAX_CAMERAS-1)."""
    max_slots = max(1, int(settings.LIVE_MAX_CAMERAS))
    probe_map = _safe_usb_probe_map(max_slots)
    slots = [_grid_slot_payload(s, probe_map=probe_map) for s in range(max_slots)]
    active = sum(1 for s in slots if s.get("running"))
    probed_list = list(probe_map.values())
    if not probed_list and active > 0:
        for s in slots:
            if s.get("running") and s.get("camera_available"):
                idx = int(s["source"]) if str(s.get("source", "")).isdigit() else None
                if idx is not None:
                    probed_list.append({"index": idx, "width": 0, "height": 0, "fps": 0.0, "in_use": True})
    return JSONResponse({
        "max_cameras": max_slots,
        "active_feeds": active,
        "slots": slots,
        "probed_cameras": probed_list,
        "cameras_busy": _active_live_job_count() > 0 and len(probe_map) == 0,
    })


@router.post("/live/grid/{slot}/start")
async def grid_slot_start(
    slot: int,
    source: str = Form(""),
    record: str = Form("true"),
    always_on: str = Form("true"),
) -> JSONResponse:
    """Enable live ANPR + speed analysis for one grid slot / camera."""
    max_slots = max(1, int(settings.LIVE_MAX_CAMERAS))
    if slot < 0 or slot >= max_slots:
        raise HTTPException(status_code=400, detail=f"Slot must be 0..{max_slots - 1}")

    if resolve_yolo_weights() is None:
        raise HTTPException(status_code=503, detail="YOLO weights not found on server.")

    from ..services.dahua_camera import default_dahua_live_token, is_dahua_alias, probe_stream

    dahua_default = default_dahua_live_token() or "dahua-hero-a1"
    raw_source = (source or "").strip() or (dahua_default if slot == 0 else str(slot))
    src = _validate_live_source(raw_source)
    if is_dahua_alias(raw_source) or "/cam/realmonitor" in src.lower():
        probe = probe_stream(src, timeout_sec=28.0)
        if not probe.get("ok"):
            raise HTTPException(
                status_code=400,
                detail=probe.get("error")
                or "Could not open Dahua RTSP. Confirm Same Wi-Fi (LAN) mode, IP from DMSS, and Test RTSP in Settings.",
            )
    label = f"Grid {slot + 1}: {_live_input_label(src)}"
    do_record = str(record).lower() in ("1", "true", "yes", "on")
    do_always = str(always_on).lower() in ("1", "true", "yes", "on")
    opts = _multi_cam_pipeline_opts()

    _prune_missing_usb_grid_slots(keep_slot=slot)
    _stop_live_for_source(src)
    if _is_dahua_live_source(src, raw_source):
        _stop_usb_webcam_live_jobs()
    session_id = uuid.uuid4().hex
    from ..services import live_persistence as persist

    persist.disable_sessions_for_slot(LIVE_SESSIONS_DB, slot, keep_session_id=session_id)
    _disable_stale_always_on_sessions(keep_session_id=session_id, source=src)

    if do_always and settings.LIVE_24_7_ENABLED:
        out_path = OUTPUT_DIR / f"{session_id}_live" if do_record else None
        job_id = get_live_supervisor().register_and_start(
            session_id,
            src,
            label,
            opts,
            record=do_record,
            slot_index=slot,
            exclusive=False,
        )
    else:
        job_id = uuid.uuid4().hex
        out_path = OUTPUT_DIR / f"{job_id}_live" if do_record else None
        _enqueue_live_job(
            job_id,
            src,
            out_path,
            opts,
            label=label,
            always_on=False,
            session_id=session_id,
            record=do_record,
            slot_index=slot,
            stop_scope="all" if _is_dahua_live_source(src, raw_source) else "source",
        )
        persist.upsert_session(
            LIVE_SESSIONS_DB,
            session_id,
            source=src,
            label=label,
            opts=opts,
            enabled=True,
            always_on=False,
            record=do_record,
            job_id=job_id,
            slot_index=slot,
        )

    return JSONResponse({
        "ok": True,
        "slot": slot,
        "source": src,
        "job_id": job_id,
        "session_id": session_id if do_always else None,
        "always_on": do_always and settings.LIVE_24_7_ENABLED,
    })


@router.post("/live/grid/{slot}/stop")
async def grid_slot_stop(slot: int) -> JSONResponse:
    """Disable live analysis for one grid slot."""
    max_slots = max(1, int(settings.LIVE_MAX_CAMERAS))
    if slot < 0 or slot >= max_slots:
        raise HTTPException(status_code=400, detail=f"Slot must be 0..{max_slots - 1}")

    from ..services import live_persistence as persist

    sess = persist.get_session_by_slot(LIVE_SESSIONS_DB, slot)
    stopped = False
    if sess:
        if sess.get("session_id"):
            get_live_supervisor().disable(str(sess["session_id"]))
        persist.disable_sessions_for_slot(LIVE_SESSIONS_DB, slot)
        jid = sess.get("job_id")
        if jid:
            ev = _live_stop_events.get(jid)
            if ev is not None:
                ev.set()
                stopped = True
            with _jobs_lock:
                j = _jobs.get(jid)
                if j is not None and j.get("status") in ("queued", "running"):
                    j["status"] = "done"
                    j["message"] = f"Grid slot {slot + 1} stopped."
                    stopped = True
        with _preview_lock:
            if jid:
                _preview_jpeg.pop(jid, None)

    return JSONResponse({"ok": True, "slot": slot, "stopped": stopped})


@router.post("/live/grid/stop-all")
async def grid_stop_all() -> JSONResponse:
    """Stop every active grid / live camera feed."""
    from ..services import live_persistence as persist

    n = 0
    max_slots = max(1, int(settings.LIVE_MAX_CAMERAS))
    for slot in range(max_slots):
        sess = persist.get_session_by_slot(LIVE_SESSIONS_DB, slot)
        if not sess:
            continue
        if sess.get("session_id"):
            get_live_supervisor().disable(str(sess["session_id"]))
        persist.disable_sessions_for_slot(LIVE_SESSIONS_DB, slot)
        jid = sess.get("job_id")
        if jid:
            ev = _live_stop_events.get(jid)
            if ev is not None:
                ev.set()
                n += 1
            with _jobs_lock:
                j = _jobs.get(jid)
                if j is not None and j.get("status") in ("queued", "running"):
                    j["status"] = "done"
                    j["message"] = "Live feeds stopped."
            with _preview_lock:
                _preview_jpeg.pop(jid, None)
    return JSONResponse({"ok": True, "stopped": n})


@router.post("/live/stop/{job_id}")
async def live_stop(job_id: str) -> JSONResponse:
    """Signal a running live session to stop gracefully."""
    session_id: str | None = None
    with _jobs_lock:
        j = _jobs.get(job_id)
        if j is None:
            raise HTTPException(status_code=404, detail="Unknown job")
        if not j.get("is_live"):
            raise HTTPException(status_code=400, detail="This job is not a live camera session.")
        if j.get("status") not in ("queued", "running"):
            raise HTTPException(status_code=409, detail="Live session is not active.")
        session_id = j.get("session_id")
        if j.get("always_on") and session_id:
            get_live_supervisor().disable(str(session_id))

    ev = _live_stop_events.get(job_id)
    if ev is not None:
        ev.set()
    return JSONResponse({"ok": True, "job_id": job_id})


@router.post("/live/sessions/dedupe")
async def dedupe_live_sessions() -> JSONResponse:
    """Disable duplicate always-on sessions that share the same camera/source."""
    from ..services import live_persistence as persist

    removed = persist.dedupe_by_source(LIVE_SESSIONS_DB)
    return JSONResponse({"disabled": removed})


@router.get("/live/sessions")
async def live_sessions() -> JSONResponse:
    """List persisted 24/7 live camera sessions."""
    items = get_live_supervisor().list_sessions()
    enriched = []
    for s in items:
        job = _job_payload(s["job_id"]) if s.get("job_id") else None
        enriched.append({**s, "job": job})
    return JSONResponse({"items": enriched})


@router.get("/live/cameras")
async def list_local_cameras(max_index: int = Query(4, ge=1, le=8)) -> JSONResponse:
    """Probe USB / built-in cameras on the **server** machine (index 0 = default laptop cam)."""
    from ..services.live_camera import probe_local_cameras

    cameras = probe_local_cameras(max_index=max_index)
    return JSONResponse({
        "default_index": 0 if any(c["index"] == 0 for c in cameras) else (cameras[0]["index"] if cameras else 0),
        "cameras": cameras,
        "hint": "Use source 0 (or leave empty) to open the PC/laptop camera on the server.",
    })


@router.get("/live/health")
async def live_health() -> JSONResponse:
    """Aggregate + per-feed health for all active live sessions.

    Each feed reports last-frame age and a `healthy` flag so the UI / monitoring can
    tell a genuinely-live camera from a stalled or reconnecting one at a glance.
    """
    sessions = get_live_supervisor().list_sessions(enabled_only=True)
    stale_sec = max(30.0, float(settings.LIVE_STALE_FRAME_SEC))
    now = datetime.now(UTC)

    feeds: list[dict] = []
    with _jobs_lock:
        running = [
            (jid, dict(j)) for jid, j in _jobs.items()
            if j.get("is_live") and j.get("status") == "running"
        ]

    healthy_count = 0
    stale_count = 0
    for jid, j in running:
        health = j.get("live_health") or {}
        age_sec: float | None = None
        last_at = health.get("last_frame_at")
        if last_at:
            try:
                last_dt = datetime.fromisoformat(str(last_at).replace("Z", "+00:00"))
                if last_dt.tzinfo is None:
                    last_dt = last_dt.replace(tzinfo=UTC)
                age_sec = round((now - last_dt).total_seconds(), 1)
            except Exception:
                age_sec = None
        # No frame yet (warming up) is treated as not-yet-stale.
        healthy = age_sec is not None and age_sec <= stale_sec
        if healthy:
            healthy_count += 1
        elif age_sec is not None:
            stale_count += 1
        feeds.append({
            "job_id": jid,
            "session_id": j.get("session_id"),
            "slot_index": j.get("slot_index"),
            "label": j.get("input_name"),
            "always_on": bool(j.get("always_on")),
            "processed_frames": int(j.get("processed_frames") or 0),
            "last_frame_age_sec": age_sec,
            "reconnect_count": health.get("reconnect_count"),
            "stream_connected": health.get("stream_connected"),
            "uptime_sec": health.get("uptime_sec"),
            "message": health.get("message") or j.get("message"),
            "healthy": healthy,
        })

    try:
        from ..services import stream_governor

        governor = stream_governor.snapshot()
    except Exception:
        governor = {}

    return JSONResponse({
        "live_24_7_enabled": settings.LIVE_24_7_ENABLED,
        "active_live_jobs": len(feeds),
        "healthy_feeds": healthy_count,
        "stale_feeds": stale_count,
        "always_on_sessions": len(sessions),
        "stale_threshold_sec": stale_sec,
        "feeds": feeds,
        "sessions": sessions,
        "stream_saver": {
            "enabled": bool(getattr(settings, "STREAM_SAVER_ENABLED", True)),
            "hybrid_sd_hd": bool(getattr(settings, "STREAM_HYBRID_ENABLED", True)),
            "idle_power_save": bool(getattr(settings, "LIVE_IDLE_ENABLED", True)),
            "sources": governor,
        },
    })


def _note_preview_viewer(job_id: str) -> None:
    """Tell the stream governor a human is watching this feed — keeps a
    power-saved cloud stream awake / wakes an idle one instantly."""
    with _jobs_lock:
        j = _jobs.get(job_id)
        src = str(j.get("live_source") or "") if (j and j.get("is_live")) else ""
    if not src:
        return
    try:
        from ..services import stream_governor
        from ..services.live_camera import normalize_live_source

        stream_governor.note_viewer(normalize_live_source(src))
    except Exception:
        pass


@router.get("/jobs/{job_id}/snapshot.jpg")
async def job_snapshot(job_id: str) -> Response:
    with _jobs_lock:
        if job_id not in _jobs:
            raise HTTPException(status_code=404, detail="Unknown job")
    _note_preview_viewer(job_id)
    with _preview_lock:
        data = _preview_jpeg.get(job_id)
    if not data:
        # Job exists but models/frames aren't ready yet — 204 avoids noisy 404 polling in devtools.
        return Response(status_code=204)
    return Response(content=data, media_type="image/jpeg")


@router.get("/jobs/{job_id}/stream.mjpg")
async def job_stream(job_id: str) -> StreamingResponse:
    """Push-based MJPEG preview (one persistent connection) instead of JPEG polling.

    Scales far better than per-panel polling at many cameras. The client can simply
    point an <img> tag at this URL. Ends when the job stops or the feed goes idle.
    """
    import asyncio

    with _jobs_lock:
        if job_id not in _jobs:
            raise HTTPException(status_code=404, detail="Unknown job")

    async def _gen():
        last: bytes | None = None
        idle_ticks = 0
        viewer_tick = 0
        while True:
            with _jobs_lock:
                j = _jobs.get(job_id)
            if j is None or str(j.get("status") or "") not in ("queued", "running"):
                break
            viewer_tick += 1
            if viewer_tick % 100 == 1:  # ~every 10s on the 0.1s cadence
                _note_preview_viewer(job_id)
            with _preview_lock:
                data = _preview_jpeg.get(job_id)
            if data is not None and data is not last:
                last = data
                idle_ticks = 0
                yield (b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + data + b"\r\n")
            else:
                idle_ticks += 1
                if idle_ticks > 600:  # ~60s with no new frame → close the stream
                    break
            await asyncio.sleep(0.1)

    return StreamingResponse(
        _gen(), media_type="multipart/x-mixed-replace; boundary=frame"
    )


@router.get("/jobs/{job_id}")
async def job_status(job_id: str) -> JSONResponse:
    payload = _job_payload(job_id)
    if payload is None:
        raise HTTPException(status_code=404, detail="Unknown job")
    return JSONResponse(payload)


@router.get("/jobs/{job_id}/video")
async def job_video(job_id: str) -> FileResponse:
    j = _job_payload(job_id)
    if j is None:
        raise HTTPException(status_code=404, detail="Unknown job")
    if j.get("status") != "done":
        raise HTTPException(status_code=409, detail="Job not finished")
    name = j.get("output_file")
    if not name:
        raise HTTPException(status_code=404, detail="No output file")
    path = OUTPUT_DIR / name
    if not path.is_file():
        # Segmented live recording: output_file may be "session_id_live/segment_….mp4"
        alt = OUTPUT_DIR / name.replace("\\", "/")
        if alt.is_file():
            path = alt
        else:
            raise HTTPException(status_code=404, detail="Output missing on disk")
    return FileResponse(
        path,
        media_type="video/mp4",
        filename=f"annotated_{j.get('input_name', 'video')}".replace("/", "_"),
    )


@router.post("/jobs/{job_id}/sync")
async def sync_job_to_cartrack(job_id: str) -> JSONResponse:
    """
    Manually (re-)sync a completed job's plates to the CarTrack database.
    Safe to call multiple times — deduplicates automatically.
    """
    payload = _job_payload(job_id)
    if payload is None:
        raise HTTPException(status_code=404, detail="Unknown job")
    if payload.get("status") != "done":
        raise HTTPException(status_code=409, detail="Job not finished yet")
    n = _auto_sync_to_cartrack(
        job_id,
        payload.get("input_name", ""),
        payload.get("vehicles") or [],
    )
    return JSONResponse({"synced": n, "job_id": job_id})


@router.post("/sync-history")
async def sync_history_to_cartrack(limit: int = Query(50, ge=1, le=500)) -> JSONResponse:
    """
    Retroactive sync: scan the last `limit` completed history jobs and push any
    un-synced plates into CarTrack.  Call once after server upgrade.
    """
    rows = hist.list_recent(HISTORY_DB, limit=limit)
    total = 0
    jobs_synced = 0
    for row in rows:
        if row.get("status") != "done":
            continue
        jid = row["job_id"]
        full = hist.get_job(HISTORY_DB, jid)
        if not full:
            continue
        n = _auto_sync_to_cartrack(jid, full.get("input_name", ""), full.get("vehicles") or [])
        if n:
            total += n
            jobs_synced += 1
    return JSONResponse({"jobs_scanned": len(rows), "jobs_synced": jobs_synced, "plates_synced": total})


@router.get("/status")
async def visionflow_status() -> JSONResponse:
    """Health check: VisionFlow API reachability and YOLO weights status."""
    info = model_status()
    with _jobs_lock:
        active = sum(1 for j in _jobs.values() if j.get("status") in ("queued", "running"))
        live_running = [
            {"job_id": jid, "input_name": j.get("input_name"), "live_health": j.get("live_health")}
            for jid, j in _jobs.items()
            if j.get("is_live") and j.get("status") == "running"
        ]
    return JSONResponse({
        "ready": info["ready"],
        "model": info["path"],
        "model_family": info["family"],
        "tracker": info["tracker"],
        "ocr_engine": info["ocr_engine"],
        "active_jobs": active,
        "live_24_7_enabled": settings.LIVE_24_7_ENABLED,
        "live_running": live_running,
        "upload_dir": str(UPLOAD_DIR),
        "output_dir": str(OUTPUT_DIR),
    })
