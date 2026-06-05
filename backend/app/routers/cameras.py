"""IP camera configuration and Dahua Hero A1 integration API."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from ..models.user import User
from ..services.camera_config import load_camera_config, save_camera_config, sanitize_dahua_patch
from ..services.dahua_camera import (
    HERO_A1_PROFILE,
    _connection_mode,
    build_rtsp_url,
    dahua_hero_a1_config,
    discover_hero_a1_candidates,
    hero_profile_for_config,
    parse_dahua_qr_payload,
    probe_saved_hero_a1,
    probe_stream,
    public_dahua_config,
    ptz_move,
    resolve_dahua_source,
)
from ..services.dahua_p2p_tunnel import get_p2p_tunnel_manager
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
def get_dahua_hero_a1() -> JSONResponse:
    """Public read — password is masked. Does not block on cloud network probes."""
    return JSONResponse(public_dahua_config())


@router.get("/dahua/hero-a1/cloud-status")
def dahua_cloud_status() -> JSONResponse:
    """Probe Dahua Easy4IP for serial/RandSalt (may take a few seconds)."""
    from ..services.dahua_camera import cloud_device_status_probe, dahua_hero_a1_config

    cfg = dahua_hero_a1_config()
    serial = str(cfg.get("device_serial") or "").strip()
    if not serial:
        raise HTTPException(status_code=400, detail="Enter camera serial (QR) first.")
    return JSONResponse(cloud_device_status_probe(serial))


@router.get("/dahua/hero-a1/live-source")
def dahua_live_source_token() -> JSONResponse:
    """Default VisionFlow source token when DH-H3A is configured."""
    from ..services.dahua_camera import default_dahua_live_token, resolve_dahua_source

    token = default_dahua_live_token()
    return JSONResponse({
        "token": token,
        "configured": token is not None,
        "rtsp_resolves": bool(resolve_dahua_source(token) if token else None),
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
        from ..services.dahua_camera import resolve_dahua_source

        url = resolve_dahua_source("dahua-hero-a1")
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
            raise HTTPException(
                status_code=400,
                detail={
                    "message": "Could not reach camera via cloud or LAN.",
                    "hint": "Confirm LAN IP from DMSS, same Wi-Fi, and device password.",
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
def dahua_p2p_status(current_user: User = Depends(require_admin)) -> JSONResponse:
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
    return JSONResponse({
        "connection_mode": _connection_mode(cfg),
        "tunnel": tunnel,
        "preview_url": preview_url,
    })


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
    if _connection_mode(cfg) == "p2p" and not str(cfg.get("host") or "").strip():
        return JSONResponse({
            "ok": False,
            "error": "Pan/tilt over HTTP is not available in cloud-only mode. Use the DMSS app, or add LAN IP for local PTZ.",
        })
    result = ptz_move(body.direction, duration=body.duration)
    return JSONResponse(result)


@router.get("/dahua/hero-a1/status")
def dahua_status(
    current_user: User = Depends(require_admin),
    timeout_sec: float = Query(8.0, ge=2.0, le=20.0),
) -> JSONResponse:
    """Quick health check using saved configuration."""
    return JSONResponse(probe_saved_hero_a1(timeout_sec=timeout_sec))
