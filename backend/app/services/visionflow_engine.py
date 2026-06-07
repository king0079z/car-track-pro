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


def _enhance_frame_for_detection(im0: np.ndarray) -> np.ndarray:
    """Boost local contrast so dark-background plates pop for YOLO."""
    lab = cv2.cvtColor(im0, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=2.2, tileGridSize=(8, 8))
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


# Minimum plate-box size accepted from the detector. These floors must stay
# small: on multi-lane / elevated footage a readable plate is only ~55-90 px
# wide at the 1020 px working width, and the previous floors (0.07*W ≈ 71 px)
# silently discarded ~50% of correctly detected plates (the farther cars),
# which is why many visible vehicles never reached the registry. The
# aspect-ratio gate (_is_plate_shaped_box) still rejects non-plate noise.
def _min_plate_area_for_frame(frame_h: int, frame_w: int) -> float:
    return max(450.0, float(frame_h * frame_w) * 0.0010)


def _min_plate_width_for_frame(frame_w: int) -> float:
    return max(30.0, float(frame_w) * 0.030)


def _min_plate_height_for_frame(frame_h: int) -> float:
    return max(10.0, float(frame_h) * 0.018)


_MAX_PLATE_VOTES = 24


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

        _imgsz = int(os.environ.get("TRACK_IMGSZ", "1280"))
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
        self._inst.extract_tracks(im0)
        self.boxes = self._inst.boxes
        self.track_ids = self._inst.track_ids or []
        self.clss = self._inst.clss or []
        self.tracks = getattr(self._inst, "tracks", None)

        if self.track_ids:
            return
        if self.tracks is None:
            return
        boxes_obj = self.tracks.boxes
        if boxes_obj is None or len(boxes_obj) == 0:
            return
        self.boxes = boxes_obj.xyxy.cpu()
        self.clss = boxes_obj.cls.int().cpu().tolist()
        self.track_ids = [-(i + 1) for i in range(len(self.clss))]

    def _filter_tiny_boxes(self, frame_h: int, frame_w: int) -> None:
        """Drop UI fragments / phone-screen noise — real plates are wide and large enough."""
        n = len(self.boxes) if self.boxes is not None else 0
        if n == 0:
            return
        min_area = _min_plate_area_for_frame(frame_h, frame_w)
        min_w = _min_plate_width_for_frame(frame_w)
        min_h = _min_plate_height_for_frame(frame_h)
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
        if self.boxes is None or len(self.boxes) == 0:
            return 0.0
        return max(_box_area(self.boxes[i]) for i in range(len(self.boxes)))

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

    def _extract_tracks_adaptive(self, im0: np.ndarray) -> None:
        """
        One tracker pass per frame (keeps BoT-SORT stable). Run an inverted pass only
        when normal detection finds nothing useful — typical for black commercial plates.
        """
        fh, fw = im0.shape[:2]
        min_area = _min_plate_area_for_frame(fh, fw)
        detect_im = _enhance_frame_for_detection(im0)
        self.extract_tracks(detect_im)
        self._filter_tiny_boxes(fh, fw)

        if self._largest_box_area() < min_area:
            self.extract_tracks(_enhance_inverted_for_detection(im0))
            self._filter_tiny_boxes(fh, fw)

        self._normalize_detection_state()

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
        plate = self._best_plate_for_track(track_id)
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
            **metrics_snapshot,
        })

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
        ):
            store.pop(track_id, None)
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
            row["plate"] = self._best_plate_for_track(tid)
            row["speed_kmh_avg"] = self._avg_speed_for_track(tid)
            if tid in self._sessions:
                row["status"] = "active"
            rows.append(row)

        archived = [dict(r) for r in self._completed_rows]
        seen_tids = {r.get("track_id") for r in rows}
        for r in archived:
            if r.get("track_id") not in seen_tids:
                rows.append(r)

        if not rows:
            active = []
            for tid, s in self._sessions.items():
                plate = self._best_plate_for_track(tid)
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
        else:
            self._enrich_manifest_ocr(rows)
            pre_rows = [dict(r) for r in rows]
            rows = _consolidate_manifest_rows(rows, now_sec=now_sec)

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
        if tid >= 0:
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
            # Median over a short window removes single-frame spikes from detection
            # jitter; the EMA then smooths the trend → steadier, more accurate speed.
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

        if tid >= 0:
            self._touch_session(tid, src_frame)
            self._last_seen_frame[tid] = self._proc_frame_no
            if tid in self.spd and tid in self._sessions:
                self._sessions[tid]["speed_peak"] = max(
                    int(self._sessions[tid].get("speed_peak", 0)), int(self.spd[tid])
                )
            self._registry_touch(tid, src_frame, active=True)

        fh, fw = im0.shape[:2]
        padded = _pad_box_for_ocr(box, fw, fh)
        x1b, y1b, x2b, y2b = padded
        cropped = np.array(im0)[y1b:y2b, x1b:x2b]

        self._ocr_tick[tid] = self._ocr_tick.get(tid, 0) + 1
        stride = self._ocr_stride_for_track(tid)
        has_prior = tid in self._last_ocr_text and bool(self._last_ocr_text.get(tid, "").strip())
        run_ocr = (
            cropped.size > 0
            and (
                tid < 0
                or not has_prior
                or (self._ocr_tick[tid] % stride == 0)
            )
            and (_is_plate_shaped_box(padded) or has_prior or tid < 0)
        )
        if run_ocr:
            ocr_text, ocr_conf = self.perform_ocr(cropped)
        else:
            ocr_text = self._last_ocr_text.get(tid, "")
            ocr_conf = 0.0

        if ocr_text.strip():
            formatted = format_qatar_plate(ocr_text.strip())
            if not formatted:
                formatted = ocr_text.strip()
            accepted = accept_plate_read(
                formatted,
                jurisdiction=self._plate_jurisdiction,
                strict=False,
            )
            if accepted:
                self._last_ocr_text[tid] = formatted
            if tid >= 0 and accepted:
                self._remember_plate(tid, formatted)
                min_c = float(getattr(self, "_min_ocr_conf", 0.25))
                if float(ocr_conf) >= min_c and accept_plate_read(
                    formatted,
                    jurisdiction=self._plate_jurisdiction,
                    strict=False,
                ):
                    bucket = self._plate_votes.setdefault(tid, [])
                    bucket.append((formatted, float(ocr_conf)))
                    if len(bucket) > _MAX_PLATE_VOTES:
                        self._plate_votes[tid] = bucket[-_MAX_PLATE_VOTES:]

        if draw:
            plate_show = (
                self._best_plate_for_track(tid)
                if tid >= 0
                else (vote_best_plate(self._plate_votes.get(tid, [])) or self._last_ocr_text.get(tid, "") or "…")
            )
            spd_show = f"{int(self.spd[tid])} km/h" if tid in self.spd else "— km/h"
            label = f"ID:{tid if tid >= 0 else 'det'} {plate_show} | {spd_show}"
            self.annotator.box_label(box, label=label, color=_LABEL_COLOR)

        class_name = self.names[int(cls)]
        speed = self.spd.get(tid)
        save_no_speed = getattr(self, "_save_without_speed", False)
        if (tid >= 0 and tid not in self.logged_ids and ocr_text.strip() and (speed is not None or save_no_speed)):
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


