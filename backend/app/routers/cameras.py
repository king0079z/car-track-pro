"""IP camera configuration and Dahua Hero A1 integration API."""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from ..models.user import User
from ..services.camera_config import (
    add_camera,
    delete_camera,
    get_camera,
    list_cameras,
    load_camera_config,
    sanitize_camera_patch,
    save_camera_config,
    sanitize_dahua_patch,
    update_camera,
)
from ..services.camera_provisioner import (
    deprovision_camera,
    provision_camera,
    session_id_for,
)
from ..services.dahua_camera import (
    HERO_A1_PROFILE,
    _connection_mode,
    build_rtsp_url,
    dahua_hero_a1_config,
    discover_hero_a1_candidates,
    hero_profile_for_config,
    parse_dahua_qr_payload,
    diagnose_connectivity,
    probe_saved_hero_a1,
    probe_stream,
    ptz_for_camera,
    ptz_supported,
    public_dahua_config,
    ptz_move,
    resolve_dahua_source,
    source_for_camera,
    wifi_supported,
)
from ..services.dahua_p2p_tunnel import get_p2p_tunnel_manager
from ..services.easy4ip_openapi import (
    easy4ip_ptz,
    easy4ip_wifi_current,
    easy4ip_wifi_scan,
    easy4ip_wifi_set,
    ensure_device_bound,
)
from ..services.live_supervisor import get_live_supervisor
from ..utils.auth import require_admin

router = APIRouter(prefix="/api/cameras", tags=["Cameras"])


class DahuaConfigPatch(BaseModel):
    enabled: bool | None = None
    host: str | None = None
    rtsp_port: int | None = Field(None, ge=1, le=65535)
    http_port: int | None = Field(None, ge=1, le=65535)
    username: str | None = None
    password: str | None = None
    stream: str | None = None
    label: str | None = None
    use_tcp_transport: bool | None = None
    device_serial: str | None = None
    device_type: str | None = None
    security_code: str | None = None
    connection_mode: str | None = None
    p2p_local_port: int | None = Field(None, ge=1024, le=65535)
    cartrack_relay_publish_url: str | None = None
    cartrack_relay_view_url: str | None = None


class DahuaQrBody(BaseModel):
    qr: str = Field(..., min_length=8, max_length=512)
    save: bool = False


class DahuaTestBody(BaseModel):
    host: str | None = None
    username: str | None = None
    password: str | None = None
    rtsp_port: int | None = Field(None, ge=1, le=65535)
    stream: str | None = None
    use_tcp_transport: bool | None = True


class PtzBody(BaseModel):
    direction: str = Field(..., description="up | down | left | right | home")
    duration: int = Field(1, ge=1, le=8)


@router.get("/profiles")
def list_camera_profiles() -> JSONResponse:
    """Supported IP camera profiles (includes Dahua Hero A1)."""
    pub = public_dahua_config()
    return JSONResponse({
        "profiles": [hero_profile_for_config()],
        "dahua_hero_a1": pub,
    })


@router.post("/dahua/hero-a1/parse-qr")
def parse_dahua_qr(
    body: DahuaQrBody,
    current_user: User = Depends(require_admin),
) -> JSONResponse:
    """Parse label QR {SN,DT,SC}; optionally save serial/model for CarTrack settings."""
    try:
        result = parse_dahua_qr_payload(body.qr)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if body.save:
        patch = result.get("suggested_config") or {}
        save_camera_config({"dahua_hero_a1": patch})
        result["saved"] = True
        result["public"] = public_dahua_config()
    return JSONResponse(result)


@router.get("/dahua/hero-a1")
async def get_dahua_hero_a1() -> JSONResponse:
    """Public read — password is masked. Does not block on cloud network probes."""
    return JSONResponse(await asyncio.to_thread(public_dahua_config))


@router.get("/dahua/hero-a1/diagnose")
async def dahua_connect_diagnose(current_user: User = Depends(require_admin)) -> JSONResponse:
    """Quick LAN/cloud connectivity hints for the Camera cloud settings tab."""
    cfg = load_camera_config()["dahua_hero_a1"]
    return JSONResponse(await asyncio.to_thread(diagnose_connectivity, cfg))


