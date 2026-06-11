"""
Dahua Easy4IP / P2P cloud tunnel for CarTrack (DMSS-style remote access).

Runs the vendored dh-p2p script locally; RTSP clients connect to 127.0.0.1:<port>
and traffic is relayed to the camera via Dahua's cloud (serial number required).
"""

from __future__ import annotations

import logging
import os
import signal
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
    "PTCP device sign timed out",
    "PTCP sign response invalid",
    "Error:",
    "timed out",
    "Device requires authentication",
    "AssertionError",
    "Traceback",
    "HTTP 404",
    "404: Not Found",
)
_PROGRESS_MARKERS = (
    ("ready", _READY_MARKER),
    ("relay", "relay media mode active"),
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


# Per-attempt ready timeouts. Relay reaches "Ready to connect" in a few seconds;
# direct hole-punch must be bounded because a partial STUN reply can otherwise
# wedge the PTCP handshake for minutes. On timeout the subprocess is terminated.
_RELAY_READY_TIMEOUT = 30.0
_DIRECT_READY_TIMEOUT = 40.0


def _relay_cooldown_sec() -> float:
    """Minimum gap between tearing down and re-establishing the Easy4IP media
    relay session for a given device.

    The camera exposes a *single* relay slot via Dahua's cloud. Re-opening it
    immediately after a teardown (which is exactly what a reconnect storm does)
    makes the cloud refuse the new session — the device then reports "never
    ready" until it ages out the stale slot. Waiting a few seconds lets the slot
    release so the next attempt actually connects. Tune with
    DAHUA_P2P_RELAY_COOLDOWN_SEC (0 disables).
    """
    try:
        return max(0.0, float(os.environ.get("DAHUA_P2P_RELAY_COOLDOWN_SEC") or 8.0))
    except (TypeError, ValueError):
        return 8.0


def _relay_max_tries() -> int:
    """How many times to retry the relay (with cooldown) before giving up /
    falling back to direct. The relay handshake is intermittently flaky, so a
    couple of cooled-down retries turn a ~40% single-shot success into a
    near-certain connect. Tune with DAHUA_P2P_RELAY_TRIES."""
    try:
        return max(1, int(os.environ.get("DAHUA_P2P_RELAY_TRIES") or 3))
    except (TypeError, ValueError):
        return 3


def _direct_fallback_enabled() -> bool:
    """Try direct UDP hole-punch after relay retries are exhausted.

    On a cloud VPS the camera is behind NAT/CGNAT so direct almost never works
    and just burns ~40s per attempt. Default OFF; set DAHUA_P2P_DIRECT_FALLBACK=1
    to re-enable (e.g. when the server can reach the camera's public UDP port).
    """
    val = (os.environ.get("DAHUA_P2P_DIRECT_FALLBACK") or "0").strip().lower()
    return val in ("1", "true", "yes", "on")


# Per-serial timestamp (monotonic) of the last relay-session teardown, so the
# next relay attempt can wait out the cooldown before re-establishing.
_relay_teardown_at: dict[str, float] = {}
_relay_teardown_lock = threading.Lock()


def _note_relay_teardown(serial: str) -> None:
    with _relay_teardown_lock:
        _relay_teardown_at[serial.strip().upper()] = time.monotonic()


def _wait_relay_cooldown(serial: str) -> None:
    cooldown = _relay_cooldown_sec()
    if cooldown <= 0:
        return
    key = serial.strip().upper()
    with _relay_teardown_lock:
        last = _relay_teardown_at.get(key)
    if last is None:
        return
    remaining = cooldown - (time.monotonic() - last)
    if remaining > 0:
        _log.info(
            "Dahua P2P %s: relay cooldown — waiting %.1fs for device to release its relay slot",
            serial,
            remaining,
        )
        time.sleep(remaining)


def _relay_fallback_enabled() -> bool:
    """Auto media-relay fallback when direct P2P fails (default on).

    Set DAHUA_P2P_RELAY_FALLBACK=0 to disable (direct-only).
    """
    val = (os.environ.get("DAHUA_P2P_RELAY_FALLBACK") or "1").strip().lower()
    return val not in ("0", "false", "no", "off")


def _prefer_relay() -> bool:
    """Try the Easy4IP media relay BEFORE direct hole-punch (default on).

    On a cloud server the camera is almost always behind NAT/CGNAT, so direct
    UDP rarely works and just wastes ~40s per attempt; relay is fast and reliable
    (it is what DMSS falls back to). Set DAHUA_P2P_PREFER_RELAY=0 to try direct
    first (e.g. when the server shares the camera's LAN).
    """
    val = (os.environ.get("DAHUA_P2P_PREFER_RELAY") or "1").strip().lower()
    return val not in ("0", "false", "no", "off")


class DahuaP2PTunnelManager:
    """One P2P tunnel subprocess per serial (Hero A1 / DH-H3A)."""

    def __init__(self, *, default_local_port: int = _DEFAULT_LOCAL_PORT) -> None:
        self._lock = threading.Lock()
        self._proc: subprocess.Popen | None = None
        self._serial: str = ""
        self._local_port: int = int(default_local_port)
        self._lan_fallback: str = ""
        self._last_error: str = ""
        self._started_at: float = 0.0
        self._p2p_ready = False
        self._stdout_tail: list[str] = []
        self._reader_stop = threading.Event()
        self._ready_event = threading.Event()
        self._reader_thread: threading.Thread | None = None
        # Per-manager start lock so multiple cameras' tunnels can start in parallel.
        self._ensure_lock = threading.Lock()

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
            serial = self._serial
            had_proc = self._proc is not None and self._proc.poll() is None
            self._terminate_locked()
        # Note teardown outside the lock so the next relay attempt waits out the
        # cooldown (the device needs time to free its single relay slot).
        if had_proc and serial:
            _note_relay_teardown(serial)

    def start_background(
        self,
        *,
        serial: str,
        username: str,
        password: str,
        local_port: int = _DEFAULT_LOCAL_PORT,
        lan_fallback: str = "",
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
                    lan_fallback=lan_fallback,
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
        lan_fallback: str = "",
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
        if lan_fallback:
            self._lan_fallback = str(lan_fallback)

        # One start at a time per camera (prewarm + UI + status must not kill each other).
        with self._ensure_lock:
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

            # dtype 1 = authenticated (DH-H3A / 2023+ firmware); 0 = legacy.
            salt_dtypes = (1,) if device_salt else (1, 0)

            # Build the attempt plan. Each entry is (relay?, dtype). Relay (the
            # Easy4IP media relay, DMSS-style) works through NAT/CGNAT and is the
            # reliable path on a cloud server; direct hole-punch is a latency
            # optimization that usually fails server-side. Default order: relay
            # first, then direct as a fallback.
            relay_enabled = _relay_fallback_enabled()
            relay_round = [(True, dt) for dt in salt_dtypes]
            direct_round = [(False, dt) for dt in salt_dtypes]
            relay_tries = _relay_max_tries()
            attempts: list[tuple[bool, int]] = []
            if _prefer_relay() and relay_enabled:
                # Relay is the only reliable path through NAT/CGNAT on a cloud
                # server. It is also intermittently flaky on the first shot, so
                # retry it (with a cooldown between attempts) before wasting time
                # on direct hole-punch.
                for _ in range(relay_tries):
                    attempts += relay_round
                if _direct_fallback_enabled():
                    attempts += direct_round
            else:
                attempts += direct_round
                if relay_enabled:
                    for _ in range(relay_tries):
                        attempts += relay_round

            _log.info(
                "Dahua P2P %s: plan=%s salt=%s",
                serial,
                ["relay" if r else "direct" for r, _ in attempts],
                bool(device_salt),
            )
            for relay, dtype in attempts:
                kind = "relay" if relay else "direct"
                _log.info("Dahua P2P %s: trying %s (dtype=%s)…", serial, kind, dtype)
                result = self._start_once(
                    serial=serial,
                    username=user,
                    password=password,
                    local_port=port,
                    dtype=dtype,
                    device_randsalt=device_salt,
                    relay=relay,
                    ready_timeout=(
                        _RELAY_READY_TIMEOUT if relay else _DIRECT_READY_TIMEOUT
                    ),
                )
                if result.get("ok"):
                    result["dtype"] = dtype
                    result["device_randsalt"] = bool(device_salt)
                    result["transport"] = kind
                    _log.info(
                        "Dahua P2P %s: READY via %s (dtype=%s) on 127.0.0.1:%s",
                        serial,
                        kind,
                        dtype,
                        port,
                    )
                    return result
                _log.info(
                    "Dahua P2P %s: %s attempt failed: %s",
                    serial,
                    kind,
                    (result.get("detail") or result.get("error") or "")[:120],
                )
                last_detail = result.get("detail") or result.get("error") or last_detail
                # _start_once already terminates a failed attempt; just make sure
                # nothing dead lingers. Use _terminate_locked (NOT stop) — we may
                # be holding no lock here, and stop() would re-acquire it; calling
                # the locked variant directly keeps the contract explicit.
                with self._lock:
                    if self._proc is not None and self._proc.poll() is not None:
                        self._terminate_locked()
                # A password rejection won't be fixed by another transport/dtype.
                if "DevPwd_InvalidDigest" in last_detail:
                    break
                if "DevPwd_InvalidSalt" in last_detail and device_salt:
                    break
                # The camera is offline in Dahua's cloud (the p2p server has no
                # live registration for this serial → /probe/device 404). No
                # transport/dtype can fix that; bail fast so the caller backs off
                # and retries later (it will connect the moment the camera is back
                # online). Avoids ~48s of pointless relay churn per call.
                if "HTTP 404" in last_detail or "404: Not Found" in last_detail:
                    _log.info(
                        "Dahua P2P %s: device offline in cloud (404) — aborting attempts",
                        serial,
                    )
                    last_detail = "DEVICE_OFFLINE_404 " + last_detail
                    break

        err_text = last_detail or ""
        salt_ok = bool(device_salt) or "Using device RandSalt" in err_text
        if "DEVICE_OFFLINE_404" in err_text or "HTTP 404" in err_text:
            return {
                "ok": False,
                "error": (
                    "Camera is offline in Dahua's cloud (Easy4IP). The system will keep "
                    "retrying and connect automatically once it is back online. Check the "
                    "camera in DMSS — if it shows offline there too, power-cycle the camera "
                    "and confirm its Wi-Fi / internet at the site."
                ),
                "detail": last_detail,
                "error_code": "DEVICE_OFFLINE",
            }
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
                # Let the reader thread drain any final stdout (e.g. a Traceback
                # printed just before exit) so the failure detail reflects the
                # real cause instead of an earlier benign line ("Listening on …").
                rt = self._reader_thread
                if rt is not None and rt.is_alive():
                    rt.join(timeout=1.5)
                break
            time.sleep(0.25)
        with self._lock:
            tail = "".join(self._stdout_tail[-24:])
            marker_err = self._last_error if any(
                m in self._last_error for m in _ERROR_MARKERS
            ) else ""
            self._last_error = marker_err or (tail[-800:] if tail else "P2P still connecting.")
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
        relay: bool = False,
        ready_timeout: float = 180.0,
    ) -> dict[str, Any]:
        # Let the device release its single relay slot before re-establishing it
        # (done outside the lock so status() stays responsive while we wait).
        if relay:
            _wait_relay_cooldown(serial)
        with self._lock:
            if relay and self._proc is not None and self._proc.poll() is None:
                # We are about to replace a live relay subprocess — record the
                # teardown so the cooldown above applies to the *next* attempt.
                _note_relay_teardown(serial)
            self._terminate_locked()
            # Reap any orphaned tunnel still holding this port + the device's single
            # relay slot (e.g. a previously crashed subprocess). Without this the
            # bind() below fails with "address already in use" and the relay handshake
            # is starved — the root cause of the connect/fail churn.
            _reap_orphan_tunnels(local_port)

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
            if relay:
                # Easy4IP media-relay path (DMSS-style) for cameras behind NAT/CGNAT
                # where direct UDP hole-punch (STUN) cannot complete.
                cmd.append("--relay")
            env = os.environ.copy()
            env["P2P_QUIET"] = "1"
            # The runner prints non-ASCII progress (… —); force UTF-8 on both ends
            # so the stdout reader thread never dies on a decode error (which would
            # make us miss the "Ready to connect" marker and hang the full timeout).
            env["PYTHONIOENCODING"] = "utf-8"
            if device_randsalt:
                env["P2P_DEVICE_RANDSALT"] = device_randsalt
            else:
                env.pop("P2P_DEVICE_RANDSALT", None)
            try:
                if self._lan_fallback:
                    env["P2P_LAN_FALLBACK"] = self._lan_fallback
                else:
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
                    encoding="utf-8",
                    errors="replace",
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

        result = self._wait_until_ready(proc, timeout_sec=ready_timeout)
        if not result.get("ok"):
            # Terminate a failed/hung attempt so it cannot linger (a partial STUN
            # reply can otherwise keep the direct subprocess alive for minutes)
            # and so the next attempt can rebind the local port.
            with self._lock:
                if self._proc is proc:
                    self._terminate_locked()
            # A failed relay attempt still consumed (and now releases) the
            # device's relay slot — start the cooldown so the next relay try
            # waits for the cloud to free it.
            if relay:
                _note_relay_teardown(serial)
        return result

    def _read_stdout(self, proc: subprocess.Popen) -> None:
        try:
            if proc.stdout is None:
                return
            # Use readline (not `for line in proc.stdout`) so each flushed line is
            # delivered immediately — the iterator's read-ahead buffer can otherwise
            # withhold lines (incl. "Ready to connect") until the pipe buffer fills.
            for line in iter(proc.stdout.readline, ""):
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
                    was_ready = self._p2p_ready
                    if not self._p2p_ready:
                        tail = "".join(self._stdout_tail[-8:]).strip()
                        if tail and not self._last_error:
                            self._last_error = tail[-400:]
                        if not self._last_error:
                            self._last_error = f"P2P process exited (code {proc.returncode})"
                exit_tail = "".join(self._stdout_tail[-6:]).strip().replace("\n", " | ")
                _log.info(
                    "Dahua P2P %s: subprocess pid=%s exited code=%s was_ready=%s tail=%s",
                    self._serial,
                    getattr(proc, "pid", "?"),
                    proc.returncode,
                    was_ready,
                    exit_tail[-300:],
                )
        except Exception as exc:
            with self._lock:
                self._last_error = str(exc)

    def _terminate_locked(self) -> None:
        self._reader_stop.set()
        if self._proc is not None and self._proc.poll() is None:
            _log.info(
                "Dahua P2P %s: terminating tunnel pid=%s (was_ready=%s)",
                self._serial,
                getattr(self._proc, "pid", "?"),
                self._p2p_ready,
            )
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


_pool: dict[str, DahuaP2PTunnelManager] = {}
_pool_lock = threading.Lock()


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
    except (Exception, SystemExit) as exc:
        _log.warning("Could not fetch device RandSalt for %s: %s", serial, exc)
        return None


def get_p2p_tunnel_manager(
    serial: str | None = None,
    *,
    local_port: int = _DEFAULT_LOCAL_PORT,
) -> DahuaP2PTunnelManager:
    """Return the tunnel manager for a serial (one subprocess + port per camera).

    With no serial, resolves the legacy hero-a1 camera's serial so the existing
    ``/dahua/hero-a1/*`` endpoints and the new multi-camera pool share one
    manager instance for that device.
    """
    key = (serial or "").strip().upper()
    if not key:
        try:
            from .dahua_camera import dahua_hero_a1_config

            key = str(dahua_hero_a1_config().get("device_serial") or "").strip().upper()
        except Exception:
            key = ""
    with _pool_lock:
        mgr = _pool.get(key)
        if mgr is None:
            mgr = DahuaP2PTunnelManager(default_local_port=local_port)
            _pool[key] = mgr
        return mgr


def all_tunnel_managers() -> dict[str, DahuaP2PTunnelManager]:
    with _pool_lock:
        return dict(_pool)


def _port_listening(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", int(port)), timeout=0.4):
            return True
    except OSError:
        return False


def _reap_orphan_tunnels(local_port: int, *, keep_pid: int | None = None) -> int:
    """Kill orphaned main_p2p subprocesses bound to ``local_port`` (Linux only).

    A crashed/abandoned tunnel that still holds the local RTSP port AND the
    device's single Easy4IP relay slot makes every fresh attempt fail at bind()
    and starves the relay handshake (the cloud won't open a second session).
    Reaping them before we spawn a new tunnel is what stops the connect/fail churn.
    Best-effort and silent on non-Linux (no /proc) or insufficient permissions.
    """
    proc_root = "/proc"
    if not os.path.isdir(proc_root):
        return 0
    needle = f"--local-port {int(local_port)}"
    killed = 0
    for entry in os.listdir(proc_root):
        if not entry.isdigit():
            continue
        pid = int(entry)
        if keep_pid is not None and pid == keep_pid:
            continue
        try:
            with open(f"{proc_root}/{entry}/cmdline", "rb") as fh:
                cmd = fh.read().replace(b"\x00", b" ").decode(errors="replace")
        except OSError:
            continue
        if "main_p2p" in cmd and needle in cmd:
            try:
                os.kill(pid, signal.SIGKILL)
                killed += 1
                _log.info("Dahua P2P: reaped orphan tunnel pid=%s on port %s", pid, local_port)
            except OSError:
                pass
    if killed:
        time.sleep(0.5)
    return killed
