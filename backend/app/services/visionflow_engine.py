"""
VisionFlow YOLO + BoT-SORT + EasyOCR speed/plate engine.
Supports YOLO11 and YOLO26 plate-detector weights (see visionflow_model.py).

Models load lazily — only when analyze_video_path() is first called,
so the CarTrack backend starts instantly with no blocking warm-up.

Requires: backend/models/best.pt or yolo26_best.pt (or YOLO26_WEIGHTS env)
"""

from __future__ import annotations

import argparse
import logging
import math
import os
import re
import sqlite3
import threading
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from ..config import settings
from ..utils.plates import (
    accept_plate_read,
    consolidate_vehicle_rows,
    format_qatar_plate,
    normalize_plate,
    plates_match,
    sync_eligible_plate,
    vote_best_plate,
)
from ..utils.qatar_time import get_business_zoneinfo
from .visionflow_model import resolve_yolo_weights

# ── Paths ─────────────────────────────────────────────────────────────────────
# backend/app/services/visionflow_engine.py  →  .parents[2] = backend/
_BACKEND_DIR = Path(__file__).resolve().parents[2]
SQLITE_PATH = _BACKEND_DIR / "plates_local.db"

_PLATE_ALLOWLIST = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz- "
_DIGIT_ALLOWLIST = "0123456789"
_LETTER_ALLOWLIST = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
_LABEL_COLOR = (0, 255, 0)  # single green overlay — one style per plate
_MIN_SESSION_SEC = 0.2  # ignore sub-200ms track flickers


_log = logging.getLogger("visionflow.engine")
_PLATE_DEBUG = os.getenv("PLATE_DEBUG", "0").strip().lower() in ("1", "true", "yes", "on")
_PLATE_DEBUG_EVERY = max(1, int(os.getenv("PLATE_DEBUG_EVERY", "15") or "15"))


def _resume_gap_seconds() -> float:
    """Operator-configured vehicle re-entry waiting period (settings.json), in sec.

    Falls back to the static config default if the settings store is unavailable.
    """
    try:
        from ..routers.settings import get_resume_gap_seconds
        return get_resume_gap_seconds()
    except Exception:
        return float(settings.PLATE_RESUME_GAP_SEC)


def _consolidate_manifest_rows(rows: list[dict], *, now_sec: float | None = None) -> list[dict]:
    return consolidate_vehicle_rows(
        rows,
        resume_gap_sec=_resume_gap_seconds(),
        now_sec=now_sec,
        jurisdiction=str(getattr(settings, "PLATE_JURISDICTION", "qa_uk") or "qa_uk"),
    )


def _iou_xyxy(a, b) -> float:
    ax1, ay1, ax2, ay2 = map(float, a)
    bx1, by1, bx2, by2 = map(float, b)
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    if inter <= 0:
        return 0.0
    area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def _box_area(box) -> float:
    x1, y1, x2, y2 = map(float, box)
    return max(0.0, x2 - x1) * max(0.0, y2 - y1)


def _plate_aspect(box) -> float:
    x1, y1, x2, y2 = map(float, box)
    w, h = max(1.0, x2 - x1), max(1.0, y2 - y1)
    return w / h


def _crop_gray_mean(crop: np.ndarray) -> float:
    if crop is None or crop.size == 0:
        return 255.0
    if crop.ndim == 3:
        gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    else:
        gray = crop
    return float(gray.mean())


def _is_dark_plate_crop(crop: np.ndarray, threshold: float = 95.0) -> bool:
    """True when the plate crop is mostly dark (black Qatari/commercial plates)."""
    return _crop_gray_mean(crop) < threshold


def _is_low_res_source(w0: int, h0: int) -> bool:
    """True for cloud SD sub-streams and other feeds below HD-ish resolution."""
    edge = int(getattr(settings, "VF_LIVE_SD_MAX_EDGE", 960) or 960)
    return max(int(w0), int(h0)) < edge


def _resize_for_inference(
    frame: np.ndarray,
    target_w: int,
    new_h: int,
    *,
    native_w: int = 0,
) -> np.ndarray:
    """Upscale with LANCZOS (SD/cloud) or downscale with AREA — same path as video upload."""
    fh, fw = frame.shape[:2]
    tw, th = int(target_w), int(new_h)
    upscaling = tw > fw or th > fh
    low_res = native_w > 0 and native_w < int(getattr(settings, "VF_LIVE_SD_MAX_EDGE", 960))
    interp = cv2.INTER_LANCZOS4 if (upscaling or low_res) else cv2.INTER_AREA
    return cv2.resize(frame, (tw, th), interpolation=interp)