@router.get("/dahua/hero-a1/cloud-status")
async def dahua_cloud_status() -> JSONResponse:
    """Instant cloud summary for settings UI (cached tunnel state; no network probe)."""
    from ..services.dahua_camera import cloud_device_status_fast, dahua_hero_a1_config

    cfg = dahua_hero_a1_config()
    serial = str(cfg.get("device_serial") or "").strip()
    if not serial:
        raise HTTPException(status_code=400, detail="Enter camera serial (QR) first.")
    return JSONResponse(
        await asyncio.to_thread(cloud_device_status_fast, serial, include_tunnel=False)
    )


@router.post("/dahua/hero-a1/cloud-status/probe")
def dahua_cloud_status_probe(
    current_user: User = Depends(require_admin),
) -> JSONResponse:
    """Background Easy4IP probe (may take 10–30s; do not call on page load)."""
    from ..services.dahua_camera import cloud_device_status_probe, dahua_hero_a1_config

    cfg = dahua_hero_a1_config()
    serial = str(cfg.get("device_serial") or "").strip()
    if not serial:
        raise HTTPException(status_code=400, detail="Enter camera serial (QR) first.")
    return JSONResponse(cloud_device_status_probe(serial))


@router.get("/dahua/hero-a1/live-source")
def dahua_live_source_token() -> JSONResponse:
    """Default VisionFlow source token when DH-H3A is configured."""
    from ..services.dahua_camera import (
        _connection_mode,
        _dahua_is_configured,
        dahua_hero_a1_config,
        default_dahua_live_token,
    )

    token = default_dahua_live_token()
    configured = token is not None
    # Fast path only — do not call resolve_dahua_source() here (P2P can block 40–90s
    # and breaks Vercel/Cloudflare tunnel clients with ERR_NETWORK / WS 1006).
    rtsp_resolves = False
    if configured:
        cfg = dahua_hero_a1_config()
        mode = _connection_mode(cfg)
        if mode == "lan" and str(cfg.get("host") or "").strip():
            rtsp_resolves = True
        elif mode == "cartrack_relay" and str(cfg.get("cartrack_relay_view_url") or "").strip():
            rtsp_resolves = True
        elif mode in ("auto", "p2p") and str(cfg.get("host") or "").strip():
            rtsp_resolves = True
        elif _dahua_is_configured(cfg):
            rtsp_resolves = True
    return JSONResponse({
        "token": token,
        "configured": configured,
        "rtsp_resolves": rtsp_resolves,
    })


@router.patch("/dahua/hero-a1")
def update_dahua_hero_a1(
    body: DahuaConfigPatch,
    current_user: User = Depends(require_admin),
) -> JSONResponse:
    patch = sanitize_dahua_patch(body.model_dump(exclude_unset=True))
    if not patch:
        raise HTTPException(status_code=400, detail="No valid fields to update.")
    current = load_camera_config()
    merged = {**current["dahua_hero_a1"], **patch}
    if patch.get("password") == "********":
        merged["password"] = current["dahua_hero_a1"].get("password") or ""
    save_camera_config({"dahua_hero_a1": merged})
    if _connection_mode(merged) in ("p2p", "auto") and merged.get("enabled") and merged.get("device_serial") and merged.get("password"):
        from ..services.dahua_p2p_tunnel import prewarm_cloud_tunnel_async

        prewarm_cloud_tunnel_async()
    return JSONResponse(public_dahua_config())