def _compute_work_size(w0: int, h0: int, target_width: int) -> tuple[int, int]:
    """
    Pick inference frame size. Portrait phone clips upscale the long edge so
    distant/small plates retain enough pixels for YOLO (never downscale native).
    """
    tw = max(320, int(target_width))
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
) -> tuple[int, list[dict[str, Any]]]:
    """
    Live camera loop: a reader thread keeps preview fresh while AI runs on strided frames.
    Prevents the feed freezing when YOLO/OCR is slow on CPU.
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

    try:
        while True:
            if stop_event is not None and stop_event.is_set():
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
            work = cv2.resize(frame.copy(), (target_w, new_h))
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

            if manifest_callback and processed % 2 == 0:
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

            frame = cv2.resize(frame, (target_w, new_h))
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

            if manifest_callback and processed % 2 == 0:
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
    target_w, new_h = _compute_work_size(w0, h0, args.width)
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
    reconnect_delay = float(settings.LIVE_RECONNECT_BASE_SEC)
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

    if not use_warmup_handoff:
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

    if vfps < 1.0 or vfps > 240.0:
        vfps = 30.0

    target_w, new_h = _compute_work_size(w0, h0, args.width)
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
        target_w, new_h = _compute_work_size(w0, h0, args.width)
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

    def _push_health(*, connected: bool, message: str = "", frame_ok: bool = False) -> None:
        if frame_ok:
            health_state["last_frame_at"] = datetime.now(UTC).isoformat()
        if health_callback is None:
            return
        health_callback({
            "stream_connected": connected,
            "reconnect_count": reconnect_count,
            "uptime_sec": round(time.monotonic() - session_started, 1),
            "processed_frames": processed_total,
            "segments": list(segment_names),
            "message": message,
            "last_frame_at": health_state["last_frame_at"],
        })

    def _writer_for_loop():
        if segment_writer is not None:
            return segment_writer if segment_writer.recording_enabled else None
        return legacy_writer

    def _health_pulse() -> None:
        note = recording_note
        if segment_writer is not None and segment_writer.last_error:
            note = segment_writer.last_error
        _push_health(connected=True, frame_ok=True, message=note or "")

    def _on_prune(est: SpeedEstimator) -> None:
        est.prune_memory()

    if progress_callback:
        progress_callback(0, total_inference_est)

    handed_cap: cv2.VideoCapture | None = None
    if use_warmup_handoff and camera_handoff.get("cap") is not None:
        handed_cap = camera_handoff["cap"]
        camera_handoff["cap"] = None

    while not stop_event.is_set():
        open_msg = "Opening PC / laptop camera…" if source.isdigit() else "Opening camera / stream…"
        _notify_phase(phase_callback, open_msg)
        if handed_cap is not None:
            cap = handed_cap
            handed_cap = None
            for _ in range(4):
                cap.grab()
        else:
            cap = open_capture_for_live(source)
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

        reconnect_delay = float(settings.LIVE_RECONNECT_BASE_SEC)
        start_msg = recording_note or "Live analysis running…"
        _notify_phase(phase_callback, start_msg)
        _push_health(connected=True, message="Stream connected")

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
        )
        cap.release()
        processed_total += processed
        if segment_writer is not None:
            segment_names = list(segment_writer.segment_names)

        if stop_event.is_set():
            break
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
