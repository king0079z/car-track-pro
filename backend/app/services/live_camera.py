"""Local USB / laptop webcam capture for live VisionFlow."""

from __future__ import annotations

import logging
import sys
import threading
from typing import Any

import cv2

_log = logging.getLogger(__name__)

# One lock per camera index — different USB cameras can run in parallel.
_usb_locks: dict[int, threading.Lock] = {}
_usb_locks_guard = threading.Lock()


def _lock_for_index(index: int) -> threading.Lock:
    with _usb_locks_guard:
        if index not in _usb_locks:
            _usb_locks[index] = threading.Lock()
        return _usb_locks[index]

_LOCAL_ALIASES = frozenset({
    "",
    "0",
    "default",
    "webcam",
    "local",
    "pc",
    "laptop",
    "usb",
    "camera",
    "builtin",
    "built-in",
})


def normalize_live_source(source: str | None) -> str:
    """
    Map empty / friendly names to the default PC camera index ``0``.
    RTSP/HTTP URLs and numeric indices pass through unchanged.
    Dahua Hero A1 aliases canonicalize to ``dahua-hero-a1`` without network I/O
    (dedupe / supervisor keys must not trigger LAN or P2P probes at startup).
    """
    s = (source or "").strip()
    low = s.lower()
    if low in _LOCAL_ALIASES:
        return "0"
    if s.isdigit():
        return s
    from .dahua_camera import HERO_A1_PROFILE, dahua_id_from_source, is_dahua_alias

    if is_dahua_alias(s):
        cam_id = dahua_id_from_source(s)
        if cam_id in (None, "hero-a1"):
            return str(HERO_A1_PROFILE["default_source_token"])
        return f"dahua://{cam_id}"
    return s


def is_local_camera_source(source: str) -> bool:
    s = normalize_live_source(source)
    return s.isdigit()


def local_camera_label(source: str) -> str:
    from .dahua_camera import HERO_A1_PROFILE, is_dahua_alias

    if is_dahua_alias(source):
        return HERO_A1_PROFILE["name"]
    s = normalize_live_source(source)
    if s == "0":
        return "PC camera (built-in / USB #0)"
    if s.isdigit():
        return f"USB camera #{s}"
    if s.startswith("rtsp"):
        return f"RTSP stream ({s[:48]}…)" if len(s) > 48 else f"RTSP: {s}"
    return source[:160]


class _ReleasingCapture:
    """Wraps VideoCapture and releases the per-index USB lock when ``release()`` is called."""

    def __init__(
        self,
        cap: cv2.VideoCapture,
        *,
        holds_usb_lock: bool,
        lock: threading.Lock | None = None,
    ) -> None:
        self._cap = cap
        self._holds_usb_lock = holds_usb_lock
        self._lock = lock
        self._released = False

    def read(self):
        return self._cap.read()

    def isOpened(self) -> bool:
        return self._cap.isOpened()

    def get(self, prop: int):
        return self._cap.get(prop)

    def set(self, prop: int, value) -> bool:
        return self._cap.set(prop, value)

    def release(self) -> None:
        if self._released:
            return
        self._released = True
        try:
            self._cap.release()
        finally:
            if self._holds_usb_lock and self._lock is not None:
                try:
                    self._lock.release()
                except RuntimeError:
                    pass

    def __getattr__(self, name: str):
        return getattr(self._cap, name)


def _usb_backends() -> list[int | None]:
    if sys.platform == "win32":
        return [cv2.CAP_DSHOW, cv2.CAP_MSMF, None]
    if sys.platform == "darwin":
        return [cv2.CAP_AVFOUNDATION, None]
    return [cv2.CAP_V4L2, None]


def _try_open_index(index: int, backend: int | None) -> cv2.VideoCapture | None:
    cap = cv2.VideoCapture(index, backend) if backend is not None else cv2.VideoCapture(index)
    if not cap.isOpened():
        cap.release()
        return None
    ret, _ = cap.read()
    if not ret:
        cap.release()
        return None
    _configure_usb_camera(cap)
    return cap


def _configure_usb_camera(cap: cv2.VideoCapture) -> None:
    try:
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    except Exception:
        pass
    try:
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
        cap.set(cv2.CAP_PROP_FPS, 30)
    except Exception:
        pass