@router.post("/dahua/hero-a1/test")
def test_dahua_hero_a1(
    body: DahuaTestBody | None = None,
    current_user: User = Depends(require_admin),
) -> JSONResponse:
    """Probe RTSP connectivity — LAN IP or cloud P2P tunnel from saved config."""
    cfg = load_camera_config()["dahua_hero_a1"]
    data = body.model_dump(exclude_unset=True) if body else {}
    password = data.get("password")
    if password == "********" or password is None:
        password = cfg.get("password") or ""

    use_tcp = bool(
        data.get("use_tcp_transport")
        if data.get("use_tcp_transport") is not None
        else cfg.get("use_tcp_transport", True)
    )
    username = str(data.get("username") or cfg.get("username") or "admin")
    stream = str(data.get("stream") or cfg.get("stream") or "sub")

    mode = _connection_mode(cfg)
    if mode in ("p2p", "auto"):
        lan_host = str(cfg.get("host") or "").strip()
        if mode == "auto" and lan_host:
            try:
                lan_url = build_rtsp_url(
                    host=lan_host,
                    username=username,
                    password=str(password),
                    rtsp_port=int(data.get("rtsp_port") or cfg.get("rtsp_port") or 554),
                    stream=stream,
                )
                lan_first = probe_stream(
                    lan_url,
                    use_tcp=use_tcp,
                    username=username,
                    password=str(password),
                    timeout_sec=18.0,
                )
                if lan_first.get("ok"):
                    lan_first["connection_mode"] = "lan"
                    lan_first["resolved_url"] = lan_url.split("@")[-1] if "@" in lan_url else lan_url[:80]
                    return JSONResponse(lan_first)
            except ValueError:
                pass

        url = resolve_dahua_source("dahua-hero-a1")
        result: dict[str, Any] = {}
        if url:
            result = probe_stream(
                url,
                use_tcp=use_tcp,
                username=username,
                password=str(password),
                timeout_sec=25.0,
            )
            result["connection_mode"] = mode
            result["resolved_url"] = url.split("@")[-1] if "@" in url else url[:80]
            if get_p2p_tunnel_manager().status().get("running"):
                result["tunnel"] = get_p2p_tunnel_manager().status()
            if result.get("ok"):
                return JSONResponse(result)
        if mode == "auto":
            if lan_host:
                try:
                    lan_url = build_rtsp_url(
                        host=lan_host,
                        username=username,
                        password=str(password),
                        rtsp_port=int(data.get("rtsp_port") or cfg.get("rtsp_port") or 554),
                        stream=stream,
                    )
                    lan_result = probe_stream(
                        lan_url,
                        use_tcp=use_tcp,
                        username=username,
                        password=str(password),
                        timeout_sec=18.0,
                    )
                    if lan_result.get("ok"):
                        lan_result["connection_mode"] = "lan"
                        lan_result["fallback"] = (
                            "Cloud tunnel unavailable; connected via LAN IP instead."
                        )
                        return JSONResponse(lan_result)
                    lan_err = lan_result.get("error")
                except ValueError:
                    lan_err = "Invalid LAN IP or RTSP URL."
            else:
                lan_err = "LAN IP not configured."
            diag = diagnose_connectivity(cfg)
            probe_err = (result or {}).get("error") if url else "Cloud tunnel not ready."
            raise HTTPException(
                status_code=400,
                detail={
                    "message": "Could not reach camera via cloud or LAN.",
                    "hint": "Confirm LAN IP from DMSS, same Wi-Fi, and device password.",
                    "cloud_error": probe_err,
                    "lan_error": lan_err,
                    "diagnosis": diag,
                    "fixes": diag.get("fixes") or [],
                },
            )

    if mode == "p2p":
        serial = str(cfg.get("device_serial") or "").strip()
        if not serial:
            raise HTTPException(status_code=400, detail="Paste QR / serial number for cloud mode.")
        tunnel = get_p2p_tunnel_manager().ensure_running(
            serial=serial,
            username=username,
            password=str(password),
            local_port=int(cfg.get("p2p_local_port") or 18554),
        )
        if tunnel.get("ok"):
            url = build_rtsp_url(
                host="127.0.0.1",
                username=username,
                password=str(password),
                rtsp_port=int(tunnel.get("local_port") or 18554),
                stream=stream,
            )
            result = probe_stream(
                url,
                use_tcp=use_tcp,
                username=username,
                password=str(password),
                timeout_sec=20.0,
            )
            result["connection_mode"] = "p2p"
            result["tunnel"] = get_p2p_tunnel_manager().status()
            if result.get("ok"):
                return JSONResponse(result)
        lan_host = str(cfg.get("host") or "").strip()
        if lan_host:
            try:
                lan_url = build_rtsp_url(
                    host=lan_host,
                    username=username,
                    password=str(password),
                    rtsp_port=int(cfg.get("rtsp_port") or 554),
                    stream=stream,
                )
                lan_result = probe_stream(
                    lan_url,
                    use_tcp=use_tcp,
                    username=username,
                    password=str(password),
                )
                if lan_result.get("ok"):
                    lan_result["connection_mode"] = "lan"
                    lan_result["fallback"] = (
                        "Cloud tunnel failed; connected via LAN IP instead. "
                        "Switch connection to Same Wi-Fi (LAN IP) in settings."
                    )
                    return JSONResponse(lan_result)
            except ValueError:
                pass
        raise HTTPException(
            status_code=400,
            detail={
                "message": tunnel.get("error") or "P2P tunnel failed",
                "detail": tunnel.get("detail"),
                "hint": "Use Same Wi-Fi (LAN) with IP from DMSS if this PC is on the camera network.",
            },
        )

    host = str(data.get("host") or cfg.get("host") or "").strip()
    if not host:
        raise HTTPException(status_code=400, detail="Enter the camera IP/hostname (set in DMSS app).")
    try:
        url = build_rtsp_url(
            host=host,
            username=username,
            password=str(password),
            rtsp_port=int(data.get("rtsp_port") or cfg.get("rtsp_port") or 554),
            stream=stream,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    result = probe_stream(url, use_tcp=use_tcp, username=username, password=str(password))
    result["connection_mode"] = "lan"
    return JSONResponse(result)


@router.post("/dahua/hero-a1/p2p/start")
def start_dahua_p2p(
    body: DahuaTestBody | None = None,
    current_user: User = Depends(require_admin),
) -> JSONResponse:
    """Start DMSS-style cloud tunnel (Easy4IP P2P) using saved serial + credentials."""
    cfg = dahua_hero_a1_config()
    serial = str(cfg.get("device_serial") or "").strip()
    if not serial:
        raise HTTPException(status_code=400, detail="Apply camera QR or enter serial number first.")
    data = body.model_dump(exclude_unset=True) if body else {}
    password = data.get("password")
    if password == "********" or password is None:
        password = cfg.get("password") or ""
    password = str(password)
    if not password:
        raise HTTPException(
            status_code=400,
            detail="Enter the device password from DMSS, click Save camera, then Start cloud tunnel.",
        )
    username = str(data.get("username") or cfg.get("username") or "admin")
    if data.get("password") and data.get("password") != "********":
        merged = {**cfg, "password": password, "username": username}
        save_camera_config({"dahua_hero_a1": merged})
    mgr = get_p2p_tunnel_manager()
    result = mgr.start_background(
        serial=serial,
        username=username,
        password=password,
        local_port=int(cfg.get("p2p_local_port") or 18554),
    )
    if not result.get("ok"):
        raise HTTPException(
            status_code=400,
            detail={
                "message": result.get("error") or "P2P start failed",
                "detail": result.get("detail"),
                "hint": (
                    "Camera must be online in DMSS. On the same Wi-Fi, use Same Wi-Fi (LAN IP) "
                    "with the IP from DMSS and the device password you set during setup."
                ),
            },
        )
    st = result.get("status") or mgr.status()
    return JSONResponse({
        **result,
        "status": st,
        "message": (
            "Cloud tunnel is starting in the background. "
            "Wait until status shows ready (up to 3 minutes), or switch to Same Wi-Fi (LAN IP)."
        ),
    })


@router.post("/dahua/hero-a1/p2p/stop")
def stop_dahua_p2p(current_user: User = Depends(require_admin)) -> JSONResponse:
    get_p2p_tunnel_manager().stop()
    return JSONResponse({"ok": True, "status": get_p2p_tunnel_manager().status()})


@router.get("/dahua/hero-a1/p2p/status")
async def dahua_p2p_status(current_user: User = Depends(require_admin)) -> JSONResponse:
    def _payload() -> dict[str, Any]:
        cfg = dahua_hero_a1_config()
        tunnel = get_p2p_tunnel_manager().status()
        preview_url = None
        if _connection_mode(cfg) == "p2p" and tunnel.get("running"):
            try:
                preview_url = build_rtsp_url(
                    host="127.0.0.1",
                    username=str(cfg.get("username") or "admin"),
                    password="********",
                    rtsp_port=int(tunnel.get("local_port") or cfg.get("p2p_local_port") or 18554),
                    stream=str(cfg.get("stream") or "sub"),
                )
            except ValueError:
                preview_url = None
        return {
            "connection_mode": _connection_mode(cfg),
            "tunnel": tunnel,
            "preview_url": preview_url,
        }

    return JSONResponse(await asyncio.to_thread(_payload))


@router.post("/dahua/hero-a1/cartrack-relay/start")
def start_cartrack_relay(current_user: User = Depends(require_admin)) -> JSONResponse:
    """Publish LAN RTSP from this PC to your CarTrack media server (not Dahua cloud)."""
    from ..services.cartrack_cloud_relay import get_cartrack_relay_manager, relay_urls_from_config

    cfg = dahua_hero_a1_config()
    publish, _view = relay_urls_from_config(cfg)
    if not publish:
        raise HTTPException(
            status_code=400,
            detail="Set CarTrack relay publish URL in Settings (your VPS / MediaMTX).",
        )
    host = str(cfg.get("host") or "").strip()
    if not host:
        raise HTTPException(status_code=400, detail="Set camera LAN IP first (same Wi-Fi as the PC).")
    lan_url = build_rtsp_url(
        host=host,
        username=str(cfg.get("username") or "admin"),
        password=str(cfg.get("password") or ""),
        rtsp_port=int(cfg.get("rtsp_port") or 554),
        stream=str(cfg.get("stream") or "sub"),
    )
    result = get_cartrack_relay_manager().ensure_running(
        source_rtsp_url=lan_url,
        publish_url=publish,
    )
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("error") or "Relay start failed")
    return JSONResponse(result)


