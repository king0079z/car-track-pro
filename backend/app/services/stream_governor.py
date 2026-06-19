"""
Adaptive stream governor — the brain of cloud-quota-aware live streaming.

Cloud HLS cameras (Imou/Easy4IP Open Platform) bill two scarce resources:
interface requests (API calls) and media flow (GB streamed). This module keeps
per-source runtime state so the live engine can:

  1. Hybrid SD/HD: run the lightweight SD sub-stream by default and escalate
     to the HD main stream only while a vehicle (plate) is actually in frame,
     then drop back to SD after a hold period. ~4-8x less media flow.
  2. Idle / wake (power save): when nothing has been detected and nobody is
     watching, the engine tears the stream down and samples a single frame on
     an adaptive interval. A detection (or a viewer opening the camera wall)
     wakes the stream instantly.

State is keyed by the normalized live source string (e.g. ``dahua://cam-1``),
which both the resolver (dahua_camera) and the engine (visionflow_engine) know.
Only sources explicitly registered by the resolver as cloud-adaptive take part;
USB/LAN-RTSP sources are never throttled.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Any

from ..config import settings

_TIER_SD = "sd"
_TIER_HD = "hd"


@dataclass
class _SourceState:
    adaptive: bool = False          # registered cloud source (tier + idle eligible)
    allow_hd: bool = True           # camera config permits the HD main stream
    active_tier: str = _TIER_SD     # tier of the currently open connection
    tier_since: float = field(default_factory=time.monotonic)
    last_detection: float = 0.0     # last time a plate/vehicle was in frame
    last_close_detection: float = 0.0  # last detection big enough to want HD
    last_viewer: float = 0.0        # last time a human fetched a preview frame
    idle: bool = False
    registered_at: float = field(default_factory=time.monotonic)


_LOCK = threading.Lock()
_STATE: dict[str, _SourceState] = {}


def _get(source: str) -> _SourceState:
    with _LOCK:
        st = _STATE.get(source)
        if st is None:
            st = _SourceState()
            _STATE[source] = st
        return st


def _saver_enabled() -> bool:
    return bool(getattr(settings, "STREAM_SAVER_ENABLED", True))


# ── Registration (called by the source resolver) ─────────────────────────────

def register_cloud_source(source: str, *, allow_hd: bool = True) -> None:
    """Mark a live source as a cloud HLS camera eligible for adaptive control."""
    if not source:
        return
    st = _get(source)
    with _LOCK:
        if not st.adaptive:
            # Fresh registration: treat "now" as activity so a newly started
            # camera streams normally before any idle decision is made.
            st.last_detection = time.monotonic()
        st.adaptive = True
        st.allow_hd = bool(allow_hd)


def register_relay_source(source: str) -> None:
    """P2P/Easy4IP relay tunnel — one RTSP client only; no idle/tier reconnect churn."""
    if not source:
        return
    st = _get(source)
    with _LOCK:
        st.adaptive = False
        st.last_detection = time.monotonic()


def is_adaptive(source: str) -> bool:
    if not _saver_enabled():
        return False
    with _LOCK:
        st = _STATE.get(source)
        return bool(st and st.adaptive)


# ── Tier control (hybrid SD/HD) ──────────────────────────────────────────────

def set_active_tier(source: str, tier: str) -> None:
    st = _get(source)
    with _LOCK:
        if st.active_tier != tier:
            st.active_tier = tier
            st.tier_since = time.monotonic()


def active_tier(source: str) -> str:
    with _LOCK:
        st = _STATE.get(source)
        return st.active_tier if st else _TIER_SD


def preferred_tier(source: str) -> str:
    """Tier the next (re)connect should use. SD is the quota-friendly default;
    HD while a vehicle was seen recently, someone is watching the camera wall
    (ANPR needs readable pixels), or during the post-start warmup window."""
    if not _saver_enabled() or not bool(getattr(settings, "STREAM_HYBRID_ENABLED", True)):
        return _TIER_HD  # legacy behaviour: camera config decides via prefer_hd
    st = _get(source)
    hold = max(10.0, float(getattr(settings, "STREAM_HD_HOLD_SEC", 90.0)))
    warmup = max(60.0, float(getattr(settings, "STREAM_ANPR_WARMUP_HD_SEC", 180.0)))
    with _LOCK:
        if not st.allow_hd:
            return _TIER_SD
        # Camera wall open → use main stream so YOLO/OCR match uploaded-video quality.
        if st.last_viewer and (time.monotonic() - st.last_viewer) <= max(
            5.0, float(getattr(settings, "LIVE_VIEWER_HOLD_SEC", 45.0))
        ):
            return _TIER_HD
        if (time.monotonic() - st.registered_at) <= warmup:
            return _TIER_HD
        if st.last_close_detection and (time.monotonic() - st.last_close_detection) <= hold:
            return _TIER_HD
        return _TIER_SD


def wants_tier_switch(source: str) -> bool:
    """True when the engine should reconnect to flip SD<->HD (with hysteresis)."""
    if not is_adaptive(source) or not bool(getattr(settings, "STREAM_HYBRID_ENABLED", True)):
        return False
    st = _get(source)
    dwell = max(10.0, float(getattr(settings, "STREAM_TIER_MIN_DWELL_SEC", 45.0)))
    with _LOCK:
        in_tier_for = time.monotonic() - st.tier_since
    if in_tier_for < dwell:
        return False
    return preferred_tier(source) != active_tier(source)


# ── Activity + viewer tracking ───────────────────────────────────────────────

def note_detection(source: str, *, max_width_frac: float = 0.0, count: int = 0) -> None:
    """Engine calls this after each processed frame with the largest plate box
    width as a fraction of frame width. Any detection counts as activity; a
    detection wider than STREAM_HD_ESCALATE_WIDTH_FRAC requests HD quality."""
    st = _get(source)
    now = time.monotonic()
    escalate_at = float(getattr(settings, "STREAM_HD_ESCALATE_WIDTH_FRAC", 0.0))
    with _LOCK:
        if count > 0:
            st.last_detection = now
            if max_width_frac >= escalate_at:
                st.last_close_detection = now


def note_activity(source: str) -> None:
    """Generic activity marker (e.g. on wake) so idle does not re-trigger instantly."""
    st = _get(source)
    with _LOCK:
        st.last_detection = time.monotonic()


def note_viewer(source: str) -> None:
    """Router calls this whenever a client pulls a preview frame for the source."""
    if not source:
        return
    st = _get(source)
    with _LOCK:
        st.last_viewer = time.monotonic()


def boost_anpr_session(source: str, *, allow_hd: bool = True) -> None:
    """Grid start / camera-wall open: force HD warmup and treat as active ANPR."""
    if not source:
        return
    st = _get(source)
    now = time.monotonic()
    with _LOCK:
        st.adaptive = True
        st.allow_hd = bool(allow_hd)
        st.registered_at = now
        st.last_viewer = now
        st.last_detection = now
        st.idle = False


def has_recent_viewer(source: str) -> bool:
    st = _get(source)
    hold = max(5.0, float(getattr(settings, "LIVE_VIEWER_HOLD_SEC", 45.0)))
    with _LOCK:
        return bool(st.last_viewer and (time.monotonic() - st.last_viewer) <= hold)


# ── Idle / wake (power save) ─────────────────────────────────────────────────

def should_idle(source: str) -> bool:
    """True when the engine should release the cloud stream and switch to
    low-frequency frame sampling: no detections for LIVE_IDLE_AFTER_SEC and no
    recent viewer."""
    if not is_adaptive(source) or not bool(getattr(settings, "LIVE_IDLE_ENABLED", True)):
        return False
    if has_recent_viewer(source):
        return False
    # SD sub-stream: keep full-frame ANPR running (no 2–5 min power-save gaps).
    if not bool(getattr(settings, "LIVE_IDLE_ON_SD", False)):
        st = _get(source)
        with _LOCK:
            if st.active_tier == _TIER_SD:
                return False
    st = _get(source)
    after = max(30.0, float(getattr(settings, "LIVE_IDLE_AFTER_SEC", 240.0)))
    with _LOCK:
        anchor = max(st.last_detection, st.registered_at)
        return (time.monotonic() - anchor) > after


def set_idle(source: str, idle: bool) -> None:
    st = _get(source)
    with _LOCK:
        st.idle = bool(idle)


def is_idle(source: str) -> bool:
    with _LOCK:
        st = _STATE.get(source)
        return bool(st and st.idle)


def forget(source: str) -> None:
    """Drop state for a source (camera removed / session permanently stopped)."""
    with _LOCK:
        _STATE.pop(source, None)


def snapshot() -> dict[str, dict[str, Any]]:
    """Diagnostic view of governor state (for health endpoints / debugging)."""
    now = time.monotonic()
    out: dict[str, dict[str, Any]] = {}
    with _LOCK:
        for src, st in _STATE.items():
            out[src] = {
                "adaptive": st.adaptive,
                "allow_hd": st.allow_hd,
                "active_tier": st.active_tier,
                "idle": st.idle,
                "sec_since_detection": round(now - st.last_detection, 1) if st.last_detection else None,
                "sec_since_viewer": round(now - st.last_viewer, 1) if st.last_viewer else None,
            }
    return out