def _enhance_frame_for_detection(im0: np.ndarray, *, low_res: bool = False) -> np.ndarray:
    """Boost local contrast so dark-background plates pop for YOLO."""
    lab = cv2.cvtColor(im0, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    clip = 3.4 if low_res else 2.2
    clahe = cv2.createCLAHE(clipLimit=clip, tileGridSize=(8, 8))
    return cv2.cvtColor(cv2.merge([clahe.apply(l), a, b]), cv2.COLOR_LAB2BGR)


def _enhance_inverted_for_detection(im0: np.ndarray) -> np.ndarray:
    """Stronger contrast boost for white-on-black (commercial) plates."""
    inv = cv2.bitwise_not(_enhance_frame_for_detection(im0))
    lab = cv2.cvtColor(inv, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=3.5, tileGridSize=(8, 8))
    return cv2.cvtColor(cv2.merge([clahe.apply(l), a, b]), cv2.COLOR_LAB2BGR)


def _clip_box_to_frame(box, frame_w: int, frame_h: int) -> tuple[int, int, int, int]:
    x1, y1, x2, y2 = map(int, box)
    fw, fh = max(1, int(frame_w)), max(1, int(frame_h))
    x1 = max(0, min(fw - 1, x1))
    y1 = max(0, min(fh - 1, y1))
    x2 = max(x1 + 1, min(fw, x2))
    y2 = max(y1 + 1, min(fh, y2))
    return x1, y1, x2, y2


def _pad_box_for_ocr(box, frame_w: int, frame_h: int, *, pad_frac: float = 0.12) -> tuple[int, int, int, int]:
    """Expand bbox slightly so OCR sees full characters at plate edges."""
    x1, y1, x2, y2 = _clip_box_to_frame(box, frame_w, frame_h)
    bw, bh = x2 - x1, y2 - y1
    px, py = max(2, int(bw * pad_frac)), max(2, int(bh * pad_frac))
    return _clip_box_to_frame((x1 - px, y1 - py, x2 + px, y2 + py), frame_w, frame_h)


def _is_plate_shaped_box(box, *, min_aspect: float = 1.6, max_aspect: float = 9.0) -> bool:
    """License plates are wide rectangles — skip OCR on obvious non-plate boxes."""
    asp = _plate_aspect(box)
    return min_aspect <= asp <= max_aspect


def _is_likely_plate_crop(im0: np.ndarray, box) -> bool:
    """Reject bumper/grille false positives — real plates have bright or high-contrast crops."""
    if im0 is None or im0.size == 0:
        return False
    fh, fw = im0.shape[:2]
    x1, y1, x2, y2 = _pad_box_for_ocr(box, fw, fh)
    crop = im0[y1:y2, x1:x2]
    if crop.size == 0:
        return False
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if crop.ndim == 3 else crop
    mean = float(gray.mean())
    std = float(gray.std())
    # White Qatari / commercial plates (tolerate SD compression / slight blur)
    if mean >= 55 and std >= 10:
        return True
    # Dark plate with embossed characters
    if mean <= 120 and std >= 28:
        return True
    return False


def _crop_prefers_detection(im0: np.ndarray, box) -> bool:
    """Soft preference — never used alone to discard the only candidate."""
    return _is_likely_plate_crop(im0, box)


def _score_plate_candidate(im0: np.ndarray, conf: float, box) -> float:
    """Rank detections — prefer high conf plus plate-like crop (white/contrast)."""
    score = float(conf)
    if _is_likely_plate_crop(im0, box):
        score += 0.28
    return score


# Minimum plate-box size accepted from the detector. These floors must stay
# small: on multi-lane / elevated footage a readable plate is only ~55-90 px
# wide at the 1020 px working width, and the previous floors (0.07*W ≈ 71 px)
# silently discarded ~50% of correctly detected plates (the farther cars),
# which is why many visible vehicles never reached the registry. The
# aspect-ratio gate (_is_plate_shaped_box) still rejects non-plate noise.
def _min_plate_area_for_frame(frame_h: int, frame_w: int, *, low_res: bool = False) -> float:
    frac = 0.0008 if low_res else 0.0010
    return max(320.0 if low_res else 450.0, float(frame_h * frame_w) * frac)


def _min_plate_width_for_frame(frame_w: int, *, low_res: bool = False) -> float:
    frac = 0.022 if low_res else 0.030
    floor = 22.0 if low_res else 30.0
    return max(floor, float(frame_w) * frac)


def _min_plate_height_for_frame(frame_h: int, *, low_res: bool = False) -> float:
    frac = 0.014 if low_res else 0.018
    floor = 8.0 if low_res else 10.0
    return max(floor, float(frame_h) * frac)


_MAX_PLATE_VOTES = 24
_PLATE_LOCK_MIN_VOTES = 2
_PLATE_LOCK_HIGH_CONF = 0.88
_PLATE_ANCHOR_TTL_FRAMES = 900  # ~30s @ 30fps — resume dwell after camera move


def _should_push_manifest(speed_obj: Any, processed: int) -> bool:
    """Push registry every frame while searching so the UI stays in sync with the video."""
    if processed % 2 == 0:
        return True
    if bool(getattr(speed_obj, "_live_searching", False)):
        return True
    return int(getattr(speed_obj, "_force_global_search", 0)) > 0


MYSQL_HOST = os.environ.get("MYSQL_HOST", "localhost")
MYSQL_USER = os.environ.get("MYSQL_USER", "root")
MYSQL_PASSWORD = os.environ.get("MYSQL_PASSWORD", "")
DB_NAME = "numberplates_speed"


def _point_xy(pt) -> tuple[float, float]:
    x, y = pt[0], pt[1]
    fx = float(x.item()) if hasattr(x, "item") else float(x)
    fy = float(y.item()) if hasattr(y, "item") else float(y)
    return fx, fy


# ── Shared OCR readers ───────────────────────────────────────────────────────
# OCR models are stateless and are by far the largest standalone memory consumer.
# With many concurrent live cameras we share ONE reader across all SpeedEstimator
# instances instead of loading N copies. The underlying torch/onnx models are not
# guaranteed thread-safe, so concurrent calls are serialized via a call lock.
_shared_ocr_build_lock = threading.Lock()
_shared_ocr_call_lock = threading.Lock()
_shared_fast_reader: Any = None
_shared_easy_reader: Any = None
_shared_ocr_engine: str | None = None
_shared_ocr_built = False


_inference_sema: Any = None
_inference_sema_lock = threading.Lock()


def _get_inference_semaphore():
    """Process-wide bounded semaphore limiting concurrent heavy inferences (or None).

    Prevents N live-camera threads from thrashing a single GPU/CPU. Sized by
    ``INFERENCE_MAX_CONCURRENCY`` (≈ GPU count); 0 disables (legacy unlimited).
    """
    global _inference_sema
    n = int(getattr(settings, "INFERENCE_MAX_CONCURRENCY", 0) or 0)
    if n <= 0:
        return None
    if _inference_sema is None:
        with _inference_sema_lock:
            if _inference_sema is None:
                _inference_sema = threading.BoundedSemaphore(n)
    return _inference_sema


def _build_shared_ocr(gpu: bool) -> tuple[Any, Any, str]:
    """Build (and cache) the process-wide OCR reader. Thread-safe; builds once."""
    global _shared_fast_reader, _shared_easy_reader, _shared_ocr_engine, _shared_ocr_built
    with _shared_ocr_build_lock:
        if _shared_ocr_built:
            return _shared_fast_reader, _shared_easy_reader, _shared_ocr_engine or "easyocr"
        engine = (settings.PLATE_OCR_ENGINE or "fast_plate").strip().lower()
        fast_reader: Any = None
        easy_reader: Any = None
        if engine == "fast_plate":
            try:
                from fast_plate_ocr import LicensePlateRecognizer
                fast_reader = LicensePlateRecognizer(settings.FAST_PLATE_MODEL)
            except Exception:
                fast_reader = None
                engine = "easyocr"
        if fast_reader is None:
            import easyocr
            easy_reader = easyocr.Reader(["en"], gpu=gpu, verbose=False)
            engine = "easyocr"
        _shared_fast_reader = fast_reader
        _shared_easy_reader = easy_reader
        _shared_ocr_engine = engine
        _shared_ocr_built = True
        _log.info("Shared OCR reader initialized (engine=%s, gpu=%s)", engine, gpu)
        return fast_reader, easy_reader, engine


# ── SpeedEstimator ─────────────────────────────────────────────────────────────
# Imports are at function call time so the module can be imported without loading
# YOLO/EasyOCR (those are heavy; we only want them loaded when a job actually starts).

class SpeedEstimator:
    """YOLO + BoT-SORT speed estimator with EasyOCR plate reading."""

    def __init__(self, **kwargs):
        from ultralytics.solutions.solutions import BaseSolution
        from ultralytics.utils.plotting import Annotator, colors as ult_colors

        # Build a real BaseSolution subclass at call time so ultralytics internals work
        class _Inner(BaseSolution):
            pass

        from .opencv_headless import ensure_headless_opencv

        ensure_headless_opencv()
        tracker = (kwargs.pop("tracker", None) or settings.YOLO_TRACKER or "botsort.yaml").strip()
        kwargs.setdefault("verbose", False)
        kwargs.setdefault("tracker", tracker)
        kwargs.setdefault("show", False)
        inst = _Inner(**kwargs)
        inst.env_check = False
        if isinstance(inst.CFG, dict):
            inst.CFG["show"] = False
        inst.initialize_region()

        _imgsz = int(os.environ.get("TRACK_IMGSZ", "640"))
        # Plate detector (best.pt) is trained at 640; larger imgsz often misses plates on live HD.
        _imgsz = min(_imgsz, 640) if _imgsz else 640
        if isinstance(inst.CFG, dict):
            inst.CFG["imgsz"] = max(640, _imgsz)
        inst.track_add_args = {**inst.track_add_args, "imgsz": max(640, _imgsz)}

        self._inst = inst
        self._Annotator = Annotator
        self._colors = ult_colors

        self.spd: dict[int, int] = {}
        self._spd_ema: dict[int, float] = {}
        self._spd_samples: dict[int, list[float]] = {}
        self._speed_sum: dict[int, float] = {}
        self._speed_count: dict[int, int] = {}
        self.logged_ids: set[int] = set()
        self._last_ocr_text: dict[int, str] = {}

        self._vid_fps = 30.0
        self._proc_stride: float = 1.0
        self._meter_per_pixel = 0.05
        self._max_speed_kmh = 130.0
        self._speed_smooth = 0.35

        try:
            import torch
            _gpu = bool(settings.USE_GPU and torch.cuda.is_available())
        except Exception:
            _gpu = False

        # OCR engine: fast-plate-ocr (preferred) with EasyOCR fallback.
        self.reader = None          # EasyOCR reader (lazy / fallback)
        self._fast_reader = None    # fast-plate-ocr recognizer
        self._ocr_engine = (settings.PLATE_OCR_ENGINE or "fast_plate").strip().lower()
        self._gpu = _gpu
        if bool(getattr(settings, "LIVE_SHARED_OCR", True)):
            # Reuse one process-wide reader across all cameras; serialize calls.
            self._fast_reader, self.reader, self._ocr_engine = _build_shared_ocr(_gpu)
            self._ocr_call_lock = _shared_ocr_call_lock
        else:
            self._ocr_call_lock = threading.Lock()
            if self._ocr_engine == "fast_plate":
                try:
                    from fast_plate_ocr import LicensePlateRecognizer
                    self._fast_reader = LicensePlateRecognizer(settings.FAST_PLATE_MODEL)
                except Exception:
                    self._fast_reader = None
                    self._ocr_engine = "easyocr"
            if self._fast_reader is None:
                import easyocr
                self.reader = easyocr.Reader(["en"], gpu=_gpu, verbose=False)
                self._ocr_engine = "easyocr"

        self._db_backend: str | None = None
        self.db_connection = self._connect_to_db()

        self._ocr_preprocess = bool(settings.PLATE_OCR_PREPROCESS)
        self._plate_jurisdiction = (settings.PLATE_JURISDICTION or "qa_uk").strip().lower()
        self._plate_strict = bool(settings.PLATE_STRICT_JURISDICTION)
        self._ocr_interval = max(1, int(os.environ.get("OCR_INTERVAL", "2")))
        self._ocr_tick: dict[int, int] = {}
        self._plate_votes: dict[int, list[tuple[str, float]]] = {}

        self._sessions: dict[int, dict[str, Any]] = {}
        self._completed_rows: list[dict[str, Any]] = []
        self._track_registry: dict[int, dict[str, Any]] = {}
        self._best_plate_ever: dict[int, str] = {}
        self._seen_track_ids: set[int] = set()
        self._prev_positive_ids: set[int] = set()
        self._visible_track_ids: set[int] = set()
        self._source_frame_idx = 0
        self._vid_fps_store = 30.0
        self._min_session_sec = _MIN_SESSION_SEC
        # Exit grace: a track must be absent this many processed frames before
        # it is finalized as "exited" — prevents flicker/occlusion false exits.
        self._proc_frame_no = 0
        self._last_seen_frame: dict[int, int] = {}
        self._exit_grace_frames = 10
        # True once the whole session is finalized (file analysis finished or live
        # session stopped). While False the manifest knows "now" and can show
        # recently-exited cars as Paused (waiting to resume); once finalized every
        # exited track is reported as Done.
        self._finalized = False
        # Fallback-detection state (direct YOLO / zoom-out / tiled zoom-in passes).
        self._detect_mode = ""
        self._mode_streak = 0
        self._last_fb_box: list[float] | None = None
        self._fb_tracks: dict[int, tuple[list[float], int]] = {}
        self._fb_next_id = 50000
        self._last_credible_frame: dict[int, int] = {}
        self._last_credible_box: dict[int, list[float]] = {}
        self._ocr_locked: dict[int, bool] = {}
        self._prev_det_boxes: list[list[float]] = []
        self._scene_gray_prev: np.ndarray | None = None
        self._force_global_search = 0
        self._search_fail: dict[int, int] = {}
        self._live_searching = False
        self._plate_dwell_anchor: dict[str, dict[str, Any]] = {}
        self._fb_track_plates: dict[int, str] = {}
        self._tracks_ever_locked: set[int] = set()
        # Confirmed plates seen this session — never drop when a new car appears.
        self._session_registry: dict[str, dict[str, Any]] = {}
        self._session_registry_cap = 200

    def _session_registry_key(self, plate: str) -> str | None:
        cleaned = format_qatar_plate(str(plate or "").strip())
        if not cleaned or not sync_eligible_plate(cleaned, jurisdiction=self._plate_jurisdiction):
            return None
        key = normalize_plate(cleaned)
        return key if len(key) >= 4 else None

    def _merge_session_vehicle_row(self, prev: dict[str, Any], new: dict[str, Any]) -> dict[str, Any]:
        """Merge session snapshots — ``new`` is always the latest consolidated row."""
        out = dict(new)
        out["t_enter_sec"] = round(
            min(float(prev.get("t_enter_sec") or 0.0), float(new.get("t_enter_sec") or 0.0)),
            3,
        )
        out["t_exit_sec"] = round(
            max(float(prev.get("t_exit_sec") or 0.0), float(new.get("t_exit_sec") or 0.0)),
            3,
        )
        out["duration_sec"] = round(
            max(float(prev.get("duration_sec") or 0.0), float(new.get("duration_sec") or 0.0)),
            3,
        )
        if str(new.get("status") or "").lower() == "active":
            pds = float(new.get("presence_duration_sec") or new.get("duration_sec") or 0.0)
        else:
            pds = max(
                float(prev.get("presence_duration_sec") or prev.get("duration_sec") or 0.0),
                float(new.get("presence_duration_sec") or new.get("duration_sec") or 0.0),
            )
        out["presence_duration_sec"] = round(pds, 3)
        out["ocr_vote_count"] = max(
            int(prev.get("ocr_vote_count") or 0),
            int(new.get("ocr_vote_count") or 0),
        )
        out["ocr_confidence"] = round(
            max(float(prev.get("ocr_confidence") or 0.0), float(new.get("ocr_confidence") or 0.0)),
            3,
        )
        out["segment_count"] = max(int(prev.get("segment_count") or 1), int(new.get("segment_count") or 1))
        out["speed_kmh_max"] = max(
            int(prev.get("speed_kmh_max") or 0),
            int(new.get("speed_kmh_max") or 0),
        ) or None
        out["ocr_locked"] = bool(prev.get("ocr_locked")) or bool(new.get("ocr_locked"))
        prev_plate = format_qatar_plate(str(prev.get("plate") or ""))
        new_plate = format_qatar_plate(str(new.get("plate") or ""))
        best = vote_best_plate([(prev_plate, 1.0), (new_plate, 1.0)])
        if best:
            out["plate"] = best
        return out

    def _remember_session_vehicle(self, row: dict[str, Any]) -> None:
        key = self._session_registry_key(str(row.get("plate") or ""))
        if not key:
            return
        snap = dict(row)
        snap["plate"] = format_qatar_plate(str(row.get("plate") or "")) or str(row.get("plate") or "")
        snap["ocr_locked"] = True
        prev = self._session_registry.get(key)
        self._session_registry[key] = (
            self._merge_session_vehicle_row(prev, snap) if prev is not None else snap
        )
        if len(self._session_registry) > self._session_registry_cap:
            oldest = sorted(
                self._session_registry.values(),
                key=lambda r: float(r.get("t_enter_sec") or 0.0),
            )
            for stale in oldest[: len(self._session_registry) - self._session_registry_cap]:
                sk = self._session_registry_key(str(stale.get("plate") or ""))
                if sk:
                    self._session_registry.pop(sk, None)

    def _is_searching_mode(self) -> bool:
        """True while any track still needs full-frame plate acquisition."""
        if int(getattr(self, "_force_global_search", 0)) > 0:
            return True
        if not self._any_ocr_locked():
            return True
        return bool(getattr(self, "_live_searching", False))

    def get_live_anpr_stats(self) -> dict[str, Any]:
        """Lightweight stats for live_health / UI sync."""
        locked = sum(1 for v in self._ocr_locked.values() if v)
        visible = len(getattr(self, "_visible_track_ids", set()) or set())
        n_boxes = len(self.boxes) if self.boxes is not None else 0
        return {
            "boxes": n_boxes,
            "tracks_visible": visible,
            "tracks_locked": locked,
            "tracks_searching": max(0, visible - locked),
            "force_global_search": int(getattr(self, "_force_global_search", 0)),
            "detect_mode": str(getattr(self, "_detect_mode", "") or ""),
            "multi_car": len(getattr(self, "_fb_tracks", {}) or {}) > 1,
            "searching": self._is_searching_mode(),
        }

    def _track_phase(self, track_id: int) -> str:
        if track_id < 0:
            return "searching"
        if self._ocr_locked.get(track_id):
            return "locked"
        if track_id in self._sessions and self._best_plate_ever.get(track_id):
            return "reacquiring"
        return "searching"

    def _plate_display_for_track(self, track_id: int) -> str:
        """Registry label — hide stale OCR only while an active track is still searching."""
        reg = self._track_registry.get(track_id) or {}
        stored = str(reg.get("plate") or "").strip()
        if track_id in self._tracks_ever_locked:
            plate = self._best_plate_for_track(track_id)
            if plate not in ("—", "…", ""):
                return plate
            if stored not in ("—", "…", ""):
                return stored
        if track_id >= 0 and not self._ocr_locked.get(track_id):
            if stored not in ("—", "…", ""):
                return stored
            return "…"
        return self._best_plate_for_track(track_id)

    def _any_ocr_locked(self) -> bool:
        return any(self._ocr_locked.values())

    def _has_only_unconfirmed_detections(self) -> bool:
        tids = list(self.track_ids or [])
        return bool(tids) and all(int(t) < 0 for t in tids)

    def _update_visual_scene(self, im0: np.ndarray) -> bool:
        """Detect camera pan/tilt/zoom via frame diff — invalidates pixel-anchored ROIs."""
        try:
            gray = cv2.cvtColor(im0, cv2.COLOR_BGR2GRAY)
            small = cv2.resize(gray, (160, 90), interpolation=cv2.INTER_AREA).astype(np.float32)
        except Exception:
            return False
        prev = getattr(self, "_scene_gray_prev", None)
        self._scene_gray_prev = small
        if prev is None:
            return False
        diff = float(np.mean(np.abs(small - prev)))
        if diff >= 14.0:
            self._force_global_search = max(int(getattr(self, "_force_global_search", 0)), 12)
            return True
        if diff >= 8.0:
            self._force_global_search = max(int(getattr(self, "_force_global_search", 0)), 4)
        return False

    def _on_scene_activity(self, im0: np.ndarray) -> None:
        """Drop pixel-anchored state when the view changed (angle/distance/zoom)."""
        hard_shift = self._update_visual_scene(im0)
        if not hard_shift:
            return
        self._invalidate_fast_path()
        self._fb_tracks.clear()
        self._last_fb_box = None
        self._prev_det_boxes = []
        for tid in list(self._ocr_locked.keys()):
            self._ocr_locked[tid] = False
        self._search_fail.clear()
        try:
            self._inst.tracks = None
        except Exception:
            pass

    def _reject_untrustworthy_detections(self, im0: np.ndarray, *, strict: bool = False) -> None:
        """Drop bumper false positives only when a better plate candidate exists."""
        boxes = getattr(self, "boxes", None)
        if boxes is None:
            return
        try:
            n = len(boxes)
        except TypeError:
            return
        if n == 0:
            return
        if self._has_only_unconfirmed_detections():
            if strict:
                self._clear_detections()
                self._force_global_search = max(int(getattr(self, "_force_global_search", 0)), 8)
            return
        keep_idx: list[int] = []
        for i in range(n):
            if _is_likely_plate_crop(im0, boxes[i]):
                keep_idx.append(i)
        if len(keep_idx) == n:
            return
        # Keep the best-scored box rather than returning zero detections.
        if not keep_idx:
            if not strict or n == 1:
                return
            self._clear_detections()
            self._force_global_search = max(int(getattr(self, "_force_global_search", 0)), 8)
            return
        try:
            import torch
            if isinstance(boxes, torch.Tensor):
                idx = torch.tensor(keep_idx, dtype=torch.long)
                self.boxes = boxes[idx]
            else:
                self.boxes = boxes[keep_idx]
        except Exception:
            self.boxes = np.array([boxes[i] for i in keep_idx])
        self.track_ids = [self.track_ids[i] for i in keep_idx]
        self.clss = [self.clss[i] for i in keep_idx]

    def _promote_or_clear_unconfirmed(self, im0: np.ndarray) -> None:
        """Salvaged Solutions boxes use negative ids — promote or discard before OCR."""
        if not self._has_only_unconfirmed_detections():
            return
        boxes = getattr(self, "boxes", None)
        if boxes is None or len(boxes) == 0:
            return
        keep_idx = [
            i for i in range(len(boxes))
            if _is_likely_plate_crop(im0, boxes[i])
        ]
        if not keep_idx:
            self._clear_detections()
            self._force_global_search = max(int(getattr(self, "_force_global_search", 0)), 10)
            return
        try:
            import torch
            if isinstance(boxes, torch.Tensor):
                idx = torch.tensor(keep_idx, dtype=torch.long)
                self.boxes = boxes[idx]
            else:
                self.boxes = np.array([boxes[i] for i in keep_idx])
        except Exception:
            self.boxes = np.array([boxes[i] for i in keep_idx])
        self.clss = [self.clss[i] for i in keep_idx]
        self.track_ids = [self._fallback_track_id(self.boxes[i]) for i in range(len(keep_idx))]

    def _global_rescan_plates(
        self,
        im0: np.ndarray,
        fh: int,
        fw: int,
        min_area: float,
        detect_im: np.ndarray,
        inv_im: np.ndarray,
    ) -> None:
        """Full-frame YOLO sweep — find plates anywhere after angle/distance change."""
        pool = self._direct_yolo_batch([im0, detect_im, inv_im])
        zoom = self._zoom_out_candidate(im0)
        if zoom is not None:
            pool = self._merge_plate_candidates(pool + [zoom])
        if not pool:
            pool = self._tiled_yolo_all_plates(im0)
        pool.sort(key=lambda p: _score_plate_candidate(im0, p[0], p[1]), reverse=True)
        trusted = [p for p in pool if _crop_prefers_detection(im0, p[1])]
        use = trusted if trusted else pool
        if not use:
            return
        self._set_fallback_detections([p[1] for p in use], [p[2] for p in use])
        self._filter_tiny_boxes(fh, fw, salvage=True)
        if self._detection_is_weak(fh, fw, min_area):
            self._clear_detections()
            return
        self._detect_mode = "multi" if len(use) > 1 else "tile"
        self._mode_streak = 0

    def _turbo_global_rescan(
        self,
        im0: np.ndarray,
        fh: int,
        fw: int,
        min_area: float,
        detect_im: np.ndarray,
        inv_im: np.ndarray,
    ) -> bool:
        """Fast path during angle/distance change — batched YOLO + zoom + tiles."""
        self._global_rescan_plates(im0, fh, fw, min_area, detect_im, inv_im)
        return not self._detection_is_weak(fh, fw, min_area)

    def _invalidate_fast_path(self) -> None:
        """Force full YOLO cascade on the next frame (camera moved / scene changed)."""
        self._detect_mode = ""
        self._mode_streak = 0
        self._last_fb_box = None

    def _current_det_boxes(self) -> list[list[float]]:
        boxes = getattr(self, "boxes", None)
        if boxes is None:
            return []
        try:
            n = len(boxes)
        except TypeError:
            return []
        out: list[list[float]] = []
        for i in range(n):
            out.append([float(v) for v in boxes[i][:4]])
        return out

    def _scene_shift_detected(self) -> bool:
        """True when plate positions jumped — camera angle/distance changed."""
        prev = getattr(self, "_prev_det_boxes", None) or []
        curr = self._current_det_boxes()
        if not prev:
            return False
        if not curr:
            return True
        scores: list[float] = []
        for pb in prev:
            scores.append(max((_iou_xyxy(pb, cb) for cb in curr), default=0.0))
        avg = sum(scores) / max(len(scores), 1)
        return avg < 0.12

    def _unlock_track_if_shifted(self, track_id: int, box) -> None:
        """Drop OCR lock when the plate box jumped — re-search before reading again."""
        if track_id < 0:
            return
        last_box = self._last_credible_box.get(track_id)
        if last_box is None:
            return
        bx = [float(v) for v in box[:4]]
        if _iou_xyxy(bx, last_box) < 0.20:
            self._ocr_locked[track_id] = False
            self._plate_votes.pop(track_id, None)
            self._last_ocr_text.pop(track_id, None)

    def _try_confirm_plate_lock(
        self,
        track_id: int,
        formatted: str,
        ocr_conf: float,
        im0: np.ndarray,
        box,
    ) -> bool:
        """Lock only after crop + format checks and matching vote consensus."""
        if track_id < 0 or not formatted:
            return False
        if not _is_likely_plate_crop(im0, box):
            return False
        if not sync_eligible_plate(formatted, jurisdiction=self._plate_jurisdiction):
            return False
        min_c = float(getattr(self, "_min_ocr_conf", 0.25))
        if float(ocr_conf) < min_c:
            return False
        key = normalize_plate(format_qatar_plate(formatted))
        votes = self._plate_votes.get(track_id, [])
        matching = [
            (t, c)
            for t, c in votes
            if plates_match(t, formatted) or normalize_plate(format_qatar_plate(t)) == key
        ]
        if float(ocr_conf) >= _PLATE_LOCK_HIGH_CONF and matching:
            return True
        return len(matching) >= _PLATE_LOCK_MIN_VOTES

    def _inherit_dwell_for_plate(self, track_id: int, plate: str, src_frame: int) -> None:
        """Resume dwell after camera move — same plate keeps accumulated time."""
        if track_id < 0 or not plate or plate in ("—", "…"):
            return
        key = normalize_plate(format_qatar_plate(plate))
        anchor = self._plate_dwell_anchor.get(key)
        if anchor is not None:
            stale = (
                self._proc_frame_no - int(anchor.get("updated_proc_frame", 0))
            ) > _PLATE_ANCHOR_TTL_FRAMES
            if not stale:
                first = int(anchor["first_src_frame"])
                self._touch_session(track_id, src_frame)
                cur_first = int(self._sessions[track_id]["first_src_frame"])
                self._sessions[track_id]["first_src_frame"] = min(cur_first, first)
                return
        for other_tid, sess in list(self._sessions.items()):
            if other_tid == track_id:
                continue
            if not self._ocr_locked.get(other_tid) and other_tid not in self._tracks_ever_locked:
                continue
            other = normalize_plate(self._best_plate_for_track(other_tid))
            if other and plates_match(other, key):
                first = int(sess["first_src_frame"])
                self._touch_session(track_id, src_frame)
                cur_first = int(self._sessions[track_id]["first_src_frame"])
                self._sessions[track_id]["first_src_frame"] = min(cur_first, first)
                return

    def _update_plate_dwell_anchor(self, track_id: int) -> None:
        if track_id < 0 or not self._ocr_locked.get(track_id):
            return
        plate = self._best_plate_for_track(track_id)
        if plate in ("—", "…", "") or not sync_eligible_plate(
            plate, jurisdiction=self._plate_jurisdiction
        ):
            return
        sess = self._sessions.get(track_id)
        if not sess:
            return
        key = normalize_plate(format_qatar_plate(plate))
        self._plate_dwell_anchor[key] = {
            "first_src_frame": int(sess["first_src_frame"]),
            "last_src_frame": int(sess["last_src_frame"]),
            "last_tid": track_id,
            "updated_proc_frame": self._proc_frame_no,
        }
        self._fb_track_plates[track_id] = plate

    def _detections_stable_vs_prev(self) -> bool:
        """False when plate boxes jumped — caller should re-run full cascade."""
        prev = getattr(self, "_prev_det_boxes", None) or []
        curr = self._current_det_boxes()
        if not prev or not curr:
            return True
        scores: list[float] = []
        for pb in prev:
            scores.append(max((_iou_xyxy(pb, cb) for cb in curr), default=0.0))
        avg = sum(scores) / max(len(scores), 1)
        return avg >= 0.12

    def _record_speed_sample(self, track_id: int, kmh: float) -> None:
        if track_id < 0 or kmh <= 0:
            return
        self._speed_sum[track_id] = self._speed_sum.get(track_id, 0.0) + float(kmh)
        self._speed_count[track_id] = self._speed_count.get(track_id, 0) + 1

    def _avg_speed_for_track(self, track_id: int) -> int | None:
        n = self._speed_count.get(track_id, 0)
        if n <= 0:
            return None
        return int(round(self._speed_sum[track_id] / n))

    def _track_plate_strength(self, track_id: int) -> float:
        plate = self._best_plate_ever.get(track_id) or self._last_ocr_text.get(track_id, "")
        if not plate or plate in ("—", "…"):
            return 0.0
        return 1.0 + len(normalize_plate(plate)) * 0.02

    @staticmethod
    def _pick_overlap_winners(
        boxes,
        track_ids: list,
        *,
        best_plate_ever: dict | None = None,
        last_ocr_text: dict | None = None,
    ) -> list[int]:
        """Return track IDs to keep after IoU dedupe (testable without YOLO)."""
        n = len(boxes) if boxes is not None else 0
        if n < 2:
            return [int(t) for t in track_ids]

        def strength(tid: int) -> float:
            plate = (best_plate_ever or {}).get(tid) or (last_ocr_text or {}).get(tid, "")
            if not plate or plate in ("—", "…"):
                return 0.0
            return 1.0 + len(normalize_plate(plate)) * 0.02

        keep = [True] * n
        for i in range(n):
            if not keep[i]:
                continue
            for j in range(i + 1, n):
                if not keep[j]:
                    continue
                bi, bj = boxes[i], boxes[j]
                if _iou_xyxy(bi, bj) < 0.2:
                    continue
                ai, aj = _box_area(bi), _box_area(bj)
                pi, pj = _plate_aspect(bi), _plate_aspect(bj)
                ti, tj = int(track_ids[i]), int(track_ids[j])
                score_i = (pi / max(ai, 1.0)) + strength(ti) * 5.0
                score_j = (pj / max(aj, 1.0)) + strength(tj) * 5.0
                if score_i >= score_j:
                    keep[j] = False
                else:
                    keep[i] = False
                    break
        return [int(track_ids[i]) for i, k in enumerate(keep) if k]

    def _filter_overlapping_detections(self) -> None:
        """Keep one box per plate — drop wide duplicate boxes (same car, two track IDs)."""
        n = len(self.boxes) if self.boxes is not None else 0
        if n < 2:
            return
        kept_tids = self._pick_overlap_winners(
            self.boxes,
            list(self.track_ids),
            best_plate_ever=self._best_plate_ever,
            last_ocr_text=self._last_ocr_text,
        )
        kept_set = set(kept_tids)
        idx = [i for i, t in enumerate(self.track_ids) if int(t) in kept_set]
        if len(idx) == n:
            return
        self.boxes = self.boxes[idx]
        self.track_ids = [self.track_ids[i] for i in idx]
        self.clss = [self.clss[i] for i in idx]

    # ── Properties delegated to inner instance ────────────────────────────────
    @property
    def track_history(self):
        return self._inst.track_history

    @property
    def line_width(self):
        return self._inst.line_width

    @property
    def names(self):
        return self._inst.names

    # ── DB ─────────────────────────────────────────────────────────────────────

    def _connect_to_db(self):
        try:
            import mysql.connector
            connection = mysql.connector.connect(
                host=MYSQL_HOST, user=MYSQL_USER, password=MYSQL_PASSWORD
            )
            cursor = connection.cursor()
            cursor.execute(f"CREATE DATABASE IF NOT EXISTS `{DB_NAME}`")
            cursor.execute(f"USE `{DB_NAME}`")
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS my_data (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    date DATE, time TIME, track_id INT,
                    class_name VARCHAR(255), speed FLOAT, numberplate TEXT
                )
            """)
            connection.commit()
            self._db_backend = "mysql"
            return connection
        except Exception:
            conn = sqlite3.connect(str(SQLITE_PATH))
            conn.execute("""
                CREATE TABLE IF NOT EXISTS my_data (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    date TEXT, time TEXT, track_id INTEGER,
                    class_name TEXT, speed REAL, numberplate TEXT
                )
            """)
            conn.commit()
            self._db_backend = "sqlite"
            return conn

    def save_to_database(self, date, time_str, track_id, class_name, speed, numberplate):
        try:
            cursor = self.db_connection.cursor()
            if self._db_backend == "mysql":
                cursor.execute(
                    "INSERT INTO my_data (date,time,track_id,class_name,speed,numberplate) VALUES (%s,%s,%s,%s,%s,%s)",
                    (date, time_str, track_id, class_name, speed, numberplate),
                )
            else:
                cursor.execute(
                    "INSERT INTO my_data (date,time,track_id,class_name,speed,numberplate) VALUES (?,?,?,?,?,?)",
                    (date, time_str, track_id, class_name, speed, numberplate),
                )
            self.db_connection.commit()
        except Exception:
            pass

    # ── Track helpers ──────────────────────────────────────────────────────────

    def extract_tracks(self, im0: np.ndarray) -> None:
        # CRITICAL: clear the Solutions result holder before each call. When the
        # internal tracker finds nothing (or errors out), ultralytics can leave
        # `.tracks` holding the LAST successful result — the raw-box salvage
        # below would then re-feed a frozen, minutes-old box every frame (green
        # square stuck at the car's previous position after the camera moves).
        try:
            self._inst.tracks = None
        except Exception:
            pass
        self._inst.extract_tracks(im0)
        self.boxes = self._inst.boxes
        self.track_ids = self._inst.track_ids or []
        self.clss = self._inst.clss or []
        self.tracks = getattr(self._inst, "tracks", None)

        if self.track_ids:
            self._raw_repeat = None
            return
        if self.tracks is None:
            return
        boxes_obj = getattr(self.tracks, "boxes", None)
        if boxes_obj is None or len(boxes_obj) == 0:
            return
        xyxy = boxes_obj.xyxy.cpu()
        # Reject pixel-identical repeats: a genuine detection jitters at least
        # ±1px between frames; an exact repeat means a cached/stale result.
        sig = tuple(round(float(v), 1) for v in xyxy[0][:4])
        prev_sig, reps = getattr(self, "_raw_repeat", None) or (None, 0)
        if sig == prev_sig:
            reps += 1
            self._raw_repeat = (sig, reps)
            if reps >= 2:
                return
        else:
            self._raw_repeat = (sig, 0)
        self.boxes = xyxy
        self.clss = boxes_obj.cls.int().cpu().tolist()
        self.track_ids = [-(i + 1) for i in range(len(self.clss))]

    def _filter_tiny_boxes(self, frame_h: int, frame_w: int, *, salvage: bool = False) -> None:
        """Drop UI fragments / phone-screen noise — real plates are wide and large enough."""
        n = len(self.boxes) if self.boxes is not None else 0
        if n == 0:
            return
        low_res = bool(getattr(self, "_live_low_res", False))
        min_area = _min_plate_area_for_frame(frame_h, frame_w, low_res=low_res)
        min_w = _min_plate_width_for_frame(frame_w, low_res=low_res)
        min_h = _min_plate_height_for_frame(frame_h, low_res=low_res)
        keep_idx: list[int] = []
        for i in range(n):
            box = self.boxes[i]
            x1, y1, x2, y2 = map(float, box)
            bw, bh = max(0.0, x2 - x1), max(0.0, y2 - y1)
            if (
                bw * bh >= min_area
                and bw >= min_w
                and bh >= min_h
                and _is_plate_shaped_box(box)
            ):
                keep_idx.append(i)
        if not keep_idx and salvage and n > 0:
            # Live close-up / edge-cropped plates: keep the best plate-shaped box rather
            # than returning zero detections (the #1 cause of "video works, live doesn't").
            best = max(range(n), key=lambda i: _box_area(self.boxes[i]))
            if _is_plate_shaped_box(self.boxes[best]):
                keep_idx = [best]
        if len(keep_idx) == n:
            return
        if not keep_idx:
            self.boxes = []
            self.track_ids = []
            self.clss = []
            return
        try:
            import torch
            if isinstance(self.boxes, torch.Tensor):
                idx = torch.tensor(keep_idx, dtype=torch.long)
                self.boxes = self.boxes[idx]
            else:
                self.boxes = self.boxes[keep_idx]
        except Exception:
            self.boxes = np.array([self.boxes[i] for i in keep_idx])
        self.track_ids = [self.track_ids[i] for i in keep_idx]
        self.clss = [self.clss[i] for i in keep_idx]

    def _largest_box_area(self) -> float:
        boxes = getattr(self, "boxes", None)
        if boxes is None or len(boxes) == 0:
            return 0.0
        return max(_box_area(boxes[i]) for i in range(len(boxes)))

    def _detection_is_weak(self, fh: int, fw: int, min_area: float) -> bool:
        """True when YOLO found nothing useful — keep searching (direct YOLO, etc.)."""
        boxes = getattr(self, "boxes", None)
        if boxes is None or len(boxes) == 0:
            return True
        area = self._largest_box_area()
        if area < min_area:
            return True
        low_res = bool(getattr(self, "_live_low_res", False))
        # HD close-up: sub-2500 px² hits are usually UI specks, not the main plate.
        if not low_res and area < 2500:
            return True
        return False

    def _clear_detections(self) -> None:
        self.boxes = []
        self.track_ids = []
        self.clss = []

    def _normalize_detection_state(self) -> None:
        """Ensure boxes/track_ids/clss are always aligned and safe to iterate."""
        if self.boxes is None:
            self.boxes = []
            self.track_ids = []
            self.clss = []
            return
        try:
            n = len(self.boxes)
        except TypeError:
            self.boxes = []
            self.track_ids = []
            self.clss = []
            return
        if n == 0:
            self.boxes = []
            self.track_ids = []
            self.clss = []
            return
        tids = list(self.track_ids) if self.track_ids is not None else []
        clss = list(self.clss) if self.clss is not None else []
        if len(tids) < n:
            tids.extend(-(i + 1) for i in range(len(tids), n))
        elif len(tids) > n:
            tids = tids[:n]
        if len(clss) < n:
            clss.extend([0] * (n - len(clss)))
        elif len(clss) > n:
            clss = clss[:n]
        self.track_ids = tids
        self.clss = clss

    def _get_direct_yolo(self):
        """Dedicated YOLO instance for fallback passes.

        NEVER reuse self._inst.model: after .track() it keeps BoT-SORT's
        postprocess callback attached, which silently swallows low-confidence
        detections (below track_high_thresh ≈ 0.5) from .predict() calls too.
        """
        cached = getattr(self, "_direct_yolo_model", None)
        if cached is not None:
            return cached
        try:
            from ultralytics import YOLO

            model_path = (getattr(self._inst, "CFG", {}) or {}).get("model")
            if not model_path:
                return None
            self._direct_yolo_model = YOLO(str(model_path))
            return self._direct_yolo_model
        except Exception:
            return None

    def _fallback_track_id(self, box) -> int:
        """Stable POSITIVE synthetic track id for fallback detections.

        BoT-SORT refuses to confirm low-conf detections (new_track_thresh ≈ 0.6),
        and the registry/session pipeline ignores negative ids — so fallback
        detections used to draw nothing and register nothing. IoU-match against
        recent fallback boxes to keep one id per physical plate across frames.
        """
        tracks: dict[int, tuple[list[float], int]] = getattr(self, "_fb_tracks", {})
        now = int(getattr(self, "_proc_frame_no", 0))
        bx = [float(v) for v in box[:4]]
        best_id, best_iou = None, 0.0
        for fid, (fbox, last_seen) in list(tracks.items()):
            if now - last_seen > 120:
                tracks.pop(fid, None)
                continue
            iou = _iou_xyxy(bx, fbox)
            if iou > best_iou:
                best_iou, best_id = iou, fid
        # Re-use track id during plate re-acquire after camera move (IoU may be low).
        if best_id is None or best_iou < 0.2:
            ever = getattr(self, "_tracks_ever_locked", set())
            for fid, (fbox, last_seen) in list(tracks.items()):
                if fid not in ever:
                    continue
                if now - last_seen > 90:
                    continue
                best_id = fid
                best_iou = 0.21
                break
        if best_id is None or best_iou < 0.2:
            best_id = int(getattr(self, "_fb_next_id", 50000))
            self._fb_next_id = best_id + 1
        tracks[best_id] = (bx, now)
        self._fb_tracks = tracks
        return best_id

    def _set_fallback_detections(self, boxes_xyxy, clss) -> None:
        import torch

        # Torch tensor, not numpy — ultralytics store_tracking_history calls .numel().
        self.boxes = torch.tensor(
            [[float(v) for v in b[:4]] for b in boxes_xyxy], dtype=torch.float32
        )
        self.clss = [int(c) for c in clss]
        self.track_ids = [self._fallback_track_id(b) for b in boxes_xyxy]
        if boxes_xyxy:
            self._last_fb_box = [float(v) for v in boxes_xyxy[0][:4]]

    def _best_plate_in_pred(
        self, pred, ox: float, oy: float, fw: int, fh: int
    ) -> tuple[float, list[float], int] | None:
        """Best plate-shaped box from a YOLO result, mapped by a crop offset."""
        all_plates = self._plates_in_pred(pred, ox, oy, fw, fh)
        if not all_plates:
            return None
        return max(all_plates, key=lambda c: c[0])

    def _plates_in_pred(
        self, pred, ox: float, oy: float, fw: int, fh: int
    ) -> list[tuple[float, list[float], int]]:
        """All plate-shaped boxes from a YOLO result, mapped by a crop offset."""
        d0 = pred[0]
        if d0.boxes is None or len(d0.boxes) == 0:
            return []
        out: list[tuple[float, list[float], int]] = []
        for i in range(len(d0.boxes)):
            bx1, by1, bx2, by2 = d0.boxes.xyxy[i].cpu().tolist()
            conf = float(d0.boxes.conf[i].item())
            mapped = [
                max(0.0, min(fw - 2.0, bx1 + ox)),
                max(0.0, min(fh - 2.0, by1 + oy)),
                max(2.0, min(float(fw), bx2 + ox)),
                max(2.0, min(float(fh), by2 + oy)),
            ]
            if not _is_plate_shaped_box(mapped):
                continue
            out.append((conf, mapped, int(d0.boxes.cls[i].item())))
        return out

    @staticmethod
    def _merge_plate_candidates(
        cands: list[tuple[float, list[float], int]],
        *,
        iou_thresh: float = 0.35,
    ) -> list[tuple[float, list[float], int]]:
        """IoU-dedupe plate hits — keep highest-confidence box per physical plate."""
        ranked = sorted(cands, key=lambda c: c[0], reverse=True)
        kept: list[tuple[float, list[float], int]] = []
        for cand in ranked:
            if any(_iou_xyxy(cand[1], k[1]) >= iou_thresh for k in kept):
                continue
            kept.append(cand)
        return kept

    def _direct_yolo_batch(
        self, frames: list[np.ndarray]
    ) -> list[tuple[float, list[float], int]]:
        """One GPU batch over plain + CLAHE + inverted — faster than 3 serial passes."""
        if not frames:
            return []
        try:
            yolo = self._get_direct_yolo()
            if yolo is None:
                return []
            base_conf = float(getattr(self._inst, "conf", 0.16) or 0.16)
            yolo_conf = max(0.05, base_conf - 0.12)
            preds = yolo.predict(
                frames, conf=yolo_conf, iou=0.55, imgsz=640, verbose=False
            )
            pool: list[tuple[float, list[float], int]] = []
            for pred, im in zip(preds, frames):
                fh, fw = im.shape[:2]
                pool.extend(self._plates_in_pred(pred, 0.0, 0.0, fw, fh))
            return self._merge_plate_candidates(pool)
        except Exception:
            pool: list[tuple[float, list[float], int]] = []
            for im in frames:
                pool.extend(self._direct_yolo_all_plates(im))
            return self._merge_plate_candidates(pool)

    def _direct_yolo_all_plates(self, im0: np.ndarray) -> list[tuple[float, list[float], int]]:
        """All plate-shaped boxes from a raw YOLO pass on one frame variant."""
        try:
            yolo = self._get_direct_yolo()
            if yolo is None:
                return []
            fh, fw = im0.shape[:2]
            base_conf = float(getattr(self._inst, "conf", 0.16) or 0.16)
            yolo_conf = max(0.05, base_conf - 0.12)
            pred = yolo.predict(im0, conf=yolo_conf, iou=0.55, imgsz=640, verbose=False)
            return self._plates_in_pred(pred, 0.0, 0.0, fw, fh)
        except Exception:
            return []

    def _direct_yolo_candidate(self, im0: np.ndarray) -> tuple[float, list[float], int] | None:
        """Best plate-shaped box from a raw YOLO pass — (conf, box, cls) or None."""
        plates = self._direct_yolo_all_plates(im0)
        if not plates:
            return None
        return max(plates, key=lambda c: _box_area(c[1]))

    def _zoom_out_candidate(self, im0: np.ndarray) -> tuple[float, list[float], int] | None:
        """Detect close-up plates that fill the frame (bumper-level cameras).

        The plate detector was trained on distant traffic footage, so a plate
        spanning ~25%+ of the frame is invisible to it at any imgsz. Shrink the
        frame inside a fixed-size canvas so the plate matches training scale,
        then map the detection back to full-frame coordinates (OCR still crops
        from the full-resolution frame, so plate text quality is unaffected).
        """
        try:
            yolo = self._get_direct_yolo()
            if yolo is None:
                return None
            fh, fw = im0.shape[:2]
            best: tuple[float, list[float], int] | None = None
            for scale in (0.25, 0.33):
                sw, sh = max(64, int(fw * scale)), max(64, int(fh * scale))
                small = cv2.resize(im0, (sw, sh), interpolation=cv2.INTER_AREA)
                canvas = np.full((fh, fw, 3), 114, dtype=np.uint8)
                x0, y0 = (fw - sw) // 2, (fh - sh) // 2
                canvas[y0:y0 + sh, x0:x0 + sw] = small
                pred = yolo.predict(canvas, conf=0.05, iou=0.55, imgsz=640, verbose=False)
                d0 = pred[0]
                if d0.boxes is None or len(d0.boxes) == 0:
                    continue
                for i in range(len(d0.boxes)):
                    bx1, by1, bx2, by2 = d0.boxes.xyxy[i].cpu().tolist()
                    conf = float(d0.boxes.conf[i].item())
                    mapped = [
                        max(0.0, min(fw - 2.0, (bx1 - x0) / scale)),
                        max(0.0, min(fh - 2.0, (by1 - y0) / scale)),
                        max(2.0, min(float(fw), (bx2 - x0) / scale)),
                        max(2.0, min(float(fh), (by2 - y0) / scale)),
                    ]
                    # Zoom-out exists ONLY for bumper-level close-ups: the mapped
                    # plate must span a large chunk of the frame. Small mapped
                    # boxes here are low-conf texture (road, shadows) — accepting
                    # them used to freeze detection when the camera was moved
                    # back, drawing a green box in the wrong place.
                    if (mapped[2] - mapped[0]) < 0.10 * fw:
                        continue
                    if not _is_plate_shaped_box(mapped):
                        continue
                    if best is None or conf > best[0]:
                        best = (conf, mapped, int(d0.boxes.cls[i].item()))
                if best is not None and best[0] >= 0.15:
                    break
            return best
        except Exception:
            return None

    def _zoom_out_yolo_plates(self, im0: np.ndarray, *, min_conf: float = 0.0) -> bool:
        cand = self._zoom_out_candidate(im0)
        if cand is None or cand[0] < min_conf:
            return False
        self._set_fallback_detections([cand[1]], [cand[2]])
        return True

    def _tiled_yolo_all_plates(self, im0: np.ndarray) -> list[tuple[float, list[float], int]]:
        """Far / small plates: tiled zoom-in — returns ALL merged plate hits."""
        try:
            yolo = self._get_direct_yolo()
            if yolo is None:
                return []
            fh, fw = im0.shape[:2]
            if fw < 320 or fh < 180:
                return []
            tw = max(320, int(fw * 0.55))
            step = max(64, int(tw * 0.42))
            origins: list[int] = []
            ox = 0
            while ox < fw:
                origins.append(min(ox, max(0, fw - tw)))
                if ox + tw >= fw:
                    break
                ox += step
            if max(origins, default=0) < max(0, fw - tw):
                origins.append(max(0, fw - tw))
            pool: list[tuple[float, list[float], int]] = []
            seen: set[int] = set()
            for ox in origins:
                if ox in seen:
                    continue
                seen.add(ox)
                tile = im0[:, ox:ox + tw]
                pred = yolo.predict(tile, conf=0.06, iou=0.55, imgsz=640, verbose=False)
                pool.extend(self._plates_in_pred(pred, float(ox), 0.0, fw, fh))
            return self._merge_plate_candidates(pool)
        except Exception:
            return []

    def _tiled_yolo_candidate(self, im0: np.ndarray) -> tuple[float, list[float], int] | None:
        """Best plate from tiled pass (single-plate fast path)."""
        plates = self._tiled_yolo_all_plates(im0)
        if not plates:
            return None
        return max(plates, key=lambda c: c[0])

    def _roi_plates_around_box(
        self, im0: np.ndarray, box: list[float]
    ) -> list[tuple[float, list[float], int]]:
        """YOLO on a padded ROI centred on one plate — used for multi-car re-track."""
        try:
            yolo = self._get_direct_yolo()
            if yolo is None:
                return []
            fh, fw = im0.shape[:2]
            x1, y1, x2, y2 = box
            bw, bh = max(8.0, x2 - x1), max(4.0, y2 - y1)
            cx, cy = (x1 + x2) / 2.0, (y1 + y2) / 2.0
            rw = max(bw * 5.0, fw * 0.35)
            rh = max(bh * 8.0, fh * 0.35)
            rx1 = int(max(0, cx - rw / 2.0))
            ry1 = int(max(0, cy - rh / 2.0))
            rx2 = int(min(fw, cx + rw / 2.0))
            ry2 = int(min(fh, cy + rh / 2.0))
            if rx2 - rx1 < 96 or ry2 - ry1 < 64:
                return []
            crop = im0[ry1:ry2, rx1:rx2]
            pred = yolo.predict(crop, conf=0.06, iou=0.55, imgsz=640, verbose=False)
            return self._plates_in_pred(pred, float(rx1), float(ry1), fw, fh)
        except Exception:
            return []

    def _roi_all_plates(self, im0: np.ndarray) -> list[tuple[float, list[float], int]]:
        """Re-detect every known fallback plate in parallel ROIs (multi-car live)."""
        tracks: dict[int, tuple[list[float], int]] = getattr(self, "_fb_tracks", {})
        if not tracks:
            box = getattr(self, "_last_fb_box", None)
            if box is None:
                return []
            return self._roi_plates_around_box(im0, box)
        if len(tracks) == 1:
            fbox = next(iter(tracks.values()))[0]
            return self._roi_plates_around_box(im0, fbox)
        pool: list[tuple[float, list[float], int]] = []
        workers = min(4, len(tracks))
        with ThreadPoolExecutor(max_workers=workers) as pool_ex:
            futs = [
                pool_ex.submit(self._roi_plates_around_box, im0, fbox)
                for fbox, _last_seen in tracks.values()
            ]
            for fut in as_completed(futs):
                try:
                    pool.extend(fut.result())
                except Exception:
                    pass
        return self._merge_plate_candidates(pool)

    def _roi_yolo_candidate(self, im0: np.ndarray) -> tuple[float, list[float], int] | None:
        """Cheap re-detection around the last fallback box (one crop, one pass)."""
        plates = self._roi_all_plates(im0)
        if not plates:
            return None
        return max(plates, key=lambda c: c[0])

    def _extract_tracks_adaptive(self, im0: np.ndarray) -> None:
        """
        Detection cascade: Solutions tracker (plain → enhanced → inverted), then
        direct YOLO, then zoom-out (close-up plates). Remembers which mode hit
        last frame and tries it first — keeps per-frame CPU bounded on live feeds.
        """
        fh, fw = im0.shape[:2]
        low_res = bool(getattr(self, "_live_low_res", False))
        min_area = _min_plate_area_for_frame(fh, fw, low_res=low_res)

        self._on_scene_activity(im0)
        force_global = int(getattr(self, "_force_global_search", 0)) > 0
        if force_global:
            self._force_global_search -= 1

        mode = getattr(self, "_detect_mode", "")
        streak = int(getattr(self, "_mode_streak", 0))
        searching = not self._any_ocr_locked()
        # Escape hatch: force full cascade while searching or on a timer.
        force_full = bool(mode) and (streak >= (3 if searching else 6) or force_global)
        if force_full:
            self._mode_streak = 0
            mode = ""

        detect_im = _enhance_frame_for_detection(im0, low_res=low_res)
        inv_im = _enhance_inverted_for_detection(im0)

        # Turbo only after a confirmed camera move — not every frame while searching.
        if force_global:
            self._live_searching = True
            if self._turbo_global_rescan(im0, fh, fw, min_area, detect_im, inv_im):
                self._promote_or_clear_unconfirmed(im0)
                self._normalize_detection_state()
                self._debug_log_detections(fh, fw)
                return
        elif not self._any_ocr_locked():
            self._live_searching = True
        else:
            self._live_searching = False

        def _finish_fast_path() -> bool:
            """Return True when fast-path hits are stable; else fall through to full cascade."""
            self._filter_tiny_boxes(fh, fw, salvage=(mode == "zoom"))
            if self._detection_is_weak(fh, fw, min_area):
                return False
            self._reject_untrustworthy_detections(im0, strict=False)
            if self._detection_is_weak(fh, fw, min_area):
                return False
            if force_global or int(getattr(self, "_force_global_search", 0)) > 0:
                return False
            if not self._detections_stable_vs_prev():
                self._invalidate_fast_path()
                for tid in list(self._ocr_locked.keys()):
                    self._ocr_locked[tid] = False
                self._clear_detections()
                return False
            self._mode_streak = streak + 1
            self._normalize_detection_state()
            return True

        # ROI fast paths only after OCR has locked — otherwise search the full frame.
        allow_roi = self._any_ocr_locked() and not force_global

        # Fast path: close-up via zoom-out (only when plate already confirmed).
        if mode == "zoom" and not force_full and allow_roi:
            if self._zoom_out_yolo_plates(im0, min_conf=0.18):
                if _finish_fast_path():
                    return
            self._last_fb_box = None
            self._clear_detections()
            self._detect_mode = ""
        # Fast path: far/small or multi-car — ROI re-track only when OCR locked.
        elif mode in ("tile", "multi") and not force_full and allow_roi:
            plates = self._roi_all_plates(im0)
            if not plates and streak % 3 == 0:
                plates = self._tiled_yolo_all_plates(im0)
            if plates:
                self._set_fallback_detections([p[1] for p in plates], [p[2] for p in plates])
                if _finish_fast_path():
                    return
            self._last_fb_box = None
            self._clear_detections()
            self._detect_mode = ""

        # HD close-up: CLAHE can erase weak plate edges — try plain frame first.
        if not low_res:
            self.extract_tracks(im0)
            self._filter_tiny_boxes(fh, fw, salvage=True)
            self._reject_untrustworthy_detections(im0, strict=False)
            if self._detection_is_weak(fh, fw, min_area):
                self._clear_detections()

        if self._detection_is_weak(fh, fw, min_area):
            self.extract_tracks(detect_im)
            self._filter_tiny_boxes(fh, fw, salvage=True)
            self._reject_untrustworthy_detections(im0, strict=False)
            if self._detection_is_weak(fh, fw, min_area):
                self._clear_detections()

        if self._detection_is_weak(fh, fw, min_area):
            self.extract_tracks(inv_im)
            self._filter_tiny_boxes(fh, fw, salvage=True)
            self._reject_untrustworthy_detections(im0, strict=False)
            if self._detection_is_weak(fh, fw, min_area):
                self._clear_detections()

        if self._detection_is_weak(fh, fw, min_area):
            self._clear_detections()
            pool = self._direct_yolo_batch([im0, detect_im, inv_im])
            pool.sort(key=lambda p: _score_plate_candidate(im0, p[0], p[1]), reverse=True)
            preferred = [p for p in pool if _crop_prefers_detection(im0, p[1])]
            if preferred:
                pool = preferred
            # Close-up bumper view: zoom-out may find the plate when direct missed.
            zoom = self._zoom_out_candidate(im0)
            from_zoom = False
            if zoom is not None:
                if not pool or _box_area(zoom[1]) > 1.3 * max(_box_area(p[1]) for p in pool):
                    pool = self._merge_plate_candidates([zoom])
                    from_zoom = True
                else:
                    pool = self._merge_plate_candidates(pool + [zoom])
            if pool:
                self._set_fallback_detections([p[1] for p in pool], [p[2] for p in pool])
                self._filter_tiny_boxes(fh, fw, salvage=True)
                if self._detection_is_weak(fh, fw, min_area):
                    self._last_fb_box = None
                    self._detect_mode = ""
                    self._clear_detections()
                elif from_zoom and len(pool) == 1:
                    self._detect_mode = "zoom"
                    self._mode_streak = 0
                elif len(pool) > 1:
                    self._detect_mode = "multi"
                    self._mode_streak = 0
                elif len(pool) == 1:
                    self._detect_mode = "tile"
                    self._mode_streak = 0

        # Last resort — far / small plates (camera pulled back): tiled zoom-in.
        if self._detection_is_weak(fh, fw, min_area):
            self._clear_detections()
            plates = self._tiled_yolo_all_plates(im0)
            preferred = [p for p in plates if _crop_prefers_detection(im0, p[1])]
            if preferred:
                plates = preferred
            if plates:
                self._set_fallback_detections([p[1] for p in plates], [p[2] for p in plates])
                self._filter_tiny_boxes(fh, fw, salvage=True)
                if self._detection_is_weak(fh, fw, min_area):
                    self._clear_detections()
                else:
                    self._detect_mode = "multi" if len(plates) > 1 else "tile"
                    self._mode_streak = 0

        # Still untrustworthy or only negative-id salvage → full rescan.
        self._promote_or_clear_unconfirmed(im0)
        if self._detection_is_weak(fh, fw, min_area) or (
            int(getattr(self, "_force_global_search", 0)) > 0 and searching
        ):
            self._global_rescan_plates(im0, fh, fw, min_area, detect_im, inv_im)

        self._normalize_detection_state()
        self._debug_log_detections(fh, fw)

    def _debug_log_detections(self, fh: int, fw: int) -> None:
        """Rate-limited trace of what the cascade produced (live debugging aid)."""
        try:
            n = len(self.boxes) if self.boxes is not None else 0
            tick = getattr(self, "_det_dbg_tick", 0) + 1
            self._det_dbg_tick = tick
            had = getattr(self, "_det_dbg_had", None)
            transition = had is not None and bool(n) != had
            self._det_dbg_had = bool(n)
            if not transition and tick % 50 != 0:
                return
            boxes = [[int(float(v)) for v in self.boxes[i][:4]] for i in range(min(n, 3))]
            _log.info(
                "DET frame=%s mode='%s' n=%d tids=%s boxes=%s (%dx%d)",
                getattr(self, "_source_frame_idx", "?"),
                getattr(self, "_detect_mode", ""),
                n,
                list(self.track_ids)[:3],
                boxes,
                fw,
                fh,
            )
        except Exception:
            pass

    def _preprocess_crop(self, crop: np.ndarray) -> np.ndarray:
        """Grayscale + CLAHE + unsharp mask — sharpens letter edges for OCR."""
        if not self._ocr_preprocess:
            return crop
        if crop.ndim == 3 and crop.shape[2] >= 3:
            gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        else:
            gray = crop if crop.ndim == 2 else cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        # Black plates with light characters — invert so OCR sees a light background.
        if _is_dark_plate_crop(crop):
            gray = 255 - gray
        clip = 3.2 if _is_dark_plate_crop(crop) else 2.0
        clahe = cv2.createCLAHE(clipLimit=clip, tileGridSize=(8, 8))
        enhanced = clahe.apply(gray)
        blur = cv2.GaussianBlur(enhanced, (0, 0), sigmaX=1.0)
        sharp = cv2.addWeighted(enhanced, 1.6, blur, -0.6, 0)
        return cv2.cvtColor(sharp, cv2.COLOR_GRAY2BGR)

    def _read_easyocr(self, crop: np.ndarray, allowlist: str, *, beam: bool = False) -> tuple[str, float]:
        decoder = "beamsearch" if beam else "greedy"
        for fn in [
            lambda c: self.reader.readtext(
                c, allowlist=allowlist, paragraph=False, detail=0, decoder=decoder,
            ),
            lambda c: self.reader.readtext(c, allowlist=allowlist, paragraph=False, detail=0),
            lambda c: self.reader.readtext(c, allowlist=allowlist, paragraph=False),
        ]:
            try:
                with self._ocr_call_lock:
                    results = fn(crop)
                break
            except Exception:
                results = []
                continue
        else:
            return "", 0.0

        texts, probs = [], []
        for item in results:
            if isinstance(item, str):
                s = item.strip()
                if s:
                    texts.append(s)
                    probs.append(0.55)
                continue
            if len(item) >= 2:
                texts.append(str(item[1]))
                if len(item) >= 3:
                    try:
                        probs.append(float(item[2]))
                    except (TypeError, ValueError):
                        probs.append(0.5)
        raw = "".join(texts).strip()
        conf = sum(probs) / max(len(probs), 1) if probs else (0.55 if raw else 0.0)
        return raw, float(conf)

    def _upscale_crop(self, crop: np.ndarray, h: int, w: int) -> np.ndarray:
        if h < 64 or w < 200:
            scale = max(64 / h, 200 / w, 2.5)
            nh, nw = max(1, int(h * scale)), max(1, int(w * scale))
            return cv2.resize(crop, (nw, nh), interpolation=cv2.INTER_CUBIC)
        if _is_dark_plate_crop(crop) and (h < 96 or w < 320):
            scale = max(96 / h, 320 / w, 1.8)
            nh, nw = max(1, int(h * scale)), max(1, int(w * scale))
            return cv2.resize(crop, (nw, nh), interpolation=cv2.INTER_CUBIC)
        return crop

    def _perform_ocr_digits_only(self, image_array: np.ndarray) -> tuple[str, float]:
        """Digits-only read for black commercial plates (e.g. 259559)."""
        best_out, best_conf = "", 0.0
        if self.reader is not None:
            h, w = image_array.shape[:2]
            crop = self._upscale_crop(self._preprocess_crop(image_array), h, w)
            raw, conf = self._read_easyocr(crop, _DIGIT_ALLOWLIST, beam=True)
            digits = re.sub(r"\D", "", raw or "")
            if len(digits) >= 4:
                formatted = format_qatar_plate(digits)
                if formatted and accept_plate_read(
                    formatted,
                    jurisdiction=self._plate_jurisdiction,
                    strict=False,
                ):
                    return formatted, float(conf)
        if self._fast_reader is not None:
            h, w = image_array.shape[:2]
            base = self._upscale_crop(image_array, h, w)
            for variant in self._ocr_crop_variants(base):
                for img in (variant, self._preprocess_crop(variant)):
                    raw, conf = self._perform_ocr_fast(img)
                    digits = re.sub(r"\D", "", format_qatar_plate(raw))
                    if len(digits) >= 4:
                        formatted = format_qatar_plate(digits)
                        if formatted and accept_plate_read(
                            formatted,
                            jurisdiction=self._plate_jurisdiction,
                            strict=False,
                        ) and float(conf) >= best_conf:
                            best_out, best_conf = formatted, float(conf)
        return best_out, best_conf

    @staticmethod
    def _parse_fast_plate_result(res) -> tuple[str, float]:
        """Robustly extract (text, confidence) from fast-plate-ocr output."""
        texts, confs = res, None
        if isinstance(res, tuple) and len(res) == 2:
            texts, confs = res
        item = texts[0] if isinstance(texts, (list, tuple)) and texts else texts

        conf_src = None
        if hasattr(item, "plate"):
            raw = getattr(item, "plate", "") or ""
            for attr in ("char_probs", "plate_prob", "confidence"):
                conf_src = getattr(item, attr, None)
                if conf_src is not None:
                    break
        elif isinstance(item, str):
            raw = item
        else:
            raw = str(item) if item is not None else ""

        conf_val = 0.0
        for candidate in (conf_src, confs):
            if candidate is None:
                continue
            try:
                arr = np.asarray(candidate, dtype=float)
                if arr.size:
                    conf_val = float(arr.mean())
                    break
            except (TypeError, ValueError):
                continue

        cleaned = "".join(ch for ch in str(raw).upper() if ch.isalnum())
        if not cleaned:
            return "", 0.0
        if conf_val <= 0.0:
            conf_val = 0.6
        return cleaned, conf_val

    def _perform_ocr_fast(self, image_array) -> tuple[str, float]:
        # fast-plate-ocr global models are RGB; OpenCV crops are BGR. Convert and
        # let the recognizer resize internally to its configured input size.
        img = image_array
        if img.ndim == 2:
            img = cv2.cvtColor(img, cv2.COLOR_GRAY2RGB)
        elif img.ndim == 3 and img.shape[2] >= 3:
            img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        try:
            with self._ocr_call_lock:
                res = self._fast_reader.run(img, return_confidence=True)
        except TypeError:
            try:
                with self._ocr_call_lock:
                    res = self._fast_reader.run(img)
            except Exception:
                return "", 0.0
        except Exception:
            return "", 0.0
        return self._parse_fast_plate_result(res)

    def _perform_ocr_easyocr(self, image_array) -> tuple[str, float]:
        h, w = image_array.shape[:2]
        crop = self._upscale_crop(self._preprocess_crop(image_array), h, w)
        ww = crop.shape[1]

        # Split read: digits (left) + letters (right) — letters fail less often.
        split_at = max(1, int(ww * 0.58))
        left = crop[:, :split_at]
        right = crop[:, split_at:]
        digits, dc = self._read_easyocr(left, _DIGIT_ALLOWLIST)
        letters, lc = self._read_easyocr(right, _LETTER_ALLOWLIST, beam=True)
        split_text = format_qatar_plate(f"{digits} {letters}")
        split_conf = (dc + lc) / 2.0 if digits and letters else max(dc, lc)

        # Full-frame fallback
        full_raw, fc = self._read_easyocr(crop, _PLATE_ALLOWLIST)
        full_text = format_qatar_plate(full_raw)

        if len(format_qatar_plate(split_text).replace(" ", "")) >= 5 and split_conf >= 0.2:
            return split_text, split_conf
        if full_text:
            return full_text, fc
        return split_text, split_conf

    def _finalize_ocr_result(self, out: str, conf: float) -> tuple[str, float]:
        if not out:
            return "", 0.0
        if not accept_plate_read(
            out,
            jurisdiction=self._plate_jurisdiction,
            strict=self._plate_strict,
        ):
            if self._plate_strict:
                return "", 0.0
            return out, float(conf) * 0.35
        return out, float(conf)

    def _ocr_stride_for_track(self, track_id: int) -> int:
        """Read every frame when uncertain; throttle when plate is stable."""
        if track_id < 0:
            return 1
        if not getattr(self, "_ocr_locked", {}).get(track_id):
            return 1
        votes = self._plate_votes.get(track_id, [])
        if not votes:
            return 1
        plate_key = normalize_plate(self._best_plate_for_track(track_id))
        top_conf = max(c for _, c in votes)
        min_c = float(getattr(self, "_min_ocr_conf", 0.25))
        if len(plate_key) >= 6 and top_conf >= min_c:
            return max(self._ocr_interval, 3)
        if len(plate_key) < 5 or top_conf < min_c * 0.85:
            return 1
        return self._ocr_interval

    def _ocr_crop_variants(self, image_array: np.ndarray) -> list[np.ndarray]:
        variants = [image_array]
        if _is_dark_plate_crop(image_array):
            variants.append(cv2.bitwise_not(image_array))
        return variants

    def perform_ocr(self, image_array) -> tuple[str, float]:
        if image_array is None or not isinstance(image_array, np.ndarray):
            return "", 0.0
        if image_array.size == 0 or image_array.ndim < 2:
            return "", 0.0
        h, w = image_array.shape[:2]
        if h < 10 or w < 10:
            return "", 0.0

        base = self._upscale_crop(image_array, h, w)
        best_out, best_conf = "", 0.0
        for variant in self._ocr_crop_variants(base):
            if self._fast_reader is not None:
                imgs = [variant]
                if self._ocr_preprocess:
                    imgs.append(self._preprocess_crop(variant))
                for img in imgs:
                    raw, conf = self._perform_ocr_fast(img)
                    out, conf = self._finalize_ocr_result(format_qatar_plate(raw), conf)
                    if out and conf >= best_conf:
                        best_out, best_conf = out, conf
            else:
                out, conf = self._finalize_ocr_result(*self._perform_ocr_easyocr(variant))
                if out and conf >= best_conf:
                    best_out, best_conf = out, conf

        if _is_dark_plate_crop(image_array):
            out, conf = self._finalize_ocr_result(*self._perform_ocr_digits_only(image_array))
            if out and conf >= best_conf:
                best_out, best_conf = out, conf

        return best_out, best_conf

    # ── Session tracking ───────────────────────────────────────────────────────

    def _touch_session(self, track_id: int, src_frame: int) -> None:
        if track_id < 0:
            return
        if track_id not in self._sessions:
            self._sessions[track_id] = {
                "track_id": track_id,
                "first_src_frame": int(src_frame),
                "last_src_frame": int(src_frame),
                "speed_peak": 0,
            }
        else:
            self._sessions[track_id]["last_src_frame"] = int(src_frame)

    def _remember_plate(self, track_id: int, formatted: str) -> None:
        if track_id < 0 or not formatted or formatted in ("—", "…"):
            return
        prev = self._best_plate_ever.get(track_id)
        self._best_plate_ever[track_id] = (
            vote_best_plate([(prev, 1.0), (formatted, 1.0)]) if prev else formatted
        )

    def _registry_touch(
        self,
        track_id: int,
        src_frame: int,
        *,
        active: bool,
        session: dict[str, Any] | None = None,
    ) -> None:
        """Persistent one-row-per-track manifest; survives session finalize/drop."""
        if track_id < 0:
            return
        vfps = max(self._vid_fps_store, 1e-3)
        plate = self._plate_display_for_track(track_id)
        sess = session or self._sessions.get(track_id)
        f0 = int(sess["first_src_frame"]) if sess else int(src_frame)
        f1 = int(sess["last_src_frame"]) if sess else int(src_frame)
        peak = int(sess.get("speed_peak", 0) or 0) if sess else 0
        if track_id in self.spd:
            peak = max(peak, int(self.spd[track_id]))
        last_kmh = int(self.spd[track_id]) if track_id in self.spd else None
        avg_kmh = self._avg_speed_for_track(track_id)

        existing = self._track_registry.get(track_id)
        if existing is None:
            t0 = (f0 - 1) / vfps
            t1 = f1 / vfps
            self._track_registry[track_id] = {
                "track_id": track_id,
                "plate": plate,
                "speed_kmh_max": peak or None,
                "speed_kmh_avg": avg_kmh,
                "speed_kmh_last": last_kmh,
                "t_enter_sec": round(t0, 3),
                "t_exit_sec": round(t1, 3),
                "duration_sec": round(max(0.0, t1 - t0), 3),
                "first_frame": f0,
                "last_frame": f1,
                "status": "active" if active else "exited",
            }
            return

        existing["first_frame"] = min(int(existing.get("first_frame") or f0), f0)
        existing["last_frame"] = max(int(existing.get("last_frame") or f1), f1)
        existing["t_enter_sec"] = round(max(0.0, (existing["first_frame"] - 1) / vfps), 3)
        existing["t_exit_sec"] = round(existing["last_frame"] / vfps, 3)
        existing["duration_sec"] = round(
            max(0.0, existing["t_exit_sec"] - existing["t_enter_sec"]), 3
        )
        if plate not in ("—", "…", ""):
            prev = str(existing.get("plate") or "")
            if prev in ("—", "…", ""):
                existing["plate"] = plate
            else:
                best = vote_best_plate([(prev, 1.0), (plate, 1.0)])
                if best:
                    existing["plate"] = best
        existing["status"] = "active" if active else "exited"
        sm = int(existing.get("speed_kmh_max") or 0)
        existing["speed_kmh_max"] = max(sm, peak) or None
        if last_kmh is not None:
            existing["speed_kmh_last"] = last_kmh
        if avg_kmh is not None:
            existing["speed_kmh_avg"] = avg_kmh

    def _finalize_track(self, track_id: int) -> None:
        if track_id < 0 or track_id not in self._sessions:
            return
        s = self._sessions.pop(track_id)
        self._update_plate_dwell_anchor(track_id)
        self._registry_touch(track_id, int(s["last_src_frame"]), active=False, session=s)
        # Snapshot OCR metrics BEFORE dropping votes so the exited row keeps its
        # confidence + vote count (otherwise the UI shows 0 votes for every car
        # that has already left the frame).
        metrics_snapshot = self._ocr_metrics_for_track(track_id)
        if not hasattr(self, "_ocr_metrics_archive"):
            self._ocr_metrics_archive = {}
        self._ocr_metrics_archive[track_id] = metrics_snapshot
        self._plate_votes.pop(track_id, None)
        plate = self._best_plate_for_track(track_id)
        if plate in ("—", "…", ""):
            plate = "—"
        vfps = max(self._vid_fps_store, 1e-3)
        f0, f1 = int(s["first_src_frame"]), int(s["last_src_frame"])
        t0 = (f0 - 1) / vfps
        t1 = f1 / vfps
        last_kmh = int(self.spd[track_id]) if track_id in self.spd else None
        peak = int(s.get("speed_peak", 0) or 0)
        spd_peak = peak or last_kmh
        avg_kmh = self._avg_speed_for_track(track_id)
        self._completed_rows.append({
            "track_id": track_id,
            "plate": plate,
            "speed_kmh_max": spd_peak if spd_peak else None,
            "speed_kmh_avg": avg_kmh,
            "speed_kmh_last": last_kmh,
            "t_enter_sec": round(t0, 3),
            "t_exit_sec": round(t1, 3),
            "duration_sec": round(max(0.0, t1 - t0), 3),
            "first_frame": f0,
            "last_frame": f1,
            "status": "exited",
            "ocr_locked": plate not in ("—", "…", ""),
            **metrics_snapshot,
        })
        if plate not in ("—", "…", ""):
            self._remember_session_vehicle(self._completed_rows[-1])

    def _finalize_lost_tracks(self) -> None:
        """Finalize only tracks absent for longer than the grace window."""
        grace = max(1, int(getattr(self, "_exit_grace_frames", 10)))
        now = self._proc_frame_no
        for tid in list(self._sessions.keys()):
            last_seen = self._last_seen_frame.get(tid, now)
            if now - last_seen >= grace:
                self._finalize_track(tid)
                self._last_seen_frame.pop(tid, None)

    def finalize_all_sessions(self) -> None:
        for tid in list(self._sessions.keys()):
            self._finalize_track(tid)
        self._last_seen_frame.clear()
        self._prev_positive_ids.clear()
        self._finalized = True

    def reset_detection_state(self) -> None:
        """Clear per-frame detection state without touching track history or sessions.

        Called in the live reconnect loop when the camera was moved or the stream
        was interrupted long enough that the previous scene is gone. Stale
        _last_fb_box / _detect_mode / _fb_tracks replayed against a new angle
        cause: frozen green box, wrong plate position, and ghost dwell counting.
        """
        self._detect_mode = ""
        self._mode_streak = 0
        self._last_fb_box = None
        self._fb_tracks = {}
        self._visible_track_ids = set()
        self._raw_repeat = None
        self._prev_det_boxes = []
        self._ocr_locked.clear()
        self._scene_gray_prev = None
        self._force_global_search = 0
        self._search_fail.clear()
        self._live_searching = False
        # Keep _plate_dwell_anchor / _tracks_ever_locked across reconnect for dwell resume.
        self._fb_track_plates.clear()
        try:
            self._inst.tracks = None
        except Exception:
            pass

    def _detection_is_credible(
        self,
        track_id: int,
        box,
        *,
        run_ocr: bool,
        ocr_text: str,
        accepted: bool,
        has_prior: bool,
        ocr_locked: bool,
        plate_shaped: bool,
    ) -> bool:
        """True when this box should extend dwell / session tracking."""
        if not plate_shaped:
            return False
        if track_id < 0:
            return bool(run_ocr and accepted and ocr_text.strip() and ocr_locked)
        if not ocr_locked:
            return False
        if run_ocr and accepted and ocr_text.strip():
            return True
        last_f = self._last_credible_frame.get(track_id)
        last_box = self._last_credible_box.get(track_id)
        if last_f is None or last_box is None:
            return True
        grace = max(3, int(getattr(self, "_exit_grace_frames", 10)) // 2)
        if self._proc_frame_no - last_f > grace:
            return False
        bx = [float(v) for v in box[:4]]
        return _iou_xyxy(bx, last_box) >= 0.25

    def _drop_track_aux_state(self, track_id: int) -> None:
        for store in (
            self.spd,
            self._spd_ema,
            self._spd_samples,
            self._speed_sum,
            self._speed_count,
            self._last_ocr_text,
            self._plate_votes,
            self._ocr_tick,
            self._best_plate_ever,
            self._last_seen_frame,
            self._last_credible_frame,
            self._last_credible_box,
        ):
            store.pop(track_id, None)
        self._ocr_locked.pop(track_id, None)
        self._seen_track_ids.discard(track_id)
        self._visible_track_ids.discard(track_id)
        self.logged_ids.discard(track_id)

    def prune_memory(self, *, max_registry_tracks: int | None = None) -> int:
        """Drop OCR/speed state for oldest exited tracks; keep summaries in _completed_rows."""
        cap = max_registry_tracks or int(settings.LIVE_MEMORY_MAX_TRACKS)
        if len(self._track_registry) <= cap:
            return 0
        exited = [
            (tid, row)
            for tid, row in self._track_registry.items()
            if str(row.get("status") or "").lower() == "exited"
        ]
        exited.sort(key=lambda x: float(x[1].get("t_exit_sec") or 0))
        pruned = 0
        while len(self._track_registry) > cap and exited:
            tid, row = exited.pop(0)
            if not any(r.get("track_id") == tid for r in self._completed_rows):
                self._completed_rows.append(dict(row))
            self._track_registry.pop(tid, None)
            self._drop_track_aux_state(tid)
            pruned += 1
        return pruned

    def _best_plate_for_track(self, track_id: int) -> str:
        votes = self._plate_votes.get(track_id, [])
        plate = (
            vote_best_plate(votes)
            or self._best_plate_ever.get(track_id)
            or format_qatar_plate(self._last_ocr_text.get(track_id, ""))
        )
        return plate or "…"

    def _ocr_metrics_for_track(self, track_id: int) -> dict[str, Any]:
        """Confidence and vote count for the winning plate read on this track."""
        votes = self._plate_votes.get(track_id, [])
        if not votes:
            archive = getattr(self, "_ocr_metrics_archive", {})
            if track_id in archive:
                return dict(archive[track_id])
            return {"ocr_confidence": None, "ocr_vote_count": 0}
        best = self._best_plate_for_track(track_id)
        if best in ("—", "…", ""):
            return {"ocr_confidence": None, "ocr_vote_count": 0}
        best_key = normalize_plate(best)
        matched = [
            (t, float(c))
            for t, c in votes
            if plates_match(t, best) or normalize_plate(format_qatar_plate(t)) == best_key
        ]
        pool = matched or [(t, float(c)) for t, c in votes]
        return {
            "ocr_confidence": round(max(c for _, c in pool), 3),
            "ocr_vote_count": len(pool),
        }

    def _enrich_manifest_ocr(self, rows: list[dict[str, Any]]) -> None:
        for row in rows:
            tid = row.get("track_id")
            if tid is None or int(tid) < 0:
                continue
            row.update(self._ocr_metrics_for_track(int(tid)))

    def _enrich_manifest_live(self, rows: list[dict[str, Any]]) -> None:
        """Live sync fields — UI can show searching vs locked in step with the video."""
        visible = getattr(self, "_visible_track_ids", set()) or set()
        for row in rows:
            tid = row.get("track_id")
            if tid is None:
                continue
            tid_i = int(tid)
            if tid_i < 0:
                continue
            status = str(row.get("status") or "").lower()
            ever_locked = tid_i in self._tracks_ever_locked or bool(row.get("ocr_locked"))
            locked = bool(self._ocr_locked.get(tid_i)) or ever_locked
            row["ocr_locked"] = locked
            row["phase"] = self._track_phase(tid_i)
            row["visible_in_frame"] = tid_i in visible
            # Only mask plate/OCR for active tracks still searching — never wipe history.
            if status == "active" and not self._ocr_locked.get(tid_i):
                row["plate"] = "…"
                row["ocr_confidence"] = None
                row["ocr_vote_count"] = 0

    def _manifest_row_visible(self, tid: int, row: dict[str, Any]) -> bool:
        """Hide brief ghost tracks that never confirmed a plate."""
        if tid in self._tracks_ever_locked or self._ocr_locked.get(tid):
            return True
        return False

    def get_vehicle_manifest(self) -> list[dict[str, Any]]:
        vfps = max(self._vid_fps_store, 1e-3)
        src_frame = int(getattr(self, "_source_frame_idx", 0) or 0)
        # "now" in source-time seconds drives Paused-vs-Done while a session is
        # still running. Once finalized (file done / live stopped) there is no
        # "now" → every exited track is reported as Done.
        now_sec = None if self._finalized else (src_frame / vfps)

        for tid, s in self._sessions.items():
            self._registry_touch(tid, int(s["last_src_frame"]), active=True, session=s)
        for tid in sorted(self._visible_track_ids):
            self._registry_touch(tid, src_frame, active=True)
        for tid in sorted(self._seen_track_ids):
            if tid not in self._track_registry:
                self._registry_touch(
                    tid,
                    src_frame,
                    active=(tid in self._sessions),
                )

        rows = []
        for tid in sorted(self._track_registry.keys()):
            row = dict(self._track_registry[tid])
            row["plate"] = self._plate_display_for_track(tid)
            row["speed_kmh_avg"] = self._avg_speed_for_track(tid)
            if tid in self._sessions:
                row["status"] = "active"
            if self._manifest_row_visible(tid, row):
                rows.append(row)

        archived = [dict(r) for r in self._completed_rows]
        seen_tids = {r.get("track_id") for r in rows}
        for r in archived:
            if r.get("track_id") not in seen_tids:
                rows.append(r)

        if not rows:
            active = []
            for tid, s in self._sessions.items():
                plate = self._plate_display_for_track(tid)
                f0, f1 = int(s["first_src_frame"]), int(s["last_src_frame"])
                t0 = (f0 - 1) / vfps
                t1 = f1 / vfps
                peak = int(s.get("speed_peak", 0) or 0)
                last_s = int(self.spd[tid]) if tid in self.spd else None
                active.append({
                    "track_id": tid,
                    "plate": plate,
                    "speed_kmh_max": max(peak, last_s or 0) or None,
                    "speed_kmh_avg": self._avg_speed_for_track(tid),
                    "speed_kmh_last": last_s,
                    "t_enter_sec": round(t0, 3),
                    "t_exit_sec": round(t1, 3),
                    "duration_sec": round(max(0.0, t1 - t0), 3),
                    "first_frame": f0,
                    "last_frame": f1,
                    "status": "active",
                    **self._ocr_metrics_for_track(tid),
                })
            done = sorted(self._completed_rows, key=lambda r: r["t_enter_sec"])
            pre_rows = done + active
            rows = _consolidate_manifest_rows(pre_rows, now_sec=now_sec)
            for r in rows:
                self._remember_session_vehicle(r)
        else:
            self._enrich_manifest_ocr(rows)
            self._enrich_manifest_live(rows)
            pre_rows = [dict(r) for r in rows]
            rows = _consolidate_manifest_rows(rows, now_sec=now_sec)
            for r in rows:
                self._remember_session_vehicle(r)

        if self._session_registry:
            # Union ledger + latest frame rows so historic cars never disappear and
            # status always reflects the most recent consolidated snapshot.
            merged_by_key: dict[str, dict[str, Any]] = {}
            for r in rows:
                key = self._session_registry_key(str(r.get("plate") or ""))
                if key:
                    merged_by_key[key] = dict(r)
            for key, snap in self._session_registry.items():
                cur = merged_by_key.get(key)
                merged_by_key[key] = (
                    self._merge_session_vehicle_row(snap, cur) if cur is not None else dict(snap)
                )
            rows = _consolidate_manifest_rows(
                list(merged_by_key.values()),
                now_sec=now_sec,
            )

        rows.sort(key=lambda r: float(r.get("t_enter_sec") or 0))
        self._debug_log_manifest(pre_rows, rows)
        return rows

    def _debug_log_manifest(self, pre_rows: list[dict], rows: list[dict]) -> None:
        """Trace per-track plate/vote/status through consolidation (env PLATE_DEBUG=1)."""
        if not _PLATE_DEBUG:
            return
        self._dbg_tick = getattr(self, "_dbg_tick", 0) + 1
        if self._dbg_tick % _PLATE_DEBUG_EVERY != 0:
            return
        try:
            pre = []
            for r in sorted(pre_rows, key=lambda x: int(x.get("track_id") or 0)):
                tid = r.get("track_id")
                votes = self._plate_votes.get(int(tid), []) if tid is not None else []
                vote_str = ",".join(f"{normalize_plate(v[0])}:{v[1]:.2f}" for v in votes[-4:])
                pre.append(
                    f"#{tid}[{r.get('plate')}|{r.get('status')}|"
                    f"v{len(votes)}({vote_str})|ever={self._best_plate_ever.get(int(tid)) if tid is not None else None}]"
                )
            post = [f"#{r.get('track_id')}[{r.get('plate')}|{r.get('status')}|seg{r.get('segment_count', 1)}]" for r in rows]
            _log.info("PLATE_DEBUG pre(%d): %s", len(pre_rows), " ".join(pre))
            _log.info("PLATE_DEBUG post(%d): %s", len(rows), " ".join(post))
        except Exception as exc:
            _log.warning("PLATE_DEBUG failed: %s", exc)

    def _process_track_detection(
        self,
        im0,
        box,
        track_id,
        cls,
        src_frame: int,
        current_time: datetime,
        *,
        draw: bool = True,
    ) -> None:
        tid = int(track_id)

        fh, fw = im0.shape[:2]
        padded = _pad_box_for_ocr(box, fw, fh)
        x1b, y1b, x2b, y2b = padded
        cropped = np.array(im0)[y1b:y2b, x1b:x2b]
        plate_shaped = _is_plate_shaped_box(padded)

        self._unlock_track_if_shifted(tid, box)

        # SD cloud frames: upscale small plate crops before OCR (matches upload SD behaviour).
        if bool(getattr(self, "_live_low_res", False)) and cropped.size > 0:
            ch, cw = cropped.shape[:2]
            if cw < 140 or ch < 40:
                scale = min(3.0, max(140.0 / max(cw, 1), 40.0 / max(ch, 1)))
                if scale > 1.15:
                    cropped = cv2.resize(
                        cropped,
                        (max(1, int(cw * scale)), max(1, int(ch * scale))),
                        interpolation=cv2.INTER_LANCZOS4,
                    )

        self._ocr_tick[tid] = self._ocr_tick.get(tid, 0) + 1
        stride = self._ocr_stride_for_track(tid)
        has_prior = tid in self._last_ocr_text and bool(self._last_ocr_text.get(tid, "").strip())
        ocr_locked = bool(self._ocr_locked.get(tid)) if tid >= 0 else False
        searching = tid >= 0 and not ocr_locked
        box_w_frac = (x2b - x1b) / float(max(1, fw))
        large_in_frame = box_w_frac >= 0.07
        run_ocr = (
            cropped.size > 0
            and (
                tid < 0
                or searching
                or not has_prior
                or (self._ocr_tick[tid] % stride == 0)
            )
            and (plate_shaped or has_prior or tid < 0 or large_in_frame)
        )
        if run_ocr:
            ocr_text, ocr_conf = self.perform_ocr(cropped)
        else:
            ocr_text = self._last_ocr_text.get(tid, "") if ocr_locked else ""
            ocr_conf = 0.0

        accepted = False
        if ocr_text.strip():
            formatted = format_qatar_plate(ocr_text.strip())
            if not formatted:
                formatted = ocr_text.strip()
            accepted = accept_plate_read(
                formatted,
                jurisdiction=self._plate_jurisdiction,
                strict=False,
            )
            if tid >= 0 and accepted:
                min_c = float(getattr(self, "_min_ocr_conf", 0.25))
                if (
                    float(ocr_conf) >= min_c
                    and sync_eligible_plate(formatted, jurisdiction=self._plate_jurisdiction)
                    and _is_likely_plate_crop(im0, box)
                ):
                    bucket = self._plate_votes.setdefault(tid, [])
                    bucket.append((formatted, float(ocr_conf)))
                    if len(bucket) > _MAX_PLATE_VOTES:
                        self._plate_votes[tid] = bucket[-_MAX_PLATE_VOTES:]
                if self._try_confirm_plate_lock(tid, formatted, ocr_conf, im0, box):
                    self._last_ocr_text[tid] = formatted
                    self._ocr_locked[tid] = True
                    self._tracks_ever_locked.add(tid)
                    self._search_fail[tid] = 0
                    self._inherit_dwell_for_plate(tid, formatted, src_frame)
                    self._update_plate_dwell_anchor(tid)
                    self._remember_plate(tid, formatted)
            elif tid >= 0 and run_ocr and searching:
                fails = self._search_fail.get(tid, 0) + 1
                self._search_fail[tid] = fails
                if fails >= 2:
                    self._force_global_search = max(
                        int(getattr(self, "_force_global_search", 0)), 12
                    )
                    self._live_searching = True
                    self._invalidate_fast_path()
                    self._fb_tracks.pop(tid, None)
                    self._ocr_locked[tid] = False

        ocr_locked = bool(self._ocr_locked.get(tid)) if tid >= 0 else False
        credible = self._detection_is_credible(
            tid,
            box,
            run_ocr=run_ocr,
            ocr_text=ocr_text,
            accepted=accepted,
            has_prior=has_prior,
            ocr_locked=ocr_locked,
            plate_shaped=plate_shaped,
        )
        if plate_shaped:
            self._last_credible_frame[tid] = self._proc_frame_no
            self._last_credible_box[tid] = [float(v) for v in box[:4]]
        if run_ocr and accepted and ocr_text.strip():
            self._last_credible_frame[tid] = self._proc_frame_no
            self._last_credible_box[tid] = [float(v) for v in box[:4]]

        if tid >= 0 and credible:
            self._visible_track_ids.add(tid)
            self._inst.store_tracking_history(tid, box)

            hist = self.track_history[tid]
            if len(hist) >= 2:
                x0, y0 = _point_xy(hist[-2])
                x1, y1 = _point_xy(hist[-1])
                pix_dist = math.hypot(x1 - x0, y1 - y0)
                dt = max(self._proc_stride / max(self._vid_fps, 1e-3), 1e-6)
                v_px_s = pix_dist / dt
                kmh_inst = min(v_px_s * self._meter_per_pixel * 3.6, self._max_speed_kmh)
                win = max(1, int(getattr(settings, "SPEED_WINDOW_SAMPLES", 5)))
                samples = self._spd_samples.setdefault(tid, [])
                samples.append(kmh_inst)
                if len(samples) > win:
                    del samples[:-win]
                kmh_med = float(np.median(samples)) if samples else kmh_inst
                prev = self._spd_ema.get(tid)
                alpha = self._speed_smooth
                self._spd_ema[tid] = kmh_med if prev is None else alpha * kmh_med + (1.0 - alpha) * prev
                self.spd[tid] = int(round(self._spd_ema[tid]))
                self._record_speed_sample(tid, self._spd_ema[tid])

            self._touch_session(tid, src_frame)
            self._last_seen_frame[tid] = self._proc_frame_no
            if tid in self.spd and tid in self._sessions:
                self._sessions[tid]["speed_peak"] = max(
                    int(self._sessions[tid].get("speed_peak", 0)), int(self.spd[tid])
                )
            self._registry_touch(tid, src_frame, active=True)

        if draw and (plate_shaped or tid >= 0):
            if tid >= 0:
                if self._ocr_locked.get(tid):
                    plate_show = self._best_plate_for_track(tid)
                else:
                    plate_show = "…"
            else:
                # Raw (negative-id) boxes: show only THIS frame's read — never a
                # remembered plate, which could belong to a different vehicle.
                cur = format_qatar_plate(ocr_text.strip()) or ocr_text.strip()
                plate_show = cur or "…"
            spd_show = f"{int(self.spd[tid])} km/h" if tid in self.spd else "— km/h"
            label = f"ID:{tid if tid >= 0 else 'det'} {plate_show} | {spd_show}"
            self.annotator.box_label(box, label=label, color=_LABEL_COLOR)

        class_name = self.names[int(cls)]
        speed = self.spd.get(tid)
        save_no_speed = getattr(self, "_save_without_speed", False)
        if (
            tid >= 0
            and tid not in self.logged_ids
            and ocr_text.strip()
            and self._ocr_locked.get(tid)
            and (speed is not None or save_no_speed)
        ):
            self.save_to_database(
                current_time.strftime("%Y-%m-%d"),
                current_time.strftime("%H:%M:%S"),
                tid, class_name,
                float(speed) if speed is not None else 0.0,
                format_qatar_plate(ocr_text),
            )
            self.logged_ids.add(tid)

    # ── Main frame processing ──────────────────────────────────────────────────

    def estimate_speed(self, im0):
        self.annotator = self._Annotator(im0, line_width=self.line_width)
        self._extract_tracks_adaptive(im0)

        raw_detections: list[tuple[Any, Any, Any]] = []
        n_raw = len(self.boxes) if self.boxes is not None else 0
        for i in range(n_raw):
            tid = int(self.track_ids[i])
            if tid >= 0:
                self._seen_track_ids.add(tid)
            raw_detections.append((self.boxes[i], self.track_ids[i], self.clss[i]))

        self._filter_overlapping_detections()
        self._normalize_detection_state()
        kept_ids = {int(t) for t in self.track_ids}

        self._visible_track_ids = set()
        self._proc_frame_no += 1
        current_time = datetime.now(get_business_zoneinfo())
        src_frame = int(getattr(self, "_source_frame_idx", 0) or 0)

        for box, track_id, cls in zip(self.boxes, self.track_ids, self.clss):
            self._process_track_detection(
                im0, box, track_id, cls, src_frame, current_time, draw=True
            )

        # Overlap filter drops duplicate boxes; still OCR + register those tracks.
        for box, track_id, cls in raw_detections:
            tid = int(track_id)
            if tid >= 0 and tid not in kept_ids:
                self._process_track_detection(
                    im0, box, track_id, cls, src_frame, current_time, draw=True
                )

        self._finalize_lost_tracks()
        self._prev_det_boxes = self._current_det_boxes()
        return im0


# ── Public API ─────────────────────────────────────────────────────────────────

def default_analyze_args(**overrides: Any) -> argparse.Namespace:
    fields = {
        "video": None, "pick": False,
        "conf": settings.YOLO11_CONF,
        "iou": 0.7,
        "stride": 1,
        "width": settings.YOLO11_RESIZE_WIDTH,
        "roi_y_at_500h": settings.YOLO11_ROI_Y_AT_500H,
        "save_without_speed": settings.YOLO11_SAVE_WITHOUT_SPEED,
        "meter_per_pixel": settings.YOLO11_METER_PER_PIXEL,
        "max_speed": settings.YOLO11_MAX_SPEED_KMH,
        "speed_smooth": settings.YOLO11_SPEED_SMOOTH,
        "fps": 0.0,
        "ocr_interval": 2,
        "min_ocr_conf": 0.28,
    }
    fields.update(overrides)
    return argparse.Namespace(**fields)


def _require_yolo_weights() -> Path:
    model_path = resolve_yolo_weights()
    if model_path is None:
        raise FileNotFoundError(
            "YOLO plate weights not found. Place a trained checkpoint at "
            "backend/models/yolo26_best.pt or backend/models/best.pt, "
            "or set YOLO26_WEIGHTS / YOLO11_WEIGHTS in .env."
        )
    return model_path


def _compute_work_size(
    w0: int,
    h0: int,
    target_width: int,
    *,
    live_anpr: bool = False,
) -> tuple[int, int]:
    """
    Pick inference frame size. Portrait phone clips upscale the long edge so
    distant/small plates retain enough pixels for YOLO (never downscale native).
    Cloud SD sub-streams are upscaled to VF_LIVE_SD_INFERENCE_WIDTH so live ANPR
    matches uploaded SD video quality.
    """
    tw = max(320, int(target_width))
    if live_anpr and _is_low_res_source(w0, h0):
        min_w = int(getattr(settings, "VF_LIVE_SD_INFERENCE_WIDTH", 1280) or 1280)
        tw = max(tw, min_w)
    if h0 > w0 * 1.12:
        min_long = max(tw, int(os.environ.get("VF_PORTRAIT_MIN_LONG", "1440")))
        scale = max(1.0, min_long / float(h0))
        scale = min(scale, 2.5)
        tw = max(320, int(round(w0 * scale)))
        th = max(1, int(round(h0 * scale)))
        return tw, th
    th = max(1, int(round(h0 * tw / w0)))
    return tw, th


def _notify_phase(cb: Callable[[str], Any] | None, msg: str) -> None:
    if cb:
        try:
            cb(msg)
        except Exception:
            pass


def _run_live_tracking_loop(
    cap: cv2.VideoCapture,
    speed_obj: SpeedEstimator,
    *,
    target_w: int,
    new_h: int,
    stride: int,
    vfps: float,
    total_inference_est: int,
    writer: Any | None,
    preview_jpeg_callback: Callable[[bytes], Any] | None,
    preview_stream_fps: float,
    preview_jpeg_quality: int,
    manifest_callback: Callable[[list[dict[str, Any]]], Any] | None,
    progress_callback: Callable[[int, int], Any] | None,
    show_window: bool,
    max_frames: int,
    stop_event: threading.Event | None,
    live_read_fail_max: int,
    health_pulse: Callable[[], None] | None,
    on_prune: Callable[[Any], None] | None,
    prune_every: int,
    on_detections: Callable[[float, int], None] | None = None,
    interrupt_check: Callable[[], str | None] | None = None,
    loop_ctl: dict[str, Any] | None = None,
) -> tuple[int, list[dict[str, Any]]]:
    """
    Live camera loop: a reader thread keeps preview fresh while AI runs on strided frames.
    Prevents the feed freezing when YOLO/OCR is slow on CPU.

    ``on_detections(max_width_frac, count)`` reports plate boxes per processed
    frame to the stream governor. ``interrupt_check()`` may return a reason
    ("tier" / "idle") to break the loop early; the reason is published in
    ``loop_ctl["break_reason"]`` so the outer reconnect loop can act on it.
    """
    frame_slot: dict[str, Any] = {"frame": None, "seq": 0}
    slot_lock = threading.Lock()
    reader_running = True
    consecutive_miss = 0
    processed = 0
    count = 0
    manifest_out: list[dict[str, Any]] = []
    preview_interval = 1.0 / max(1.0, min(30.0, float(preview_stream_fps)))
    preview_gate = 0.0
    ai_gate = 0.0
    min_ai_interval = 1.0 / max(2.0, min(8.0, float(preview_stream_fps) * 0.6))

    def _encode_preview(frame: np.ndarray) -> None:
        nonlocal preview_gate
        now = time.monotonic()
        if now - preview_gate < preview_interval:
            return
        preview_gate = now
        try:
            preview_frame = cv2.resize(frame, (target_w, new_h))
            ok, buf = cv2.imencode(
                ".jpg",
                preview_frame,
                [int(cv2.IMWRITE_JPEG_QUALITY), max(40, min(95, int(preview_jpeg_quality)))],
            )
            if ok:
                preview_jpeg_callback(buf.tobytes())
        except Exception:
            pass

    def _reader() -> None:
        nonlocal consecutive_miss, reader_running
        while reader_running and (stop_event is None or not stop_event.is_set()):
            try:
                ret, frame = cap.read()
            except Exception:
                # A backend-level read error is treated like a failed read so the
                # reconnect loop can re-open the capture instead of crashing the thread.
                ret, frame = False, None
            if not ret:
                consecutive_miss += 1
                if consecutive_miss >= live_read_fail_max:
                    break
                time.sleep(0.05)
                continue
            consecutive_miss = 0
            with slot_lock:
                frame_slot["frame"] = frame
                frame_slot["seq"] += 1
            _encode_preview(frame)
            time.sleep(0.001)

    reader = threading.Thread(target=_reader, name="visionflow-live-reader", daemon=True)
    reader.start()

    # Stall watchdog: if the capture stays "open" but stops delivering NEW frames
    # (frozen RTSP buffer or a blocked cap.read()), force a reconnect instead of
    # replaying the last frame forever while health looks green.
    last_seq = 0
    last_seq_change = time.monotonic()
    # Tolerate slow Wi-Fi sub-streams / CPU inference before declaring a stall.
    # Configurable via LIVE_STALL_RECONNECT_SEC so a busy decode pipeline does
    # not trigger constant reconnects (the "fluctuating feed" symptom).
    try:
        stall_timeout = max(8.0, float(settings.LIVE_STALL_RECONNECT_SEC))
    except Exception:
        stall_timeout = 25.0
    speed_err_count = 0
    interrupt_gate = time.monotonic()

    try:
        while True:
            if stop_event is not None and stop_event.is_set():
                break

            # Stream-governor interrupts (SD<->HD switch, idle/power-save):
            # checked on a coarse cadence — both actions reconnect the stream.
            if interrupt_check is not None:
                now_chk = time.monotonic()
                if now_chk - interrupt_gate >= 2.0:
                    interrupt_gate = now_chk
                    try:
                        reason = interrupt_check()
                    except Exception:
                        reason = None
                    if reason:
                        if loop_ctl is not None:
                            loop_ctl["break_reason"] = reason
                        break
            # Reader exits on repeated read failures, end-of-stream, or an error.
            # Break so the outer reconnect loop re-opens the capture; never keep
            # processing a stale frame behind a dead reader.
            if not reader.is_alive():
                break

            with slot_lock:
                frame = frame_slot["frame"]
                seq = frame_slot["seq"]

            now_watch = time.monotonic()
            if seq != last_seq:
                last_seq = seq
                last_seq_change = now_watch
            elif frame is not None and (now_watch - last_seq_change) > stall_timeout:
                _log.warning(
                    "Live feed stalled (no new frame for %.0fs); forcing reconnect.",
                    stall_timeout,
                )
                break

            if frame is None:
                time.sleep(0.02)
                continue

            now = time.monotonic()
            if now - ai_gate < min_ai_interval:
                time.sleep(0.01)
                continue

            count += 1
            if count % stride != 0:
                continue

            ai_gate = now
            native_w = int(getattr(speed_obj, "_native_w", 0) or 0)
            work = _resize_for_inference(frame.copy(), target_w, new_h, native_w=native_w)
            speed_obj._source_frame_idx = count
            _sema = _get_inference_semaphore()
            if _sema is not None:
                _sema.acquire()
            try:
                result = speed_obj.estimate_speed(work)
            except Exception:
                # Don't silently swallow: surface the failure (rate-limited) so a
                # systematic problem is observable instead of producing an empty feed.
                speed_err_count += 1
                if speed_err_count <= 3 or speed_err_count % 200 == 0:
                    _log.exception(
                        "estimate_speed failed (occurrence #%d); skipping frame.",
                        speed_err_count,
                    )
                continue
            finally:
                if _sema is not None:
                    _sema.release()
            processed += 1

            if on_detections is not None:
                try:
                    boxes = speed_obj.boxes
                    n_boxes = len(boxes) if boxes is not None else 0
                    max_wf = 0.0
                    if n_boxes:
                        for b in boxes:
                            x1, _, x2, _ = map(float, b[:4])
                            max_wf = max(max_wf, (x2 - x1) / float(max(1, target_w)))
                    on_detections(max_wf, n_boxes)
                except Exception:
                    pass

            if health_pulse is not None:
                try:
                    health_pulse()
                except Exception:
                    pass

            if on_prune is not None and processed % prune_every == 0:
                try:
                    on_prune(speed_obj)
                except Exception:
                    pass

            if writer is not None:
                writer.write(result)

            try:
                ok, buf = cv2.imencode(
                    ".jpg",
                    result,
                    [int(cv2.IMWRITE_JPEG_QUALITY), max(40, min(95, int(preview_jpeg_quality)))],
                )
                if ok:
                    preview_jpeg_callback(buf.tobytes())
            except Exception:
                pass

            if progress_callback:
                progress_callback(processed, total_inference_est)

            if manifest_callback and _should_push_manifest(speed_obj, processed):
                try:
                    manifest_callback(speed_obj.get_vehicle_manifest())
                except Exception:
                    pass

            if show_window:
                cv2.imshow("VisionFlow", result)
                if cv2.waitKey(1) & 0xFF == ord("q"):
                    break

            if max_frames > 0 and processed >= max_frames:
                break

            if consecutive_miss >= live_read_fail_max:
                break
    finally:
        reader_running = False
        reader.join(timeout=2.0)
        try:
            speed_obj.finalize_all_sessions()
            manifest_out = speed_obj.get_vehicle_manifest()
            if manifest_callback:
                manifest_callback(manifest_out)
        except Exception:
            pass

    return processed, manifest_out


def _run_tracking_loop(
    cap: cv2.VideoCapture,
    speed_obj: SpeedEstimator,
    *,
    target_w: int,
    new_h: int,
    stride: int,
    vfps: float,
    total_inference_est: int,
    writer: Any | None,
    preview_jpeg_callback: Callable[[bytes], Any] | None,
    preview_stream_fps: float,
    preview_jpeg_quality: int,
    manifest_callback: Callable[[list[dict[str, Any]]], Any] | None,
    progress_callback: Callable[[int, int], Any] | None,
    show_window: bool,
    max_frames: int,
    stop_event: threading.Event | None = None,
    live_mode: bool = False,
    live_read_fail_max: int | None = None,
    health_pulse: Callable[[], None] | None = None,
    on_prune: Callable[[Any], None] | None = None,
    on_detections: Callable[[float, int], None] | None = None,
    interrupt_check: Callable[[], str | None] | None = None,
    loop_ctl: dict[str, Any] | None = None,
) -> tuple[int, list[dict[str, Any]]]:
    """Shared frame loop for file-based and live camera / stream analysis."""
    count = 0
    processed = 0
    preview_gate = {"t": 0.0}
    preview_interval = 1.0 / max(1.0, min(30.0, float(preview_stream_fps)))
    manifest_out: list[dict[str, Any]] = []
    consecutive_miss = 0
    max_miss = live_read_fail_max if live_read_fail_max is not None else (
        int(settings.LIVE_READ_FAIL_MAX) if live_mode else 1
    )
    prune_every = max(100, int(settings.LIVE_MEMORY_PRUNE_EVERY_FRAMES))

    if live_mode and preview_jpeg_callback is not None:
        return _run_live_tracking_loop(
            cap,
            speed_obj,
            target_w=target_w,
            new_h=new_h,
            stride=stride,
            vfps=vfps,
            total_inference_est=total_inference_est,
            writer=writer,
            preview_jpeg_callback=preview_jpeg_callback,
            preview_stream_fps=preview_stream_fps,
            preview_jpeg_quality=preview_jpeg_quality,
            manifest_callback=manifest_callback,
            progress_callback=progress_callback,
            show_window=show_window,
            max_frames=max_frames,
            stop_event=stop_event,
            live_read_fail_max=max_miss,
            health_pulse=health_pulse,
            on_prune=on_prune,
            prune_every=prune_every,
            on_detections=on_detections,
            interrupt_check=interrupt_check,
            loop_ctl=loop_ctl,
        )

    try:
        while True:
            if stop_event is not None and stop_event.is_set():
                break
            ret, frame = cap.read()
            if not ret:
                consecutive_miss += 1
                if live_mode:
                    if consecutive_miss >= max_miss:
                        break
                    time.sleep(0.05)
                    continue
                break
            consecutive_miss = 0

            count += 1

            # Live preview from raw frames (before stride/AI) so the wall shows video immediately.
            if live_mode and preview_jpeg_callback is not None:
                now = time.monotonic()
                if now - preview_gate["t"] >= preview_interval:
                    preview_gate["t"] = now
                    try:
                        preview_frame = cv2.resize(frame, (target_w, new_h))
                        ok, buf = cv2.imencode(
                            ".jpg",
                            preview_frame,
                            [int(cv2.IMWRITE_JPEG_QUALITY), max(40, min(95, int(preview_jpeg_quality)))],
                        )
                        if ok:
                            preview_jpeg_callback(buf.tobytes())
                    except Exception:
                        pass

            if count % stride != 0:
                continue

            native_w = int(getattr(speed_obj, "_native_w", 0) or 0)
            frame = _resize_for_inference(frame, target_w, new_h, native_w=native_w)
            speed_obj._source_frame_idx = count
            _sema = _get_inference_semaphore()
            if _sema is not None:
                _sema.acquire()
            try:
                result = speed_obj.estimate_speed(frame)
            finally:
                if _sema is not None:
                    _sema.release()
            processed += 1

            if health_pulse is not None:
                try:
                    health_pulse()
                except Exception:
                    pass

            if live_mode and on_prune is not None and processed % prune_every == 0:
                try:
                    on_prune(speed_obj)
                except Exception:
                    pass

            if writer is not None:
                writer.write(result)

            if preview_jpeg_callback is not None:
                now = time.monotonic()
                if now - preview_gate["t"] >= preview_interval:
                    preview_gate["t"] = now
                    ok, buf = cv2.imencode(
                        ".jpg",
                        result,
                        [int(cv2.IMWRITE_JPEG_QUALITY), max(40, min(95, int(preview_jpeg_quality)))],
                    )
                    if ok:
                        preview_jpeg_callback(buf.tobytes())

            if progress_callback:
                progress_callback(processed, total_inference_est)

            if manifest_callback and _should_push_manifest(speed_obj, processed):
                try:
                    manifest_callback(speed_obj.get_vehicle_manifest())
                except Exception:
                    pass

            if show_window:
                cv2.imshow("VisionFlow", result)
                if cv2.waitKey(1) & 0xFF == ord("q"):
                    break

            if max_frames > 0 and processed >= max_frames:
                break
    finally:
        try:
            speed_obj.finalize_all_sessions()
            manifest_out = speed_obj.get_vehicle_manifest()
            if manifest_callback:
                manifest_callback(manifest_out)
        except Exception:
            pass

    return processed, manifest_out


def analyze_video_path(
    video_path: Path,
    args: argparse.Namespace,
    *,
    output_video_path: Path | None = None,
    progress_callback: Callable[[int, int], Any] | None = None,
    phase_callback: Callable[[str], Any] | None = None,
    prefer_fast_encoder: bool = False,
    preview_jpeg_callback: Callable[[bytes], Any] | None = None,
    preview_stream_fps: float = 12.0,
    preview_jpeg_quality: int = 78,
    manifest_callback: Callable[[list[dict[str, Any]]], Any] | None = None,
    show_window: bool | None = None,
    max_frames: int | None = None,
) -> dict[str, Any]:
    """
    Run YOLO+EasyOCR plate detection and speed estimation on a video file.
    Models load here — first call takes 30-90 s while YOLO + EasyOCR initialise.
    """
    model_path = _require_yolo_weights()

    _notify_phase(phase_callback, "Opening video…")
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError(f"Could not open video: {video_path}")

    w0 = max(1, int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)))
    h0 = max(1, int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)))
    target_w, new_h = _compute_work_size(w0, h0, args.width, live_anpr=True)
    roi_y = max(1, min(new_h - 2, int(round(args.roi_y_at_500h * new_h / 500))))
    region_points = [(0, roi_y), (target_w - 1, roi_y)]

    vfps = float(args.fps) if args.fps and args.fps > 0 else float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
    if vfps < 1.0 or vfps > 240.0:
        vfps = 30.0

    stride = max(1, args.stride)
    raw_total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    total_inference_est = max(1, (raw_total + stride - 1) // stride) if raw_total > 0 else 1

    _notify_phase(phase_callback,
        "Loading YOLO + EasyOCR… (first run 30-90 s; progress stays 0% until models are ready)")

    speed_obj = None
    try:
        speed_obj = SpeedEstimator(
            region=region_points,
            model=str(model_path),
            line_width=2,
            show=False,
            conf=args.conf,
            iou=args.iou,
            verbose=False,
        )
    except Exception:
        cap.release()
        raise

    speed_obj._save_without_speed = getattr(args, "save_without_speed", False)
    speed_obj._vid_fps = vfps
    speed_obj._vid_fps_store = vfps
    speed_obj._proc_stride = float(stride)
    speed_obj._ocr_interval = max(1, int(getattr(args, "ocr_interval", 2)))
    speed_obj._min_ocr_conf = min(1.0, max(0.0, float(getattr(args, "min_ocr_conf", 0.28))))
    speed_obj._meter_per_pixel = max(1e-6, float(args.meter_per_pixel))
    speed_obj._max_speed_kmh = max(1.0, float(args.max_speed))
    speed_obj._speed_smooth = min(1.0, max(0.05, float(args.speed_smooth)))
    _proc_fps = max(1.0, vfps / float(max(1, stride)))
    speed_obj._exit_grace_frames = max(6, int(round(_proc_fps * float(settings.PLATE_EXIT_GRACE_SEC))))

    if show_window is None:
        show_window = os.environ.get("HEADLESS", "").strip() not in ("1", "true", "yes")
    if max_frames is None:
        max_frames = int(os.environ.get("MAX_FRAMES", "0"))

    writer = None
    if output_video_path is not None:
        _notify_phase(phase_callback, "Preparing video encoder…")
        output_video_path.parent.mkdir(parents=True, exist_ok=True)
        out_fps = max(1.0, vfps / float(stride))
        size = (target_w, new_h)
        codec_order = [("avc1", "avc1"), ("mp4v", "mp4v")] if not prefer_fast_encoder \
                      else [("mp4v", "mp4v"), ("avc1", "avc1")]
        for _, cc in codec_order:
            candidate = cv2.VideoWriter(str(output_video_path), cv2.VideoWriter_fourcc(*cc), out_fps, size)
            if candidate.isOpened():
                writer = candidate
                break
            candidate.release()
        if writer is None:
            cap.release()
            raise RuntimeError("Could not open VideoWriter for output video.")

    _notify_phase(phase_callback, "Analyzing frames…")
    if progress_callback:
        progress_callback(0, total_inference_est)

    processed, manifest_out = _run_tracking_loop(
        cap,
        speed_obj,
        target_w=target_w,
        new_h=new_h,
        stride=stride,
        vfps=vfps,
        total_inference_est=total_inference_est,
        writer=writer,
        preview_jpeg_callback=preview_jpeg_callback,
        preview_stream_fps=preview_stream_fps,
        preview_jpeg_quality=preview_jpeg_quality,
        manifest_callback=manifest_callback,
        progress_callback=progress_callback,
        show_window=bool(show_window),
        max_frames=max_frames,
        stop_event=None,
        live_mode=False,
    )
    cap.release()
    if writer is not None:
        writer.release()
    if show_window:
        cv2.destroyAllWindows()

    return {
        "processed_frames": processed,
        "output_video": str(output_video_path) if output_video_path else None,
        "detections_logged": len(speed_obj.logged_ids) if speed_obj else 0,
        "video_fps": vfps,
        "resize": [target_w, new_h],
        "vehicles": manifest_out,
    }


def open_capture_for_live(source: str) -> cv2.VideoCapture:
    """Open a USB camera index (0, 1, …) or network stream (rtsp / http mjpeg)."""
    from .live_camera import open_capture_for_live as _open

    return _open(source)


def analyze_live_stream(
    source: str,
    args: argparse.Namespace,
    *,
    stop_event: threading.Event,
    output_video_path: Path | None = None,
    progress_callback: Callable[[int, int], Any] | None = None,
    phase_callback: Callable[[str], Any] | None = None,
    prefer_fast_encoder: bool = False,
    preview_jpeg_callback: Callable[[bytes], Any] | None = None,
    preview_stream_fps: float = 12.0,
    preview_jpeg_quality: int = 78,
    manifest_callback: Callable[[list[dict[str, Any]]], Any] | None = None,
    show_window: bool | None = None,
    always_on: bool = False,
    health_callback: Callable[[dict[str, Any]], None] | None = None,
    skip_preview_warmup: bool = False,
) -> dict[str, Any]:
    """
    Live plate + speed analysis from a local camera index or RTSP/HTTP stream.
    When always_on is True, reconnects automatically until stop_event is set.
    """
    from .live_camera import normalize_live_source
    from .live_segment_writer import SegmentedVideoWriter
    from .video_writer_util import even_size, open_video_writer

    source = normalize_live_source(source)
    from .dahua_camera import is_dahua_alias

    model_path = _require_yolo_weights()
    stride = max(1, args.stride)
    total_inference_est = 1_000_000_000
    low_src = source.lower()
    # Auto-reconnect for continuous sources, honoring the global kill-switch so
    # operators can disable it (e.g. for debugging) via LIVE_AUTO_RECONNECT=false.
    reconnect = bool(getattr(settings, "LIVE_AUTO_RECONNECT", True)) and (
        bool(always_on)
        or source.isdigit()
        or low_src.startswith("rtsp")
        or is_dahua_alias(source)
    )
    # Easy4IP relay / RTSP-tunnel sources need a gentler reconnect cadence: each
    # RTSP open consumes the camera's single cloud relay slot, and hammering it
    # degrades the relay. Start the backoff higher so failed opens space out and
    # let the device recover (LAN/USB sources keep the snappy default).
    _relay_like = is_dahua_alias(source) or low_src.startswith("rtsp")
    _reconnect_base = (
        max(8.0, float(settings.LIVE_RECONNECT_BASE_SEC))
        if _relay_like
        else float(settings.LIVE_RECONNECT_BASE_SEC)
    )
    reconnect_delay = _reconnect_base
    reconnect_count = 0
    session_started = time.monotonic()
    processed_total = 0
    manifest_out: list[dict[str, Any]] = []
    segment_names: list[str] = []

    _notify_phase(
        phase_callback,
        "Loading YOLO + EasyOCR… (first run 30-90 s; preview starts once models are ready)",
    )

    use_warmup_handoff = (
        source.isdigit()
        and preview_jpeg_callback is not None
        and not skip_preview_warmup
    )
    camera_handoff: dict[str, Any] = {
        "cap": None,
        "opened": False,
        "open_failed": False,
        "keep_open": False,
        "w0": 1280,
        "h0": 720,
        "vfps": 30.0,
    }
    preview_geom: dict[str, Any] = {"target_w": None, "new_h": None}

    w0, h0, vfps = 1280, 720, 30.0
    camera_ok = True

    # Easy4IP relay / RTSP-tunnel sources degrade under session churn (every RTSP
    # open consumes the camera's single cloud relay slot). A throw-away probe just
    # to read the frame size would DOUBLE the sessions created at startup and can
    # wedge the relay, so skip it: open the real capture once (below) and derive
    # the geometry from its first frame instead. Frames are resized to the work
    # size regardless of the source resolution, so defaults are safe meanwhile.
    skip_probe = is_dahua_alias(source) or low_src.startswith("rtsp")

    if not use_warmup_handoff and not skip_probe:
        probe = open_capture_for_live(source)
        camera_ok = probe.isOpened()
        if camera_ok:
            w0 = max(1, int(probe.get(cv2.CAP_PROP_FRAME_WIDTH)))
            h0 = max(1, int(probe.get(cv2.CAP_PROP_FRAME_HEIGHT)))
            vfps = float(args.fps) if args.fps and args.fps > 0 else float(probe.get(cv2.CAP_PROP_FPS) or 0.0)
        probe.release()

        if source.isdigit() and not camera_ok:
            raise RuntimeError(
                "Could not open the PC/laptop camera. Close Zoom/Teams/Camera app, "
                "allow Windows camera permission for Python, then try again (or use index 1)."
            )
    elif skip_probe and args.fps and args.fps > 0:
        vfps = float(args.fps)

    if vfps < 1.0 or vfps > 240.0:
        vfps = 30.0

    target_w, new_h = _compute_work_size(w0, h0, args.width, live_anpr=True)
    preview_geom["target_w"] = target_w
    preview_geom["new_h"] = new_h
    roi_y = max(1, min(new_h - 2, int(round(args.roi_y_at_500h * new_h / 500))))
    region_points = [(0, roi_y), (target_w - 1, roi_y)]

    preview_warmup_stop = threading.Event()

    def _raw_camera_preview_loop() -> None:
        """Show webcam frames while YOLO/OCR models load (30-90 s first run)."""
        cap = None
        try:
            if preview_jpeg_callback is None or stop_event.is_set():
                return
            cap = open_capture_for_live(source)
            if not cap.isOpened():
                camera_handoff["open_failed"] = True
                return
            cw = max(1, int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)))
            ch = max(1, int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)))
            cfps = float(args.fps) if args.fps and args.fps > 0 else float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
            camera_handoff["w0"] = cw
            camera_handoff["h0"] = ch
            if cfps >= 1.0 and cfps <= 240.0:
                camera_handoff["vfps"] = cfps
            camera_handoff["cap"] = cap
            camera_handoff["opened"] = True
            _notify_phase(phase_callback, "PC camera open — loading AI models…")
            interval = 1.0 / 10.0
            gate = 0.0
            while not preview_warmup_stop.is_set() and not stop_event.is_set():
                ret, frame = cap.read()
                if not ret:
                    time.sleep(0.05)
                    continue
                now = time.monotonic()
                if now - gate >= interval:
                    gate = now
                    try:
                        tw = preview_geom.get("target_w")
                        nh = preview_geom.get("new_h")
                        if tw and nh:
                            frame = cv2.resize(frame, (int(tw), int(nh)))
                        ok, buf = cv2.imencode(
                            ".jpg",
                            frame,
                            [int(cv2.IMWRITE_JPEG_QUALITY), max(50, min(90, int(preview_jpeg_quality)))],
                        )
                        if ok:
                            preview_jpeg_callback(buf.tobytes())
                            if health_callback:
                                health_callback({
                                    "stream_connected": True,
                                    "message": "Camera preview active — loading models…",
                                    "last_frame_at": datetime.now(UTC).isoformat(),
                                })
                    except Exception:
                        pass
                time.sleep(0.01)
        finally:
            if cap is not None and not camera_handoff.get("keep_open"):
                cap.release()

    preview_thread: threading.Thread | None = None
    if use_warmup_handoff:
        preview_thread = threading.Thread(
            target=_raw_camera_preview_loop,
            name="visionflow-live-preview-warmup",
            daemon=True,
        )
        preview_thread.start()
        deadline = time.monotonic() + 10.0
        while time.monotonic() < deadline:
            if camera_handoff["opened"] or camera_handoff["open_failed"]:
                break
            time.sleep(0.05)
        if camera_handoff["open_failed"] or not camera_handoff["opened"]:
            preview_warmup_stop.set()
            if preview_thread is not None:
                preview_thread.join(timeout=3.0)
            raise RuntimeError(
                "Could not open the PC/laptop camera. Close Zoom/Teams/Camera app, "
                "allow Windows camera permission for Python, then try again (or use index 1)."
            )
        w0 = int(camera_handoff["w0"])
        h0 = int(camera_handoff["h0"])
        vfps = float(camera_handoff["vfps"])
        if vfps < 1.0 or vfps > 240.0:
            vfps = 30.0
        target_w, new_h = _compute_work_size(w0, h0, args.width, live_anpr=True)
        preview_geom["target_w"] = target_w
        preview_geom["new_h"] = new_h
        roi_y = max(1, min(new_h - 2, int(round(args.roi_y_at_500h * new_h / 500))))
        region_points = [(0, roi_y), (target_w - 1, roi_y)]

    try:
        speed_obj = SpeedEstimator(
            region=region_points,
            model=str(model_path),
            line_width=2,
            show=False,
            conf=args.conf,
            iou=args.iou,
            verbose=False,
        )
    finally:
        camera_handoff["keep_open"] = bool(
            use_warmup_handoff and camera_handoff.get("cap") is not None
        )
        preview_warmup_stop.set()
        if preview_thread is not None:
            preview_thread.join(timeout=5.0)
        if not camera_handoff.get("keep_open"):
            time.sleep(0.85)
    _notify_phase(phase_callback, "AI models ready — opening camera…")
    speed_obj._save_without_speed = getattr(args, "save_without_speed", False)
    speed_obj._vid_fps = vfps
    speed_obj._vid_fps_store = vfps
    speed_obj._proc_stride = float(stride)
    speed_obj._ocr_interval = max(1, int(getattr(args, "ocr_interval", 2)))
    speed_obj._min_ocr_conf = min(1.0, max(0.0, float(getattr(args, "min_ocr_conf", 0.28))))
    speed_obj._meter_per_pixel = max(1e-6, float(args.meter_per_pixel))
    speed_obj._max_speed_kmh = max(1.0, float(args.max_speed))
    speed_obj._speed_smooth = min(1.0, max(0.05, float(args.speed_smooth)))
    _proc_fps = max(1.0, vfps / float(max(1, stride)))
    speed_obj._exit_grace_frames = max(6, int(round(_proc_fps * float(settings.PLATE_EXIT_GRACE_SEC))))

    if show_window is None:
        show_window = os.environ.get("HEADLESS", "").strip() not in ("1", "true", "yes")

    segment_writer: SegmentedVideoWriter | None = None
    legacy_writer = None
    out_fps = max(8.0, min(60.0, vfps / float(stride)))
    size = even_size((target_w, new_h))
    segment_seconds = max(60.0, float(settings.LIVE_SEGMENT_MINUTES) * 60.0)
    recording_note = ""

    if output_video_path is not None:
        _notify_phase(phase_callback, "Preparing live recorder…")
        if output_video_path.suffix.lower() == ".mp4":
            output_video_path.parent.mkdir(parents=True, exist_ok=True)
            legacy_writer, actual = open_video_writer(
                output_video_path,
                fps=out_fps,
                size=size,
                prefer_fast_encoder=prefer_fast_encoder,
            )
            if legacy_writer is None:
                recording_note = "Recording disabled — no compatible video codec on this machine."
                _notify_phase(phase_callback, recording_note)
            else:
                output_video_path = actual
        else:
            segment_writer = SegmentedVideoWriter(
                output_video_path,
                fps=out_fps,
                size=size,
                segment_seconds=segment_seconds,
                prefer_fast_encoder=prefer_fast_encoder,
            )

    health_state: dict[str, Any] = {"last_frame_at": None}

    from . import stream_governor

    gv_key = source  # already normalized — same key the resolver registers

    def _push_health(
        *, connected: bool, message: str = "", frame_ok: bool = False, idle: bool = False,
        anpr: dict[str, Any] | None = None,
    ) -> None:
        if frame_ok:
            health_state["last_frame_at"] = datetime.now(UTC).isoformat()
        if health_callback is None:
            return
        payload: dict[str, Any] = {
            "stream_connected": connected,
            "reconnect_count": reconnect_count,
            "uptime_sec": round(time.monotonic() - session_started, 1),
            "processed_frames": processed_total,
            "segments": list(segment_names),
            "message": message,
            "last_frame_at": health_state["last_frame_at"],
            "idle": idle,
            "stream_tier": (
                stream_governor.active_tier(gv_key)
                if stream_governor.is_adaptive(gv_key)
                else None
            ),
        }
        if anpr:
            payload["anpr"] = anpr
        health_callback(payload)

    def _on_detections(max_width_frac: float, count: int) -> None:
        stream_governor.note_detection(gv_key, max_width_frac=max_width_frac, count=count)

    def _interrupt_check() -> str | None:
        """Governor-driven loop interrupts: SD<->HD switch or idle power-save."""
        # P2P relay / Dahua cloud tunnel: one RTSP client only — never idle or tier-switch.
        if is_dahua_alias(source) or low_src.startswith("rtsp"):
            return None
        if not stream_governor.is_adaptive(gv_key):
            return None
        if stream_governor.wants_tier_switch(gv_key):
            return "tier"
        if stream_governor.should_idle(gv_key):
            return "idle"
        return None

    def _idle_watch() -> str:
        """Power save: the cloud stream is released; sample a single frame on an
        adaptive interval (cached HLS URL — no API calls) and run detection on
        it. Wakes on a vehicle, a viewer opening the camera wall, or stop.
        Returns the wake reason: "vehicle" | "viewer" | "stop"."""
        stream_governor.set_idle(gv_key, True)
        base = max(5.0, float(getattr(settings, "LIVE_IDLE_SAMPLE_BASE_SEC", 30.0)))
        interval_max = max(base, float(getattr(settings, "LIVE_IDLE_SAMPLE_MAX_SEC", 300.0)))
        interval = base
        try:
            while not stop_event.is_set():
                _push_health(
                    connected=False,
                    idle=True,
                    message=f"Power save — vehicle check every {interval:.0f}s",
                )
                _notify_phase(
                    phase_callback,
                    f"Power save — next vehicle check in {interval:.0f}s…",
                )
                # Sleep in short slices so a viewer wakes the stream instantly.
                deadline = time.monotonic() + interval
                while time.monotonic() < deadline:
                    if stop_event.wait(1.0):
                        return "stop"
                    if stream_governor.has_recent_viewer(gv_key):
                        return "viewer"

                frame = None
                try:
                    scap = open_capture_for_live(source)
                    try:
                        if scap.isOpened():
                            s_deadline = time.monotonic() + 12.0
                            while time.monotonic() < s_deadline and not stop_event.is_set():
                                ok, f = scap.read()
                                if ok and f is not None:
                                    frame = f
                                    break
                                time.sleep(0.1)
                    finally:
                        scap.release()
                except Exception:
                    frame = None
                if stop_event.is_set():
                    return "stop"

                if frame is not None:
                    try:
                        native_w = int(getattr(speed_obj, "_native_w", 0) or 0)
                        work = _resize_for_inference(frame, target_w, new_h, native_w=native_w)
                        _sema = _get_inference_semaphore()
                        if _sema is not None:
                            _sema.acquire()
                        try:
                            result = speed_obj.estimate_speed(work)
                        finally:
                            if _sema is not None:
                                _sema.release()
                        # Keep the camera-wall tile fresh even while idle.
                        if preview_jpeg_callback is not None:
                            ok, buf = cv2.imencode(
                                ".jpg", result, [int(cv2.IMWRITE_JPEG_QUALITY), 70]
                            )
                            if ok:
                                preview_jpeg_callback(buf.tobytes())
                        boxes = speed_obj.boxes
                        n_boxes = len(boxes) if boxes is not None else 0
                        if n_boxes:
                            max_wf = 0.0
                            for b in boxes:
                                x1, _, x2, _ = map(float, b[:4])
                                max_wf = max(max_wf, (x2 - x1) / float(max(1, target_w)))
                            stream_governor.note_detection(
                                gv_key, max_width_frac=max_wf, count=n_boxes
                            )
                            return "vehicle"
                    except Exception:
                        pass
                interval = min(interval_max, interval * 1.5)
        finally:
            stream_governor.set_idle(gv_key, False)
        return "stop"

    def _writer_for_loop():
        if segment_writer is not None:
            return segment_writer if segment_writer.recording_enabled else None
        return legacy_writer

    def _health_pulse() -> None:
        note = recording_note
        if segment_writer is not None and segment_writer.last_error:
            note = segment_writer.last_error
        try:
            anpr = speed_obj.get_live_anpr_stats()
        except Exception:
            anpr = {}
        _push_health(connected=True, frame_ok=True, message=note or "", anpr=anpr)

    def _on_prune(est: SpeedEstimator) -> None:
        est.prune_memory()

    if progress_callback:
        progress_callback(0, total_inference_est)

    handed_cap: cv2.VideoCapture | None = None
    if use_warmup_handoff and camera_handoff.get("cap") is not None:
        handed_cap = camera_handoff["cap"]
        camera_handoff["cap"] = None

    noframe_streak = 0
    _imou_quota_retries = 0
    while not stop_event.is_set():
        open_msg = "Opening PC / laptop camera…" if source.isdigit() else "Opening camera / stream…"
        _notify_phase(phase_callback, open_msg)
        # Wipe stale detection anchors before each (re)connect — the SpeedEstimator
        # is long-lived for plate history, but box coordinates from the old angle
        # must not be replayed against the new stream.
        speed_obj.reset_detection_state()
        if handed_cap is not None:
            cap = handed_cap
            handed_cap = None
            for _ in range(4):
                cap.grab()
        else:
            cap = open_capture_for_live(source)
        if not cap.isOpened():
            try:
                from .dahua_camera import (
                    _camera_cfg_for_id,
                    _connection_mode,
                    dahua_id_from_source,
                    is_dahua_alias,
                    switch_dahua_to_cloud_hls,
                )

                if is_dahua_alias(source):
                    _fail_cfg = _camera_cfg_for_id(dahua_id_from_source(source))
                    if _fail_cfg and _connection_mode(_fail_cfg) == "cartrack_cloud":
                        if switch_dahua_to_cloud_hls(source, prefer_sd=True):
                            _notify_phase(
                                phase_callback,
                                "CarTrack tunnel unavailable — switching to Imou cloud stream…",
                            )
                            cap = open_capture_for_live(source)
            except Exception:
                pass
        if not cap.isOpened():
            if not reconnect:
                if low_src.startswith("rtsp"):
                    raise RuntimeError(
                        "Could not open the Dahua RTSP stream. In Settings use Same Wi-Fi (LAN), "
                        "enter the IP from DMSS, click Test RTSP, then start Panel 1 with dahua-hero-a1."
                    )
                raise RuntimeError(f"Could not open source: {source!r}")
            reconnect_count += 1
            _push_health(connected=False, message=f"Reconnecting ({reconnect_count})…")
            _notify_phase(phase_callback, f"Stream unavailable — retry in {reconnect_delay:.0f}s…")
            if stop_event.wait(reconnect_delay):
                break
            reconnect_delay = min(
                reconnect_delay * 1.6,
                float(settings.LIVE_RECONNECT_MAX_SEC),
            )
            continue

        reconnect_delay = _reconnect_base
        # Probe actual stream resolution (SD vs HD) and size inference canvas.
        # Cloud HLS cold-start can take 10–20s for the first media segment —
        # don't declare "no frames" after a 2-second poke.
        _probe_got_frame = False
        _quota_retry = False
        _consecutive_quota_frames = 0
        _probe_deadline = time.monotonic() + (20.0 if not source.isdigit() else 5.0)
        while time.monotonic() < _probe_deadline:
            _ok, _probe_frame = cap.read()
            if _ok and _probe_frame is not None:
                try:
                    from .dahua_camera import (
                        _camera_cfg_for_id,
                        _connection_mode,
                        dahua_id_from_source,
                        force_cloud_sd_for_source,
                        hls_frame_is_quota_error,
                        is_dahua_alias,
                        switch_dahua_to_cloud_hls,
                    )

                    _cid_cfg = _camera_cfg_for_id(dahua_id_from_source(source)) if is_dahua_alias(source) else None
                    if (
                        _cid_cfg
                        and _connection_mode(_cid_cfg) == "cloud_hls"
                        and hls_frame_is_quota_error(_probe_frame)
                    ):
                        _consecutive_quota_frames += 1
                        if _consecutive_quota_frames < 3:
                            time.sleep(0.15)
                            continue
                        cap.release()
                        _imou_quota_retries += 1
                        prefer_hd = bool(_cid_cfg.get("openapi_prefer_hd", True))
                        if _imou_quota_retries <= 3 and prefer_hd:
                            force_cloud_sd_for_source(source)
                            _notify_phase(
                                phase_callback,
                                "Imou cloud quota low — switching to SD stream. "
                                "Recharge at open.imoulife.com if video stays blank.",
                            )
                        elif _imou_quota_retries <= 5:
                            try:
                                from .dahua_camera import recreate_dahua_cloud_live

                                recreate_dahua_cloud_live(source)
                            except Exception:
                                pass
                            _notify_phase(
                                phase_callback,
                                "Imou video quota issue — refreshing cloud session…",
                            )
                        else:
                            raise RuntimeError(
                                "Imou cloud video quota is exhausted. Close DMSS live view on "
                                "other devices, stop this panel, and restart — or recharge at "
                                "open.imoulife.com."
                            )
                        _quota_retry = True
                        break
                    _consecutive_quota_frames = 0
                except RuntimeError:
                    raise
                except Exception:
                    pass
                _probe_got_frame = True
                h0, w0 = _probe_frame.shape[:2]
                _vf = float(args.fps) if args.fps and args.fps > 0 else float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
                if _vf >= 1.0 and _vf <= 240.0:
                    vfps = _vf
                target_w, new_h = _compute_work_size(w0, h0, args.width, live_anpr=True)
                preview_geom["target_w"] = target_w
                preview_geom["new_h"] = new_h
                _low = _is_low_res_source(w0, h0)
                speed_obj._native_w = int(w0)
                speed_obj._native_h = int(h0)
                speed_obj._live_low_res = _low
                _tier = stream_governor.active_tier(gv_key).upper()
                _hint = " — full YOLO/OCR on SD (LANCZOS upscale)" if _low else ""
                _notify_phase(
                    phase_callback,
                    f"Live ANPR · {_tier} stream {w0}×{h0} → {target_w}px{_hint}",
                )
                break
            time.sleep(0.05)

        if _quota_retry:
            continue

        if not _probe_got_frame:
            # Playlist opened but no media frames — cloud session is likely dead.
            # First strike: drop the cached HLS URL (cheap). Repeated strikes:
            # destroy + re-create the cloud live session (the persistent live
            # address can serve errorcode segments forever otherwise).
            noframe_streak += 1
            try:
                from .dahua_camera import invalidate_dahua_cloud_cache, recreate_dahua_cloud_live

                invalidate_dahua_cloud_cache(source)
                if noframe_streak >= 2:
                    _notify_phase(phase_callback, "Cloud live session stuck — re-creating…")
                    recreate_dahua_cloud_live(source)
                    noframe_streak = 0
            except Exception:
                pass
        else:
            noframe_streak = 0

        start_msg = recording_note or "Live analysis running…"
        _notify_phase(phase_callback, start_msg)
        _push_health(connected=True, message="Stream connected")

        loop_ctl: dict[str, Any] = {}
        processed, manifest_out = _run_tracking_loop(
            cap,
            speed_obj,
            target_w=target_w,
            new_h=new_h,
            stride=stride,
            vfps=vfps,
            total_inference_est=total_inference_est,
            writer=_writer_for_loop(),
            preview_jpeg_callback=preview_jpeg_callback,
            preview_stream_fps=preview_stream_fps,
            preview_jpeg_quality=preview_jpeg_quality,
            manifest_callback=manifest_callback,
            progress_callback=progress_callback,
            show_window=bool(show_window),
            max_frames=0,
            stop_event=stop_event,
            live_mode=True,
            health_pulse=_health_pulse,
            on_prune=_on_prune,
            on_detections=_on_detections,
            interrupt_check=_interrupt_check,
            loop_ctl=loop_ctl,
        )
        cap.release()
        processed_total += processed
        if segment_writer is not None:
            segment_names = list(segment_writer.segment_names)

        if stop_event.is_set():
            break

        break_reason = loop_ctl.get("break_reason")
        if break_reason == "tier":
            # Hybrid SD/HD: reconnect immediately — the resolver hands back the
            # governor-preferred tier's (cached or freshly bound) HLS URL.
            want = stream_governor.preferred_tier(gv_key).upper()
            _notify_phase(phase_callback, f"Switching stream quality → {want}…")
            _push_health(connected=False, message=f"Switching to {want} stream…")
            reconnect_delay = _reconnect_base
            continue
        if break_reason == "idle":
            wake = _idle_watch()
            if wake == "stop" or stop_event.is_set():
                break
            stream_governor.note_activity(gv_key)
            _notify_phase(
                phase_callback,
                "Vehicle detected — resuming live stream…"
                if wake == "vehicle"
                else "Viewer connected — resuming live stream…",
            )
            reconnect_delay = _reconnect_base
            continue

        if not reconnect:
            break

        reconnect_count += 1
        _push_health(connected=False, message=f"Stream lost — reconnecting ({reconnect_count})…")
        _notify_phase(phase_callback, f"Stream interrupted — reconnect in {reconnect_delay:.0f}s…")
        if stop_event.wait(reconnect_delay):
            break
        reconnect_delay = min(
            reconnect_delay * 1.6,
            float(settings.LIVE_RECONNECT_MAX_SEC),
        )

    if segment_writer is not None:
        segment_writer.close()
        segment_names = list(segment_writer.segment_names)
    if legacy_writer is not None:
        legacy_writer.release()
    if show_window:
        cv2.destroyAllWindows()

    try:
        speed_obj.finalize_all_sessions()
        manifest_out = speed_obj.get_vehicle_manifest()
        if manifest_callback:
            manifest_callback(manifest_out)
    except Exception:
        pass

    latest_out = segment_names[-1] if segment_names else (
        str(output_video_path) if output_video_path and output_video_path.suffix.lower() == ".mp4" else None
    )

    return {
        "processed_frames": processed_total,
        "output_video": latest_out,
        "output_segments": segment_names,
        "detections_logged": len(speed_obj.logged_ids) if speed_obj else 0,
        "video_fps": vfps,
        "resize": [target_w, new_h],
        "vehicles": manifest_out,
        "reconnect_count": reconnect_count,
        "always_on": always_on,
    }