@router.post("/dahua/hero-a1/cartrack-relay/stop")
def stop_cartrack_relay(current_user: User = Depends(require_admin)) -> JSONResponse:
    from ..services.cartrack_cloud_relay import get_cartrack_relay_manager

    get_cartrack_relay_manager().stop()
    return JSONResponse({"ok": True, "relay": get_cartrack_relay_manager().status()})


@router.get("/dahua/hero-a1/cartrack-relay/status")
def cartrack_relay_status(current_user: User = Depends(require_admin)) -> JSONResponse:
    from ..services.cartrack_cloud_relay import get_cartrack_relay_manager, relay_urls_from_config

    cfg = dahua_hero_a1_config()
    publish, view = relay_urls_from_config(cfg)
    return JSONResponse({
        "connection_mode": _connection_mode(cfg),
        "publish_url": publish or None,
        "view_url": view or None,
        "relay": get_cartrack_relay_manager().status(),
    })


@router.post("/dahua/hero-a1/discover")
def discover_dahua_cameras(
    current_user: User = Depends(require_admin),
) -> JSONResponse:
    """Scan the local network for Dahua-like cameras (RTSP / SDK ports)."""
    result = discover_hero_a1_candidates()
    candidates = result.get("candidates") or []
    hint = (
        "Open the DMSS app → Device info to confirm the camera IP. "
        "USB-C on Hero A1 is power only — video uses Wi-Fi RTSP."
    )
    if not candidates:
        subnets = ", ".join(result.get("scanned_subnets") or []) or "unknown"
        hint = (
            f"No cameras found on scanned subnets ({subnets}). "
            "Connect this PC to the same Wi-Fi as the camera, or enter the IP from DMSS manually."
        )
    return JSONResponse({**result, "hint": hint})


