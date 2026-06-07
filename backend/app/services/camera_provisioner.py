"""Auto-provisioning for the multi-camera registry.

Turns a saved camera (Dahua Easy4IP/P2P cloud or generic RTSP/NVR) into a live
ANPR feed: starts its cloud tunnel when needed and registers a 24/7 live session
into its camera-wall slot. Called on add/connect (API) and for every enabled
camera at startup.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any

_log = logging.getLogger(__name__)

_provision_lock = threading.Lock()


def _pipeline_opts() -> dict[str, Any]:
    """Reuse the multi-camera (lighter) pipeline defaults from the visionflow router."""
    try:
        from ..routers.visionflow import _multi_cam_pipeline_opts

        return _multi_cam_pipeline_opts()
    except Exception:
        return {}


def _start_tunnel_if_needed(cam: dict[str, Any]) -> None:
    if str(cam.get("type")) != "dahua_p2p":
        return
    mode = str(cam.get("connection_mode") or "auto").lower()
    if mode not in ("p2p", "auto"):
        return
    serial = str(cam.get("device_serial") or "").strip()
    password = str(cam.get("password") or "")
    if not serial or not password:
        return
    from .dahua_p2p_tunnel import check_p2p_dependencies, get_p2p_tunnel_manager

    if check_p2p_dependencies():
        return
    local_port = int(cam.get("p2p_local_port") or 18554)
    lan_host = str(cam.get("host") or "").strip()
    lan_fallback = f"{lan_host}:{int(cam.get('rtsp_port') or 554)}" if lan_host else ""
    get_p2p_tunnel_manager(serial, local_port=local_port).start_background(
        serial=serial,
        username=str(cam.get("username") or "admin"),
        password=password,
        local_port=local_port,
        lan_fallback=lan_fallback,
    )


def session_id_for(camera_id: str) -> str:
    return f"cam-{camera_id}"


def provision_camera(camera_id: str) -> dict[str, Any]:
    """Start the tunnel (if cloud) and register a live ANPR session for one camera."""
    from .camera_config import get_camera
    from .dahua_camera import source_for_camera
    from .live_supervisor import get_live_supervisor

    cam = get_camera(camera_id)
    if not cam:
        return {"ok": False, "error": "Camera not found"}
    if not cam.get("enabled"):
        return {"ok": False, "error": "Camera is disabled"}

    source = source_for_camera(cam)
    if not source:
        return {"ok": False, "error": "Camera has no source — set an RTSP URL, LAN IP, or device serial."}

    try:
        _start_tunnel_if_needed(cam)
    except Exception as exc:  # noqa: BLE001
        _log.warning("Tunnel start failed for camera %s: %s", camera_id, exc)

    slot_index = int(cam.get("slot_index") or 0)
    session_id = session_id_for(cam["id"])
    label = str(cam.get("name") or cam["id"])
    opts = _pipeline_opts()
    # Apply this camera's speed calibration (0 = keep the pipeline default).
    try:
        mpp = float(cam.get("meter_per_pixel") or 0.0)
        if mpp > 0:
            opts["meter_per_pixel"] = max(1e-4, min(0.5, mpp))
    except (TypeError, ValueError):
        pass
    try:
        job_id = get_live_supervisor().register_and_start(
            session_id,
            source,
            label,
            opts,
            record=True,
            slot_index=slot_index,
            exclusive=False,
        )
    except Exception as exc:  # noqa: BLE001
        _log.exception("Failed to register live session for camera %s", camera_id)
        return {"ok": False, "error": str(exc)}

    return {
        "ok": True,
        "session_id": session_id,
        "job_id": job_id,
        "source": source,
        "slot_index": slot_index,
    }


def deprovision_camera(camera_id: str) -> None:
    """Stop a camera's live session (best effort) so a deleted/disabled camera goes dark."""
    from .live_supervisor import get_live_supervisor

    session_id = session_id_for(camera_id)
    sup = get_live_supervisor()
    try:
        sessions = sup.list_sessions()
    except Exception:
        sessions = []
    job_id = None
    for sess in sessions:
        if str(sess.get("session_id")) == session_id:
            job_id = sess.get("job_id")
            break
    try:
        sup.disable(session_id)
    except Exception:
        pass
    if job_id:
        try:
            from ..routers import visionflow as vf

            ev = vf._live_stop_events.get(job_id)
            if ev is not None:
                ev.set()
        except Exception:
            pass


def provision_all_enabled() -> dict[str, Any]:
    """Provision every enabled camera (staggered), capped at LIVE_MAX_CAMERAS."""
    from ..config import settings
    from .camera_config import list_cameras

    with _provision_lock:
        cams = [c for c in list_cameras() if c.get("enabled")]
        max_cams = max(1, int(settings.LIVE_MAX_CAMERAS))
        stagger = max(0.0, float(settings.LIVE_GRID_RESUME_STAGGER_SEC))
        results: list[dict[str, Any]] = []
        for i, cam in enumerate(cams[:max_cams]):
            if i > 0 and stagger > 0:
                time.sleep(stagger)
            try:
                res = provision_camera(cam["id"])
            except Exception as exc:  # noqa: BLE001
                res = {"ok": False, "id": cam["id"], "error": str(exc)}
            res.setdefault("id", cam["id"])
            results.append(res)
        ok = sum(1 for r in results if r.get("ok"))
        if results:
            _log.info("Camera provisioner: started %d/%d enabled camera(s)", ok, len(results))
        return {"count": len(results), "ok": ok, "results": results}


def provision_all_enabled_async() -> None:
    """Run startup provisioning off the event loop (tunnels + stagger can be slow)."""

    def _run() -> None:
        time.sleep(5.0)
        try:
            provision_all_enabled()
        except Exception as exc:  # noqa: BLE001
            _log.warning("Startup camera provisioning failed: %s", exc)

    threading.Thread(target=_run, name="camera-provisioner", daemon=True).start()
