"""
CarTrack Cloud Tunnel — reach the camera from your VPS with no shop PC.

Uses the vendored dh_p2p relay (same remote-view mechanism as DMSS). Requires:
  - Device serial + admin password (saved in Settings or DAHUA_* env)
  - Camera online on Dahua cloud (one-time Wi‑Fi setup when the camera was installed)

Does NOT use: Imou Life app at the shop, Easy4IP HLS/OpenAPI, or a site gateway PC.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any

_log = logging.getLogger(__name__)

_keeper_started = False
_keeper_lock = threading.Lock()


def is_cartrack_cloud_mode(cfg: dict[str, Any] | None = None) -> bool:
    from .dahua_camera import _connection_mode, dahua_hero_a1_config

    c = cfg if cfg is not None else dahua_hero_a1_config()
    return _connection_mode(c) == "cartrack_cloud"


def resolve_cartrack_cloud_rtsp(
    cfg: dict[str, Any],
    *,
    source_token: str | None = None,
    wait_sec: float = 45.0,
) -> str | None:
    """Start or reuse the cloud P2P tunnel; return localhost RTSP URL."""
    from .dahua_camera import _try_cloud_tunnel_rtsp

    username = str(cfg.get("username") or "admin")
    password = str(cfg.get("password") or "")
    stream = str(cfg.get("stream") or "sub")
    if not str(cfg.get("device_serial") or "").strip() or not password:
        return None
    return _try_cloud_tunnel_rtsp(
        cfg,
        username=username,
        password=password,
        stream=stream,
        wait_sec=wait_sec,
        source_token=source_token,
    )


def tunnel_status(cfg: dict[str, Any] | None = None) -> dict[str, Any]:
    from .dahua_camera import dahua_hero_a1_config
    from .dahua_p2p_tunnel import get_p2p_tunnel_manager

    c = cfg if cfg is not None else dahua_hero_a1_config()
    serial = str(c.get("device_serial") or "").strip().upper()
    port = int(c.get("p2p_local_port") or 18554)
    st: dict[str, Any] = {
        "mode": "cartrack_cloud",
        "configured": bool(serial and c.get("password")),
        "serial": serial or None,
    }
    if serial:
        st["tunnel"] = get_p2p_tunnel_manager(serial, local_port=port).status()
    else:
        st["tunnel"] = {}
    return st


def ensure_tunnel_running(cfg: dict[str, Any] | None = None) -> dict[str, Any]:
    from .dahua_camera import dahua_hero_a1_config
    from .dahua_p2p_tunnel import check_p2p_dependencies, get_p2p_tunnel_manager

    c = cfg if cfg is not None else dahua_hero_a1_config()
    if not c.get("enabled"):
        return {"ok": False, "error": "Camera is disabled in settings."}
    serial = str(c.get("device_serial") or "").strip().upper()
    password = str(c.get("password") or "")
    if not serial or not password:
        return {"ok": False, "error": "Device serial and password are required."}
    dep = check_p2p_dependencies()
    if dep:
        return {"ok": False, "error": dep}
    port = int(c.get("p2p_local_port") or 18554)
    mgr = get_p2p_tunnel_manager(serial, local_port=port)
    result = mgr.ensure_running(
        serial=serial,
        username=str(c.get("username") or "admin"),
        password=password,
        local_port=port,
        lan_fallback=_lan_fallback(c),
    )
    result["status"] = mgr.status()
    return result


def _lan_fallback(cfg: dict[str, Any]) -> str:
    host = str(cfg.get("host") or "").strip()
    if not host:
        return ""
    return f"{host}:{int(cfg.get('rtsp_port') or 554)}"


def start_cloud_tunnel_keeper_async() -> None:
    """Keep the CarTrack Cloud tunnel warm (24/7 VPS deploy)."""
    global _keeper_started
    with _keeper_lock:
        if _keeper_started:
            return
        _keeper_started = True

    def _loop() -> None:
        time.sleep(25.0)
        while True:
            try:
                from .dahua_camera import dahua_hero_a1_config

                cfg = dahua_hero_a1_config()
                if not cfg.get("enabled") or not is_cartrack_cloud_mode(cfg):
                    time.sleep(60.0)
                    continue
                from .dahua_p2p_tunnel import get_p2p_tunnel_manager

                serial = str(cfg.get("device_serial") or "").strip().upper()
                port = int(cfg.get("p2p_local_port") or 18554)
                st = get_p2p_tunnel_manager(serial, local_port=port).status()
                if not st.get("running") and st.get("phase") not in (
                    "starting",
                    "auth",
                    "relay",
                    "stun",
                ):
                    ensure_tunnel_running(cfg)
            except Exception as exc:
                _log.debug("CarTrack cloud tunnel keeper: %s", exc)
            time.sleep(45.0)

    threading.Thread(
        target=_loop,
        name="cartrack-cloud-tunnel-keeper",
        daemon=True,
    ).start()