@router.post("/dahua/hero-a1/ptz")
def dahua_ptz(body: PtzBody, current_user: User = Depends(require_admin)) -> JSONResponse:
    cfg = dahua_hero_a1_config()
    # cloud_hls → Easy4IP controlMovePTZ; p2p without LAN IP → no HTTP CGI available.
    if _connection_mode(cfg) == "p2p" and not str(cfg.get("host") or "").strip():
        return JSONResponse({
            "ok": False,
            "error": "Pan/tilt over HTTP is not available in this mode. Use Cloud HLS, or add a LAN IP for local PTZ.",
        })
    result = ptz_for_camera(cfg, body.direction, duration=body.duration)
    return JSONResponse(result)


@router.get("/dahua/hero-a1/status")
def dahua_status(
    current_user: User = Depends(require_admin),
    timeout_sec: float = Query(8.0, ge=2.0, le=20.0),
) -> JSONResponse:
    """Quick health check using saved configuration."""
    return JSONResponse(probe_saved_hero_a1(timeout_sec=timeout_sec))


# ── Multi-camera registry (Dahua cloud + generic RTSP/NVR) ───────────────────
# NOTE: registered AFTER the static /profiles and /dahua/* routes so those win
# path matching; the single-segment /{camera_id} routes never shadow them.

