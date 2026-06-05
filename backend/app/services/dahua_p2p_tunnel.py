"""
Dahua Easy4IP / P2P cloud tunnel for CarTrack (DMSS-style remote access).

Runs the vendored dh-p2p script locally; RTSP clients connect to 127.0.0.1:<port>
and traffic is relayed to the camera via Dahua's cloud (serial number required).
"""

from __future__ import annotations

import logging
import os
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

_log = logging.getLogger(__name__)

_VENDOR_DIR = Path(__file__).resolve().parents[2] / "vendor" / "dh_p2p"
_RUNNER = _VENDOR_DIR / "main_p2p.py"
_DEFAULT_LOCAL_PORT = 18554
_READY_MARKER = "Ready to connect"
_AUTH_OK_MARKERS = (_READY_MARKER,)
_ERROR_MARKERS = (
    "DevPwd_InvalidSalt",
    "DevPwd_InvalidDigest",
    "DevPwd_",
    "Timeout occurred",
    "Error:",
    "timed out",
    "Device requires authentication",
    "AssertionError",
    "Traceback",
)
_PROGRESS_MARKERS = (
    ("ready", _READY_MARKER),
    ("relay", "negotiating PTCP"),
    ("relay", "relay agent connected"),
    ("stun", "STUN hole-punch"),
    ("stun", "device responded to STUN"),
    ("auth", "Using device RandSalt"),
    ("starting", "Listening on"),
)
_ENSURE_LOCK = threading.Lock()
_CLOUD_API_LOCK = threading.Lock()
_SALT_CACHE: dict[str, tuple[str, float]] = {}
_SALT_TTL_SEC = 300.0