def open_usb_camera(index: int = 0, *, strict_index: bool = True) -> cv2.VideoCapture:
    """
    Open a local webcam with an exclusive per-index lock.
    ``strict_index=True`` (default) opens exactly that index — required for multi-camera grids.
    """
    preferred = max(0, int(index))
    cam_lock = _lock_for_index(preferred)
    acquired = cam_lock.acquire(timeout=90.0)
    if not acquired:
        _log.warning("Timed out waiting for USB camera lock (index=%s)", preferred)
        return _ReleasingCapture(cv2.VideoCapture(), holds_usb_lock=False)

    raw_cap: cv2.VideoCapture | None = None
    try:
        for backend in _usb_backends():
            raw_cap = _try_open_index(preferred, backend)
            if raw_cap is not None:
                _log.info("USB camera opened: index=%s backend=%s", preferred, backend)
                return _ReleasingCapture(raw_cap, holds_usb_lock=True, lock=cam_lock)

        if not strict_index and preferred == 0:
            for alt in range(4):
                if alt == 0:
                    continue
                for backend in _usb_backends():
                    raw_cap = _try_open_index(alt, backend)
                    if raw_cap is not None:
                        _log.info(
                            "USB camera opened on alternate index=%s backend=%s", alt, backend
                        )
                        return _ReleasingCapture(raw_cap, holds_usb_lock=True, lock=cam_lock)

        _log.warning("Could not open USB camera index=%s", preferred)
        fallback = (
            cv2.VideoCapture(preferred, cv2.CAP_DSHOW)
            if sys.platform == "win32"
            else cv2.VideoCapture(preferred)
        )
        if fallback.isOpened():
            return _ReleasingCapture(fallback, holds_usb_lock=True, lock=cam_lock)
        fallback.release()
        cam_lock.release()
        return _ReleasingCapture(cv2.VideoCapture(), holds_usb_lock=False)
    except Exception:
        if raw_cap is not None:
            try:
                raw_cap.release()
            except Exception:
                pass
        try:
            cam_lock.release()
        except RuntimeError:
            pass
        raise


def open_capture_for_live(source: str, *, strict_index: bool = True) -> cv2.VideoCapture:
    """Open a USB camera index or network stream (RTSP / HTTP)."""
    from .dahua_camera import (
        dahua_hero_a1_config,
        invalidate_dahua_cloud_cache,
        is_dahua_alias,
        open_dahua_stream,
        resolve_dahua_source,
    )

    raw = (source or "").strip()
    s = normalize_live_source(source)
    dahua_token = raw if is_dahua_alias(raw) else (s if is_dahua_alias(s) else None)
    if dahua_token is not None:
        resolved = resolve_dahua_source(dahua_token)
        if not resolved:
            # Let analyze_live_stream's reconnect loop retry (P2P tunnel may still be starting).
            cap = cv2.VideoCapture()
            try:
                cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
            except Exception:
                pass
            return cap
        s = resolved
    if s.isdigit():
        return open_usb_camera(int(s), strict_index=strict_index)
    low = s.lower()
    if low.startswith("rtsp://") or low.startswith("rtsps://"):
        cfg = dahua_hero_a1_config()
        use_tcp = bool(cfg.get("use_tcp_transport", True))
        if is_dahua_alias(raw) or "/cam/realmonitor" in s:
            return open_dahua_stream(s, use_tcp=use_tcp)
        return open_dahua_stream(s, use_tcp=True)
    if low.startswith("http://") or low.startswith("https://"):
        # Cloud HLS (.m3u8) — open with the reconnect-tolerant FFmpeg options.
        cap = open_dahua_stream(s, use_tcp=True)
        if not cap.isOpened() and dahua_token is not None:
            # Cached URL may have expired server-side — drop it so the next
            # reconnect attempt fetches a fresh one from the API.
            invalidate_dahua_cloud_cache(dahua_token)
        return cap
    cap = cv2.VideoCapture(s)
    try:
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    except Exception:
        pass
    return cap


def probe_local_cameras(max_index: int = 4) -> list[dict[str, Any]]:
    """Return indices that successfully deliver at least one frame (sequential probe)."""
    found: list[dict[str, Any]] = []
    for idx in range(max(1, int(max_index))):
        cap: cv2.VideoCapture | None = None
        try:
            cap = open_usb_camera(idx, strict_index=True)
            if not cap.isOpened():
                continue
            w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
            h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
            fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
            found.append({"index": idx, "width": w, "height": h, "fps": fps})
        finally:
            if cap is not None:
                cap.release()
    return found