class CameraBody(BaseModel):
    name: str | None = None
    type: str | None = None            # "rtsp" | "dahua_p2p"
    enabled: bool | None = None
    connection_mode: str | None = None  # dahua: lan | auto | p2p
    device_serial: str | None = None
    device_type: str | None = None
    security_code: str | None = None
    host: str | None = None
    rtsp_port: int | None = Field(None, ge=1, le=65535)
    http_port: int | None = Field(None, ge=1, le=65535)
    username: str | None = None
    password: str | None = None
    stream: str | None = None
    use_tcp_transport: bool | None = None
    rtsp_url: str | None = None
    slot_index: int | None = Field(None, ge=0, le=255)
    meter_per_pixel: float | None = Field(None, ge=0.0, le=0.5)
    # Cloud HLS (Easy4IP Open Platform) — per-camera overrides; blank → use env app creds
    openapi_app_id: str | None = None
    openapi_app_secret: str | None = None
    openapi_base_url: str | None = None
    openapi_channel: str | None = None
    openapi_prefer_hd: bool | None = None


def _camera_public(cam: dict[str, Any], *, include_status: bool = True) -> dict[str, Any]:
    out = dict(cam)
    if out.get("password"):
        out["password"] = "********"
        out["has_password"] = True
    else:
        out["has_password"] = False
    out["source"] = source_for_camera(cam)
    out["session_id"] = session_id_for(cam["id"])
    if include_status:
        out["live"] = _camera_live_status(cam)
        if cam.get("type") == "dahua_p2p" and str(cam.get("device_serial") or "").strip():
            out["tunnel"] = get_p2p_tunnel_manager(
                cam["device_serial"], local_port=int(cam.get("p2p_local_port") or 18554)
            ).status()
    return out


def _camera_live_status(cam: dict[str, Any]) -> dict[str, Any]:
    session_id = session_id_for(cam["id"])
    try:
        sessions = get_live_supervisor().list_sessions()
    except Exception:
        sessions = []
    for sess in sessions:
        if str(sess.get("session_id")) == session_id:
            return {
                "registered": True,
                "enabled": bool(sess.get("enabled")),
                "job_id": sess.get("job_id"),
                "slot_index": sess.get("slot_index"),
            }
    return {"registered": False, "enabled": False, "job_id": None, "slot_index": cam.get("slot_index")}


@router.get("")
def list_cameras_endpoint(current_user: User = Depends(require_admin)) -> JSONResponse:
    """All registered cameras (Dahua cloud + RTSP/NVR) with live + tunnel status."""
    cams = [_camera_public(c) for c in list_cameras()]
    return JSONResponse({"cameras": cams, "count": len(cams)})