class DahuaP2PTunnelManager:
    """One P2P tunnel subprocess per serial (Hero A1 / DH-H3A)."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._proc: subprocess.Popen | None = None
        self._serial: str = ""
        self._local_port: int = _DEFAULT_LOCAL_PORT
        self._last_error: str = ""
        self._started_at: float = 0.0
        self._p2p_ready = False
        self._stdout_tail: list[str] = []
        self._reader_stop = threading.Event()
        self._ready_event = threading.Event()
        self._reader_thread: threading.Thread | None = None

    def status(self) -> dict[str, Any]:
        with self._lock:
            alive = self._proc is not None and self._proc.poll() is None
            port_open = alive and _port_listening(self._local_port)
            ready = bool(alive and self._p2p_ready and port_open)
            tail = "".join(self._stdout_tail[-16:])
            phase = "idle"
            if alive and ready:
                phase = "ready"
            elif not alive and self._last_error:
                phase = "failed"
            elif alive:
                for name, marker in reversed(_PROGRESS_MARKERS):
                    if marker in tail:
                        phase = name
                        break
            phase_message = {
                "idle": None,
                "starting": "Starting cloud tunnel process…",
                "auth": "Cloud login OK — fetching device keys…",
                "relay": "Relay / PTCP handshake with Easy4IP…",
                "stun": "UDP/STUN to camera (needs outbound UDP; can take 1–3 min)…",
                "ready": "Tunnel ready — RTSP on 127.0.0.1",
                "failed": (self._last_error or "Cloud tunnel failed")[:240],
            }.get(phase)
            return {
                "running": ready,
                "port_listening": port_open,
                "p2p_ready": self._p2p_ready,
                "phase": phase,
                "phase_message": phase_message,
                "serial": self._serial or None,
                "local_port": self._local_port,
                "local_rtsp_host": "127.0.0.1",
                "last_error": self._last_error or None,
                "log_tail": tail or None,
                "uptime_sec": round(time.time() - self._started_at, 1) if self._started_at and alive else 0,
            }

    def stop(self) -> None:
        with self._lock:
            self._terminate_locked()

    def start_background(
        self,
        *,
        serial: str,
        username: str,
        password: str,
        local_port: int = _DEFAULT_LOCAL_PORT,
    ) -> dict[str, Any]:
        """Start P2P setup in a background thread; poll ``status()`` until phase is ready or failed."""
        serial = (serial or "").strip().upper()
        if not serial:
            return {"ok": False, "error": "Device serial (SN from QR) is required for cloud mode."}
        if not password:
            return {"ok": False, "error": "Device password is required for cloud P2P."}
        st = self.status()
        if st.get("running"):
            return {"ok": True, "started": False, "reused": True, "status": st}
        if st.get("phase") in ("starting", "auth", "relay", "stun") and st.get("serial") == serial:
            return {"ok": True, "started": False, "already_connecting": True, "status": st}

        def _worker() -> None:
            try:
                self.ensure_running(
                    serial=serial,
                    username=username,
                    password=password,
                    local_port=local_port,
                )
            except Exception as exc:
                _log.warning("Background P2P start failed: %s", exc)

        threading.Thread(target=_worker, daemon=True, name="dahua-p2p-start").start()
        time.sleep(0.35)
        return {"ok": True, "started": True, "status": self.status()}

    def ensure_running(
        self,
        *,
        serial: str,
        username: str,
        password: str,
        local_port: int = _DEFAULT_LOCAL_PORT,
    ) -> dict[str, Any]:
        """Start P2P tunnel; tries authenticated (dtype=1) then legacy (dtype=0)."""
        serial = (serial or "").strip().upper()
        if not serial:
            return {"ok": False, "error": "Device serial (SN from QR) is required for cloud mode."}
        if not _RUNNER.is_file():
            return {"ok": False, "error": "P2P tunnel runner missing (vendor/dh_p2p)."}
        if not password:
            return {"ok": False, "error": "Device password is required for cloud P2P."}

        user = (username or "admin").strip() or "admin"
        if "@" in user:
            user = "admin"
        port = max(1024, min(65535, int(local_port)))

        # Only one cloud tunnel start at a time (prewarm + UI + status must not kill each other).
        with _ENSURE_LOCK:
            with self._lock:
                if (
                    self._proc is not None
                    and self._proc.poll() is None
                    and self._serial == serial
                    and self._local_port == port
                    and self._p2p_ready
                ):
                    return {"ok": True, "local_port": port, "reused": True}

            proc_to_wait = None
            with self._lock:
                proc = self._proc
                if (
                    proc is not None
                    and proc.poll() is None
                    and self._serial == serial
                    and self._local_port == port
                ):
                    proc_to_wait = proc

            # Never call _wait_until_ready while holding self._lock — status() must stay responsive.
            if proc_to_wait is not None:
                waited = self._wait_until_ready(proc_to_wait, timeout_sec=180.0)
                if waited.get("ok"):
                    return {"ok": True, "local_port": port, "reused": False, "waited": True}
                last_detail = waited.get("detail") or ""
                if proc_to_wait.poll() is None and not any(
                    m in last_detail for m in ("DevPwd_", "Error:", "Traceback")
                ):
                    return waited

            device_salt = _fetch_device_randsalt(serial)
            last_detail = ""
            dtypes = (1,) if device_salt else (1, 0)
            for dtype in dtypes:
                result = self._start_once(
                    serial=serial,
                    username=user,
                    password=password,
                    local_port=port,
                    dtype=dtype,
                    device_randsalt=device_salt,
                )
                if result.get("ok"):
                    result["dtype"] = dtype
                    result["device_randsalt"] = bool(device_salt)
                    return result
                last_detail = result.get("detail") or result.get("error") or last_detail
                with self._lock:
                    if self._proc is None or self._proc.poll() is not None:
                        self.stop()
                if "DevPwd_InvalidDigest" in last_detail:
                    break
                if "DevPwd_InvalidSalt" in last_detail and device_salt:
                    break

        err_text = last_detail or ""
        salt_ok = bool(device_salt) or "Using device RandSalt" in err_text
        if "DevPwd_InvalidDigest" in err_text:
            user_error = (
                "Cloud rejected the device password (DevPwd_InvalidDigest). "
                "In DMSS open the camera → Settings → Device password, confirm it matches CarTrack "
                "(admin + the password you set when adding the camera — not your DMSS email login)."
            )
        elif "DevPwd_InvalidSalt" in err_text and salt_ok:
            user_error = (
                "Wrong device password for cloud login (username must be admin). "
                "In DMSS open the camera, Settings, Device password, reset it, type the new password "
                "in CarTrack, click Save camera, then Start cloud tunnel. "
                "The QR security code is not the device password."
            )
        elif "DevPwd_InvalidSalt" in err_text:
            user_error = (
                "Cloud login rejected (DevPwd_InvalidSalt). Use username admin and the device "
                "password from DMSS device settings — not the QR security code (SC) or your DMSS email."
            )
        elif "403" in err_text and "Forbidden" in err_text:
            user_error = (
                "Cloud login forbidden — wrong device password or camera offline in DMSS. "
                "On the same Wi-Fi, switch to Same Wi-Fi (LAN IP) and use the IP from DMSS."
            )
        elif "Timeout occurred" in err_text or "STUN" in err_text.upper():
            user_error = (
                "Cloud authenticated but UDP/STUN to the camera timed out. Allow outbound UDP on this PC, "
                "or use Same Wi-Fi (LAN IP) with the IP from DMSS while on site."
            )
        elif "P2P process exited" in err_text or "Traceback" in err_text:
            user_error = (
                "Cloud tunnel process stopped during setup. Click Start cloud tunnel once and wait up to 3 minutes. "
                "If it keeps failing, use Same Wi-Fi (LAN IP) — your LAN test already works."
            )
        else:
            user_error = (
                "Cloud tunnel could not reach the camera. Confirm it shows online in DMSS, "
                "then verify admin + device password. If the PC is on the same Wi-Fi, use LAN mode instead."
            )
        err_code = None
        if "DevPwd_InvalidSalt" in err_text:
            err_code = "DevPwd_InvalidSalt"
        elif "DevPwd_InvalidDigest" in err_text:
            err_code = "DevPwd_InvalidDigest"
        elif "Timeout occurred" in err_text:
            err_code = "P2P_STUN_TIMEOUT"
        return {
            "ok": False,
            "error": user_error,
            "detail": last_detail,
            "error_code": err_code,
        }

    def _wait_until_ready(self, proc: subprocess.Popen, *, timeout_sec: float) -> dict[str, Any]:
        deadline = time.time() + timeout_sec
        while time.time() < deadline:
            with self._lock:
                if self._p2p_ready and _port_listening(self._local_port):
                    return {"ok": True}
            if self._ready_event.wait(timeout=0.5):
                with self._lock:
                    self._p2p_ready = True
                return {"ok": True}
            if proc.poll() is not None:
                break
            time.sleep(0.25)
        with self._lock:
            tail = "".join(self._stdout_tail[-24:])
            self._last_error = tail[-800:] if tail else "P2P still connecting."
        return {
            "ok": False,
            "error": (
                "Cloud tunnel is still setting up (UDP/STUN). Wait up to 3 minutes and refresh status, "
                "or use Same Wi-Fi (LAN IP) on site."
            ),
            "detail": self._last_error,
            "error_code": "P2P_STUN_TIMEOUT",
        }

    def _start_once(
        self,
        *,
        serial: str,
        username: str,
        password: str,
        local_port: int,
        dtype: int,
        device_randsalt: str | None = None,
    ) -> dict[str, Any]:
        with self._lock:
            self._terminate_locked()

            cmd = [
                sys.executable,
                str(_RUNNER),
                serial,
                "-t",
                str(int(dtype)),
                "-u",
                username,
                "-p",
                password,
                "--local-port",
                str(local_port),
                "-q",
            ]
            env = os.environ.copy()
            env["P2P_QUIET"] = "1"
            if device_randsalt:
                env["P2P_DEVICE_RANDSALT"] = device_randsalt
            else:
                env.pop("P2P_DEVICE_RANDSALT", None)
            try:
                from .dahua_camera import dahua_hero_a1_config

                lan_host = str(dahua_hero_a1_config().get("host") or "").strip()
                lan_port = int(dahua_hero_a1_config().get("rtsp_port") or 554)
                if lan_host:
                    env["P2P_LAN_FALLBACK"] = f"{lan_host}:{lan_port}"
            except Exception:
                pass
            try:
                self._proc = subprocess.Popen(
                    cmd,
                    cwd=str(_VENDOR_DIR),
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    bufsize=1,
                    env=env,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
            except OSError as exc:
                self._last_error = str(exc)
                return {"ok": False, "error": f"Could not start P2P tunnel: {exc}"}

            self._serial = serial
            self._local_port = local_port
            self._started_at = time.time()
            self._last_error = ""
            self._p2p_ready = False
            self._stdout_tail = []
            self._reader_stop.clear()
            self._ready_event.clear()
            proc = self._proc
            self._reader_thread = threading.Thread(
                target=self._read_stdout,
                args=(proc,),
                daemon=True,
            )
            self._reader_thread.start()

        return self._wait_until_ready(proc, timeout_sec=180.0)

    def _read_stdout(self, proc: subprocess.Popen) -> None:
        try:
            if proc.stdout is None:
                return
            for line in proc.stdout:
                if self._reader_stop.is_set():
                    break
                with self._lock:
                    self._stdout_tail.append(line)
                    if len(self._stdout_tail) > 40:
                        self._stdout_tail = self._stdout_tail[-40:]
                if any(marker in line for marker in _AUTH_OK_MARKERS):
                    self._ready_event.set()
                if any(marker in line for marker in _ERROR_MARKERS):
                    with self._lock:
                        self._last_error = line.strip() if line.strip() else self._last_error
            if proc.poll() is not None:
                with self._lock:
                    if not self._p2p_ready:
                        tail = "".join(self._stdout_tail[-8:]).strip()
                        if tail and not self._last_error:
                            self._last_error = tail[-400:]
        except Exception as exc:
            with self._lock:
                self._last_error = str(exc)

    def _terminate_locked(self) -> None:
        self._reader_stop.set()
        self._p2p_ready = False
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
        self._serial = ""
        self._started_at = 0.0


def check_p2p_dependencies() -> str | None:
    """Return an error message if dh-p2p dependencies are missing."""
    try:
        import xmltodict  # noqa: F401
    except ImportError:
        return "Missing xmltodict — run: pip install -r backend/requirements.txt"
    if not _RUNNER.is_file():
        return "P2P tunnel runner missing (vendor/dh_p2p/main_p2p.py)."
    return None


_prewarm_started = False
_prewarm_lock = threading.Lock()


def prewarm_cloud_tunnel_async() -> None:
    """Start cloud P2P in background when camera is saved in cloud mode (DMSS-style)."""
    global _prewarm_started
    from .dahua_camera import _connection_mode, dahua_hero_a1_config

    cfg = dahua_hero_a1_config()
    if not cfg.get("enabled") or _connection_mode(cfg) not in ("p2p", "auto"):
        return
    serial = str(cfg.get("device_serial") or "").strip()
    password = str(cfg.get("password") or "")
    if not serial or not password:
        return
    if check_p2p_dependencies():
        return

    with _prewarm_lock:
        if _prewarm_started:
            return
        _prewarm_started = True

    def _run() -> None:
        time.sleep(20.0)
        try:
            mgr = get_p2p_tunnel_manager()
            st = mgr.status()
            if st.get("running"):
                return
            mgr.ensure_running(
                serial=serial,
                username=str(cfg.get("username") or "admin"),
                password=password,
                local_port=int(cfg.get("p2p_local_port") or 18554),
            )
        except Exception as exc:
            _log.warning("Background P2P prewarm failed: %s", exc)

    threading.Thread(target=_run, name="dahua-p2p-prewarm", daemon=True).start()


_manager: DahuaP2PTunnelManager | None = None
_manager_lock = threading.Lock()


def _fetch_device_randsalt(serial: str) -> str | None:
    """Load per-camera RandSalt from Easy4IP (required for DH-H3A cloud auth)."""
    serial = (serial or "").strip().upper()
    if not serial:
        return None
    now = time.time()
    try:
        from .dahua_camera import dahua_hero_a1_config

        cfg_salt = str(dahua_hero_a1_config().get("p2p_randsalt") or "").strip()
        if cfg_salt:
            _SALT_CACHE[serial] = (cfg_salt, now)
            return cfg_salt
    except Exception:
        pass
    with _CLOUD_API_LOCK:
        cached = _SALT_CACHE.get(serial)
        if cached and now - cached[1] < _SALT_TTL_SEC:
            return cached[0]

    vendor = str(_VENDOR_DIR)
    if vendor not in sys.path:
        sys.path.insert(0, vendor)
    try:
        from helpers import MAIN_PORT, MAIN_SERVER, UDP, extract_randsalt_from_info

        with _CLOUD_API_LOCK:
            main_remote = UDP(MAIN_SERVER, MAIN_PORT, debug=False, quiet=True)
            main_remote.request("/probe/p2psrv")
            res = main_remote.request(f"/online/p2psrv/{serial}")
            p2psrv_server, p2psrv_port = res["data"]["body"]["US"].split(":")
            p2psrv_remote = UDP(p2psrv_server, int(p2psrv_port), debug=False, quiet=True)
            p2psrv_remote.request(f"/probe/device/{serial}")
            res = p2psrv_remote.request(f"/info/device/{serial}")
            info_blob = res["data"]["body"]["Info"]
            salt = extract_randsalt_from_info(info_blob)
            if salt:
                _SALT_CACHE[serial] = (salt, now)
            return salt
    except Exception as exc:
        _log.warning("Could not fetch device RandSalt for %s: %s", serial, exc)
        return None


def get_p2p_tunnel_manager() -> DahuaP2PTunnelManager:
    global _manager
    with _manager_lock:
        if _manager is None:
            _manager = DahuaP2PTunnelManager()
        return _manager


def _port_listening(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", int(port)), timeout=0.4):
            return True
    except OSError:
        return False
