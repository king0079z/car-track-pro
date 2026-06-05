"""
CarTrack Cloud Relay — publish site LAN RTSP to *your* media server (not Dahua Easy4IP).

Requires a self-hosted relay (e.g. MediaMTX) on a VPS:
  - publish URL: where this PC pushes (rtsp://your-server:8554/site/cam)
  - view URL: where CarTrack reads for live ANPR (same path on the server)

The DH-H3A cannot stream to a custom cloud URL by itself; a PC on the same Wi-Fi
must read LAN RTSP and forward it (like a site gateway).
"""

from __future__ import annotations

import logging
import os
import subprocess
import sys
import threading
import time
from typing import Any

_log = logging.getLogger(__name__)


def _ffmpeg_exe() -> str | None:
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


class CartrackCloudRelayManager:
    """FFmpeg process: LAN RTSP in → RTSP/RTMP publish out."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._proc: subprocess.Popen | None = None
        self._publish_url = ""
        self._source_url = ""
        self._started_at = 0.0
        self._last_error = ""

    def status(self) -> dict[str, Any]:
        with self._lock:
            alive = self._proc is not None and self._proc.poll() is None
            return {
                "running": alive,
                "publish_url": self._publish_url or None,
                "source_url_masked": _mask_url(self._source_url) if self._source_url else None,
                "last_error": self._last_error or None,
                "uptime_sec": round(time.time() - self._started_at, 1) if self._started_at and alive else 0,
            }

    def stop(self) -> None:
        with self._lock:
            self._terminate_locked()

    def ensure_running(self, *, source_rtsp_url: str, publish_url: str) -> dict[str, Any]:
        source_rtsp_url = (source_rtsp_url or "").strip()
        publish_url = (publish_url or "").strip()
        if not source_rtsp_url.lower().startswith("rtsp"):
            return {"ok": False, "error": "LAN RTSP source URL is required (configure camera IP first)."}
        if not publish_url.lower().startswith(("rtsp://", "rtmp://", "rtsps://")):
            return {
                "ok": False,
                "error": "CarTrack relay publish URL must be rtsp:// or rtmp:// (your MediaMTX / server).",
            }

        ffmpeg = _ffmpeg_exe()
        if not ffmpeg:
            return {"ok": False, "error": "ffmpeg not available (install imageio-ffmpeg or add ffmpeg to PATH)."}

        with self._lock:
            if (
                self._proc is not None
                and self._proc.poll() is None
                and self._publish_url == publish_url
                and self._source_url == source_rtsp_url
            ):
                return {"ok": True, "reused": True, **self.status()}

            self._terminate_locked()
            cmd = [
                ffmpeg,
                "-hide_banner",
                "-loglevel",
                "warning",
                "-rtsp_transport",
                "tcp",
                "-i",
                source_rtsp_url,
                "-c",
                "copy",
            ]
            if publish_url.lower().startswith("rtmp"):
                cmd.extend(["-f", "flv", publish_url])
            else:
                cmd.extend(["-f", "rtsp", "-rtsp_transport", "tcp", publish_url])
            try:
                self._proc = subprocess.Popen(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
            except OSError as exc:
                self._last_error = str(exc)
                return {"ok": False, "error": f"Could not start relay: {exc}"}

            self._publish_url = publish_url
            self._source_url = source_rtsp_url
            self._started_at = time.time()
            self._last_error = ""

        time.sleep(2.5)
        with self._lock:
            if self._proc is None or self._proc.poll() is not None:
                err = self._drain_stderr()
                self._last_error = err
                return {
                    "ok": False,
                    "error": "CarTrack cloud relay stopped. Check publish URL and server firewall.",
                    "detail": err[:400],
                }
        return {"ok": True, **self.status()}

    def _drain_stderr(self) -> str:
        proc = self._proc
        if proc is None or proc.stdout is None:
            return ""
        try:
            return proc.stdout.read(4000) or ""
        except Exception:
            return ""

    def _terminate_locked(self) -> None:
        if self._proc is None:
            return
        try:
            self._proc.terminate()
            self._proc.wait(timeout=5)
        except Exception:
            try:
                self._proc.kill()
            except Exception:
                pass
        self._proc = None
        self._publish_url = ""
        self._source_url = ""
        self._started_at = 0.0


_manager: CartrackCloudRelayManager | None = None
_manager_lock = threading.Lock()


def get_cartrack_relay_manager() -> CartrackCloudRelayManager:
    global _manager
    with _manager_lock:
        if _manager is None:
            _manager = CartrackCloudRelayManager()
        return _manager


def _mask_url(url: str) -> str:
    if "@" not in url:
        return url[:120]
    pre, rest = url.split("@", 1)
    if ":" in pre:
        scheme, _, _user = pre.partition("://")
        return f"{scheme}://***:***@{rest[:80]}"
    return url[:120]


def relay_urls_from_config(cfg: dict[str, Any]) -> tuple[str, str]:
    """Return (publish_url, view_url) from camera config with optional env fallback."""
    from ..config import settings

    publish = str(cfg.get("cartrack_relay_publish_url") or "").strip()
    view = str(cfg.get("cartrack_relay_view_url") or "").strip()
    if not publish:
        publish = (os.environ.get("CARTRACK_RELAY_PUBLISH_URL") or getattr(settings, "CARTRACK_RELAY_PUBLISH_URL", "") or "").strip()
    if not view:
        view = (os.environ.get("CARTRACK_RELAY_VIEW_URL") or getattr(settings, "CARTRACK_RELAY_VIEW_URL", "") or "").strip()
    return publish, view