@router.post("")
def create_camera_endpoint(
    body: CameraBody,
    connect: bool = Query(True, description="Auto-connect (provision) after creating"),
    current_user: User = Depends(require_admin),
) -> JSONResponse:
    """Add a camera. Dahua needs device_serial (+password); RTSP needs rtsp_url or host."""
    data = body.model_dump(exclude_none=True)
    if not data.get("name"):
        raise HTTPException(status_code=400, detail="Camera name is required.")
    ctype = str(data.get("type") or "rtsp").lower()
    if ctype in ("dahua", "dahua_p2p", "p2p"):
        if not str(data.get("device_serial") or "").strip():
            raise HTTPException(status_code=400, detail="Dahua cloud camera requires a device serial (SN from the QR).")
    else:
        if not (str(data.get("rtsp_url") or "").strip() or str(data.get("host") or "").strip()):
            raise HTTPException(status_code=400, detail="RTSP camera requires an rtsp_url or a host/LAN IP.")
    cam = add_camera(data)
    result: dict[str, Any] = {"camera": _camera_public(cam)}

    # Cloud HLS cameras (Easy4IP Open Platform) must be bound to our app account
    # before live/PTZ work — bind now using the device password.
    if cam.get("type") == "dahua_p2p" and _connection_mode(cam) == "cloud_hls":
        bind = ensure_device_bound(cam)
        result["bind"] = bind
        if not bind.get("ok"):
            # Camera saved, but not streamable yet — surface the reason to the UI.
            result["provision"] = {"ok": False, "error": bind.get("error", "Cloud bind failed")}
            return JSONResponse(result, status_code=201)

    if connect and cam.get("enabled"):
        result["provision"] = provision_camera(cam["id"])
    return JSONResponse(result, status_code=201)


@router.get("/{camera_id}")
def get_camera_endpoint(camera_id: str, current_user: User = Depends(require_admin)) -> JSONResponse:
    cam = get_camera(camera_id)
    if not cam:
        raise HTTPException(status_code=404, detail="Camera not found.")
    return JSONResponse(_camera_public(cam))


@router.patch("/{camera_id}")
def update_camera_endpoint(
    camera_id: str,
    body: CameraBody,
    reconnect: bool = Query(True, description="Re-provision after updating"),
    current_user: User = Depends(require_admin),
) -> JSONResponse:
    if not get_camera(camera_id):
        raise HTTPException(status_code=404, detail="Camera not found.")
    patch = sanitize_camera_patch(body.model_dump(exclude_none=True))
    cam = update_camera(camera_id, patch)
    if not cam:
        raise HTTPException(status_code=404, detail="Camera not found.")
    result: dict[str, Any] = {"camera": _camera_public(cam)}
    if reconnect:
        if cam.get("enabled"):
            result["provision"] = provision_camera(cam["id"])
        else:
            deprovision_camera(cam["id"])
            result["provision"] = {"ok": True, "stopped": True}
    return JSONResponse(result)


@router.delete("/{camera_id}")
def delete_camera_endpoint(camera_id: str, current_user: User = Depends(require_admin)) -> JSONResponse:
    if not get_camera(camera_id):
        raise HTTPException(status_code=404, detail="Camera not found.")
    deprovision_camera(camera_id)
    ok = delete_camera(camera_id)
    return JSONResponse({"ok": ok, "deleted": camera_id})


@router.post("/{camera_id}/connect")
def connect_camera_endpoint(camera_id: str, current_user: User = Depends(require_admin)) -> JSONResponse:
    """Start the tunnel (if cloud) and register the live ANPR feed for this camera."""
    cam = get_camera(camera_id)
    if not cam:
        raise HTTPException(status_code=404, detail="Camera not found.")
    res = provision_camera(camera_id)
    if not res.get("ok"):
        raise HTTPException(status_code=400, detail=res.get("error") or "Could not connect camera.")
    return JSONResponse(res)


@router.post("/{camera_id}/disconnect")
def disconnect_camera_endpoint(camera_id: str, current_user: User = Depends(require_admin)) -> JSONResponse:
    if not get_camera(camera_id):
        raise HTTPException(status_code=404, detail="Camera not found.")
    deprovision_camera(camera_id)
    return JSONResponse({"ok": True, "stopped": camera_id})


@router.get("/{camera_id}/status")
def camera_status_endpoint(camera_id: str, current_user: User = Depends(require_admin)) -> JSONResponse:
    cam = get_camera(camera_id)
    if not cam:
        raise HTTPException(status_code=404, detail="Camera not found.")
    return JSONResponse({
        "id": cam["id"],
        "live": _camera_live_status(cam),
        "tunnel": (
            get_p2p_tunnel_manager(
                cam["device_serial"], local_port=int(cam.get("p2p_local_port") or 18554)
            ).status()
            if cam.get("type") == "dahua_p2p" and str(cam.get("device_serial") or "").strip()
            else None
        ),
    })


@router.post("/{camera_id}/test")
def test_camera_endpoint(camera_id: str, current_user: User = Depends(require_admin)) -> JSONResponse:
    """Probe the camera's resolved RTSP (Dahua cloud/LAN or the RTSP URL)."""
    cam = get_camera(camera_id)
    if not cam:
        raise HTTPException(status_code=404, detail="Camera not found.")
    if cam.get("type") == "dahua_p2p":
        url = resolve_dahua_source(f"dahua://{cam['id']}")
    else:
        url = source_for_camera(cam)
    if not url:
        raise HTTPException(status_code=400, detail="Camera is not reachable yet (no resolved RTSP source).")
    result = probe_stream(url, timeout_sec=12.0, use_tcp=bool(cam.get("use_tcp_transport", True)))
    return JSONResponse(result)


class CameraPtzBody(BaseModel):
    direction: str = Field(..., description="up | down | left | right | zoom_in | zoom_out | stop | home")
    duration: int = Field(1, ge=1, le=8)


@router.post("/{camera_id}/ptz")
def camera_ptz_endpoint(
    camera_id: str, body: CameraPtzBody, current_user: User = Depends(require_admin)
) -> JSONResponse:
    """Pan/tilt/zoom any camera — cloud Easy4IP (controlMovePTZ) or LAN HTTP CGI."""
    cam = get_camera(camera_id)
    if not cam:
        raise HTTPException(status_code=404, detail="Camera not found.")
    if not ptz_supported(cam):
        return JSONResponse(
            {"ok": False, "error": "This camera does not support pan/tilt (no cloud serial or LAN IP)."}
        )
    return JSONResponse(ptz_for_camera(cam, body.direction, duration=body.duration))


class CameraWifiBody(BaseModel):
    ssid: str = Field(..., min_length=1, max_length=64)
    bssid: str = Field("", max_length=32)
    password: str | None = None


def _require_wifi_camera(camera_id: str) -> dict[str, Any]:
    cam = get_camera(camera_id)
    if not cam:
        raise HTTPException(status_code=404, detail="Camera not found.")
    if not wifi_supported(cam):
        raise HTTPException(
            status_code=400,
            detail="Wi-Fi management needs a cloud (Easy4IP) camera with a device serial.",
        )
    return cam


@router.get("/{camera_id}/wifi")
def camera_wifi_current_endpoint(
    camera_id: str, current_user: User = Depends(require_admin)
) -> JSONResponse:
    """The Wi-Fi network the camera is currently connected to (cloud cameras)."""
    cam = _require_wifi_camera(camera_id)
    return JSONResponse(easy4ip_wifi_current(cam))


@router.post("/{camera_id}/wifi/scan")
def camera_wifi_scan_endpoint(
    camera_id: str, current_user: User = Depends(require_admin)
) -> JSONResponse:
    """Networks the camera can see, to pick a new one to switch to."""
    cam = _require_wifi_camera(camera_id)
    return JSONResponse(easy4ip_wifi_scan(cam))


@router.post("/{camera_id}/wifi")
def camera_wifi_set_endpoint(
    camera_id: str, body: CameraWifiBody, current_user: User = Depends(require_admin)
) -> JSONResponse:
    """Switch the camera onto a new Wi-Fi network (slow; camera reboots onto it)."""
    cam = _require_wifi_camera(camera_id)
    return JSONResponse(easy4ip_wifi_set(cam, body.ssid.strip(), body.bssid.strip(), body.password or ""))
