"""
Dahua Hero A1 (DH-H2A) integration for CarTrack / VisionFlow.

The Hero A1 is a Wi-Fi pan/tilt IP camera. USB-C on the unit is power only —
video reaches the PC over the LAN via RTSP (configured in the DMSS app).

Reference RTSP (channel 1):
  Main: rtsp://user:pass@host:554/cam/realmonitor?channel=1&subtype=0
  Sub:  rtsp://user:pass@host:554/cam/realmonitor?channel=1&subtype=1
"""

from __future__ import annotations

import hashlib
import ipaddress
import logging
import re
import socket
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any
from urllib.parse import quote, urlparse

import cv2

from ..config import settings
from .camera_config import DEFAULT_DAHUA_HERO_A1, load_camera_config

_log = logging.getLogger(__name__)

HERO_A1_MODEL = "DH-H2A"
SUPPORTED_HERO_MODELS = frozenset({"DH-H2A", "DH-H3A", "DH-H5A"})
HERO_A1_ALIASES = frozenset({
    "dahua-hero-a1",
    "dahua://hero-a1",
    "dahua://hero_a1",
    "hero-a1",
    "hero_a1",
    "dahua",
})

HERO_A1_PROFILE: dict[str, Any] = {
    "id": "dahua_hero_a1",
    "model": HERO_A1_MODEL,
    "name": "Dahua Hero A1 Indoor Pan/Tilt Wi-Fi Camera",
    "manufacturer": "Dahua",
    "connection_type": "wifi_rtsp",
    "connection_modes": ["lan", "p2p", "auto", "cartrack_relay", "cloud_hls"],
    "usb_note": (
        "USB-C on this camera is for power only. Video uses Wi-Fi RTSP (LAN) or "
        "Dahua cloud P2P (like DMSS) when serial number is configured."
    ),
    "max_resolution": "1920x1080",
    "recommended_stream": "sub",
    "default_rtsp_port": 554,
    "default_http_port": 80,
    "mobile_app": "DMSS",
    "ptz_supported": True,
    "pan_range_deg": 355,
    "tilt_range_deg": "−5° to +80°",
    "rtsp_paths": {
        "main": "/cam/realmonitor?channel=1&subtype=0",
        "sub": "/cam/realmonitor?channel=1&subtype=1",
    },
    "source_aliases": sorted(HERO_A1_ALIASES),
    "default_source_token": "dahua-hero-a1",
}


_LEGACY_HERO_IDS = frozenset({"hero-a1", "hero_a1", "hero", "dahua", ""})


def is_dahua_alias(source: str | None) -> bool:
    s = (source or "").strip().lower()
    if s in HERO_A1_ALIASES:
        return True
    return s.startswith("dahua://") or s.startswith("dahua:")


def dahua_id_from_source(source: str | None) -> str | None:
    """Map a Dahua source token to a camera id (``dahua://<id>`` or legacy alias)."""
    s = (source or "").strip()
    low = s.lower()
    if low in HERO_A1_ALIASES:
        return "hero-a1"
    if low.startswith("dahua://"):
        cid = s[len("dahua://"):].strip()
    elif low.startswith("dahua:"):
        cid = s[len("dahua:"):].strip()
    else:
        return None
    return "hero-a1" if cid.lower() in _LEGACY_HERO_IDS else cid


def dahua_hero_a1_config() -> dict[str, Any]:
    return load_camera_config().get("dahua_hero_a1") or dict(DEFAULT_DAHUA_HERO_A1)


def _camera_cfg_for_id(camera_id: str | None) -> dict[str, Any] | None:
    """Resolve a registry camera (or the legacy hero-a1 profile) to a config dict.

    The registry camera dict uses the same field names the resolution logic
    expects (host, rtsp_port, username, password, stream, connection_mode,
    device_serial, p2p_local_port), so it can be passed through directly.
    """
    cid = (camera_id or "hero-a1").strip()
    try:
        from .camera_config import get_camera

        cam = get_camera(cid)
        if cam:
            return cam
    except Exception:
        pass
    if cid == "hero-a1":
        return dahua_hero_a1_config()
    return None


def hero_profile_for_config(cfg: dict[str, Any] | None = None) -> dict[str, Any]:
    """Build profile metadata (H2A 1080p vs H3A 3MP, etc.) from saved device_type."""
    cfg = cfg or dahua_hero_a1_config()
    dt = str(cfg.get("device_type") or HERO_A1_MODEL).strip().upper()
    if "H3A" in dt:
        model, name, max_res = "DH-H3A", "Dahua DH-H3A Wi-Fi Camera (3 MP)", "2304x1296"
    elif "H5A" in dt:
        model, name, max_res = "DH-H5A", "Dahua Hero A1 Wi-Fi (DH-H5A)", "1920x1080"
    else:
        model, name, max_res = HERO_A1_MODEL, "Dahua Hero A1 Indoor Pan/Tilt Wi-Fi Camera", "1920x1080"
    serial = str(cfg.get("device_serial") or "").strip()
    out = {**HERO_A1_PROFILE, "model": model, "name": name, "max_resolution": max_res}
    if serial:
        out["device_serial"] = serial
    return out


def parse_dahua_qr_payload(text: str) -> dict[str, Any]:
    """
    Parse Dahua device QR text, e.g. {SN:BF0E4C7GAGB833C,DT:DH-H3A,SC:L219E7D3}.

    SN = serial (DMSS add device), DT = model, SC = security/pairing code for DMSS Wi-Fi setup.
    SC is NOT the RTSP password — CarTrack still needs LAN IP + admin + device password.
    """
    raw = (text or "").strip()
    fields: dict[str, str] = {}
    if raw.startswith("{"):
        inner = raw.strip("{} \n\r\t")
        for part in inner.split(","):
            if ":" not in part:
                continue
            key, val = part.split(":", 1)
            fields[key.strip().upper()] = val.strip()
    else:
        for part in raw.replace(";", ",").split(","):
            if ":" not in part:
                continue
            key, val = part.split(":", 1)
            fields[key.strip().upper()] = val.strip()

    serial = fields.get("SN", "")
    device_type = fields.get("DT", "")
    security_code = fields.get("SC", "")
    if not serial and not device_type:
        raise ValueError(
            "Unrecognized QR format. Expected Dahua label QR like "
            "{SN:...,DT:DH-H3A,SC:...}."
        )

    label = device_type if device_type else "Dahua Hero A1"
    return {
        "parsed": {
            "serial_number": serial,
            "device_type": device_type,
            "security_code": security_code,
        },
        "suggested_config": {
            "device_serial": serial,
            "device_type": device_type,
            "security_code": security_code,
            "label": label,
            "username": "admin",
            "connection_mode": "lan",
        },
        "dmss_steps": [
            "Install DMSS on your phone (same Wi-Fi as the PC running CarTrack).",
            "Tap Add device, SN/Scan, and scan this QR (or paste serial: "
            + (serial or "see label") + ").",
            "Follow Wi-Fi setup; when prompted, enter security code "
            + (security_code or "(from QR)") + " if DMSS asks for it.",
            "Create or confirm the device password (username is always admin on the camera).",
            "In DMSS open Device info and note the camera IP (e.g. 10.0.0.x).",
        ],
        "cartrack_steps": [
            "Enter that IP under Camera IP / hostname in CarTrack.",
            "Username: admin. Password: device password from DMSS (not your email login).",
            "Click Scan network or Test RTSP, then Save and enable live ANPR.",
        ],
        "important": (
            "The QR cannot connect CarTrack directly. It registers the camera in DMSS; "
            "CarTrack uses RTSP on your LAN after Wi-Fi setup."
        ),
    }


def normalize_dahua_username(username: str | None) -> str:
    """Hero A1 RTSP uses the local device account (almost always ``admin``), not a DMSS email."""
    user = (username or "admin").strip() or "admin"
    if "@" in user:
        _log.warning("Dahua RTSP username %r looks like an email; using admin for RTSP.", user)
        return "admin"
    return user


def build_rtsp_url(
    *,
    host: str,
    username: str = "admin",
    password: str = "",
    rtsp_port: int = 554,
    stream: str = "sub",
) -> str:
    host = host.strip()
    if not host:
        raise ValueError("Camera IP/hostname is required.")
    subtype = "0" if str(stream).lower() == "main" else "1"
    user = quote(normalize_dahua_username(username), safe="")
    pwd = quote(password or "", safe="")
    auth = f"{user}:{pwd}@" if password else f"{user}@"
    return (
        f"rtsp://{auth}{host}:{int(rtsp_port)}"
        f"/cam/realmonitor?channel=1&subtype={subtype}"
    )


def resolve_cartrack_view_rtsp(
    view_url: str,
    *,
    username: str = "admin",
    password: str = "",
    stream: str = "sub",
) -> str:
    """Use CarTrack relay view URL; inject credentials if omitted."""
    view = (view_url or "").strip()
    if not view:
        raise ValueError("CarTrack relay view URL is required.")
    if "@" in view:
        return view
    parsed = urlparse(view)
    host = parsed.hostname or ""
    port = parsed.port or 554
    path = parsed.path or "/cam/realmonitor"
    if "subtype=" not in path and "realmonitor" in path:
        subtype = "0" if str(stream).lower() == "main" else "1"
        sep = "&" if "?" in path else "?"
        path = f"{path}{sep}channel=1&subtype={subtype}" if "channel=" not in path else path
    user = quote(normalize_dahua_username(username), safe="")
    pwd = quote(password or "", safe="")
    auth = f"{user}:{pwd}@"
    return f"rtsp://{auth}{host}:{port}{path}"


def _connection_mode(cfg: dict[str, Any]) -> str:
    mode = str(cfg.get("connection_mode") or "lan").strip().lower()
    if mode in ("cloud_hls", "easy4ip", "openapi", "imou", "easy4ip_hls"):
        return "cloud_hls"
    if mode in ("p2p", "cloud", "remote"):
        return "p2p"
    if mode == "auto":
        return "auto"
    if mode in ("cartrack", "cartrack_relay", "cartrack_cloud"):
        return "cartrack_relay"
    return "lan"


def _try_cloud_tunnel_rtsp(
    cfg: dict[str, Any],
    *,
    username: str,
    password: str,
    stream: str,
    wait_sec: float = 45.0,
) -> str | None:
    """Start cloud P2P if needed; return localhost RTSP URL when ready (non-blocking poll)."""
    from .dahua_p2p_tunnel import get_p2p_tunnel_manager

    serial = str(cfg.get("device_serial") or "").strip()
    if not serial or not password:
        return None
    local_port = int(cfg.get("p2p_local_port") or 18554)
    mgr = get_p2p_tunnel_manager(serial, local_port=local_port)
    lan_host = str(cfg.get("host") or "").strip()
    lan_fallback = f"{lan_host}:{int(cfg.get('rtsp_port') or 554)}" if lan_host else ""
    st = mgr.status()
    if not st.get("running"):
        mgr.start_background(
            serial=serial,
            username=username,
            password=password,
            local_port=local_port,
            lan_fallback=lan_fallback,
        )
    deadline = time.monotonic() + max(5.0, float(wait_sec))
    while time.monotonic() < deadline:
        st = mgr.status()
        if st.get("running"):
            port = int(st.get("local_port") or cfg.get("p2p_local_port") or 18554)
            return build_rtsp_url(
                host="127.0.0.1",
                username=username,
                password=password,
                rtsp_port=port,
                stream=stream,
            )
        if st.get("phase") == "failed":
            break
        time.sleep(2.0)
    return None


def _dahua_is_configured(cfg: dict[str, Any]) -> bool:
    if not cfg.get("enabled"):
        return False
    mode = _connection_mode(cfg)
    if mode == "cloud_hls":
        # Needs the device serial + OpenAPI app creds (cfg or env).
        from .easy4ip_openapi import get_openapi_client

        return bool(str(cfg.get("device_serial") or "").strip()) and (
            get_openapi_client(cfg) is not None
        )
    if mode == "cartrack_relay":
        return bool(str(cfg.get("host") or "").strip())
    if mode in ("p2p", "auto"):
        return bool(str(cfg.get("device_serial") or "").strip())
    return bool(str(cfg.get("host") or "").strip())


def default_dahua_live_token() -> str | None:
    """Return ``dahua-hero-a1`` when the saved camera is enabled and ready for LAN live."""
    cfg = dahua_hero_a1_config()
    if _dahua_is_configured(cfg) and _connection_mode(cfg) == "lan":
        return HERO_A1_PROFILE["default_source_token"]
    if _dahua_is_configured(cfg):
        return HERO_A1_PROFILE["default_source_token"]
    return None


def source_for_camera(cam: dict[str, Any]) -> str:
    """Live-engine source string for a registry camera.

    Dahua cloud cameras use the ``dahua://<id>`` token (resolved lazily to a
    tunnel/LAN RTSP URL); generic cameras use their RTSP URL directly.
    """
    if not isinstance(cam, dict):
        return ""
    cid = str(cam.get("id") or "").strip()
    if str(cam.get("type")) == "dahua_p2p":
        return f"dahua://{cid}" if cid and cid != "hero-a1" else "dahua-hero-a1"
    url = str(cam.get("rtsp_url") or "").strip()
    if url:
        return url
    host = str(cam.get("host") or "").strip()
    if host:
        return build_rtsp_url(
            host=host,
            username=str(cam.get("username") or "admin"),
            password=str(cam.get("password") or ""),
            rtsp_port=int(cam.get("rtsp_port") or 554),
            stream=str(cam.get("stream") or "sub"),
        )
    return ""


def resolve_dahua_source(source: str | None) -> str | None:
    """Map friendly Dahua tokens (legacy alias or ``dahua://<id>``) to a concrete RTSP URL."""
    if not is_dahua_alias(source):
        return None
    cfg = _camera_cfg_for_id(dahua_id_from_source(source))
    if not cfg or not _dahua_is_configured(cfg):
        return None

    username = str(cfg.get("username") or "admin")
    password = str(cfg.get("password") or "")
    stream = str(cfg.get("stream") or "sub")

    mode = _connection_mode(cfg)
    if mode == "cloud_hls":
        # Official Imou/Easy4IP Open Platform: cloud-served HLS (.m3u8). Pure
        # cloud, CGNAT-proof, FFmpeg-native — replaces the fragile PTCP relay.
        from . import stream_governor
        from .easy4ip_openapi import resolve_easy4ip_hls
        from .live_camera import normalize_live_source

        gv_key = normalize_live_source(source)
        allow_hd = bool(cfg.get("openapi_prefer_hd", True))
        stream_governor.register_cloud_source(gv_key, allow_hd=allow_hd)

        # Hybrid SD/HD: the governor picks the quota-friendly SD sub-stream by
        # default and requests HD only while a plate is in frame.
        prefer_hd_override: bool | None = None
        if stream_governor.is_adaptive(gv_key) and bool(
            getattr(settings, "STREAM_HYBRID_ENABLED", True)
        ):
            prefer_hd_override = stream_governor.preferred_tier(gv_key) == "hd" and allow_hd

        hls = resolve_easy4ip_hls(cfg, prefer_hd_override=prefer_hd_override)
        if hls:
            if prefer_hd_override is not None:
                stream_governor.set_active_tier(gv_key, "hd" if prefer_hd_override else "sd")
            return hls
        _log.warning("Easy4IP cloud HLS not available (check OpenAPI creds / device online).")
        return None

    if mode == "cartrack_relay":
        from .cartrack_cloud_relay import get_cartrack_relay_manager, relay_urls_from_config

        publish, view = relay_urls_from_config(cfg)
        lan_host = str(cfg.get("host") or "").strip()
        if not lan_host:
            _log.warning("CarTrack relay needs LAN IP (camera on site Wi-Fi).")
            return None
        lan_url = build_rtsp_url(
            host=lan_host,
            username=username,
            password=password,
            rtsp_port=int(cfg.get("rtsp_port") or 554),
            stream=stream,
        )
        if publish:
            relay = get_cartrack_relay_manager().ensure_running(
                source_rtsp_url=lan_url,
                publish_url=publish,
            )
            if not relay.get("ok"):
                _log.warning("CarTrack relay not running: %s", relay.get("error"))
        if view:
            try:
                return resolve_cartrack_view_rtsp(
                    view, username=username, password=password, stream=stream
                )
            except ValueError:
                return None
        return lan_url

    if mode in ("p2p", "auto"):
        lan_host = str(cfg.get("host") or "").strip()
        if lan_host:
            lan_url = build_rtsp_url(
                host=lan_host,
                username=username,
                password=password,
                rtsp_port=int(cfg.get("rtsp_port") or 554),
                stream=stream,
            )
            # Auto: same-site Wi-Fi — try LAN before slow P2P.
            if mode == "auto":
                quick = probe_stream(lan_url, timeout_sec=6.0)
                if quick.get("ok"):
                    _log.info("Using LAN RTSP at %s (auto).", lan_host)
                    return lan_url
                _log.warning("LAN RTSP probe failed for %s: %s", lan_host, quick.get("error"))

        cloud_url = _try_cloud_tunnel_rtsp(
            cfg,
            username=username,
            password=password,
            stream=stream,
            wait_sec=25.0 if mode == "p2p" else 15.0,
        )
        if cloud_url:
            return cloud_url
        _log.warning("Dahua cloud tunnel not ready")
        if lan_host:
            _log.info("Using LAN RTSP at %s (cloud tunnel unavailable).", lan_host)
            return build_rtsp_url(
                host=lan_host,
                username=username,
                password=password,
                rtsp_port=int(cfg.get("rtsp_port") or 554),
                stream=stream,
            )
        return None

    return build_rtsp_url(
        host=str(cfg["host"]),
        username=username,
        password=password,
        rtsp_port=int(cfg.get("rtsp_port") or 554),
        stream=stream,
    )


def invalidate_dahua_cloud_cache(source: str | None) -> None:
    """Drop the cached cloud HLS URL for a Dahua source so the next resolve
    fetches a fresh one (called when a cached URL fails to open)."""
    if not is_dahua_alias(source):
        return
    cfg = _camera_cfg_for_id(dahua_id_from_source(source))
    if not cfg or _connection_mode(cfg) != "cloud_hls":
        return
    from .easy4ip_openapi import invalidate_hls_cache

    invalidate_hls_cache(cfg)


def cloud_device_status_fast(serial: str, *, include_tunnel: bool = True) -> dict[str, Any]:
    """Instant cloud summary for settings UI (no network — avoids blocking page load)."""
    serial = (serial or "").strip().upper()
    if not serial:
        return {"online": None, "randsalt": None, "deps_ok": True}
    try:
        from .dahua_p2p_tunnel import (
            _SALT_CACHE,
            check_p2p_dependencies,
            get_p2p_tunnel_manager,
        )

        deps_err = check_p2p_dependencies()
        if deps_err:
            return {"online": None, "randsalt": None, "deps_ok": False, "deps_error": deps_err}

        cached = _SALT_CACHE.get(serial)
        salt_known = bool(cached and cached[0]) if cached else None
        tunnel: dict[str, Any] = {}
        if include_tunnel:
            try:
                tunnel = get_p2p_tunnel_manager().status()
            except Exception:
                tunnel = {}
        return {
            "online": salt_known,
            "randsalt": salt_known,
            "deps_ok": True,
            "cached": bool(cached),
            "tunnel": tunnel,
        }
    except Exception as exc:
        _log.warning("cloud_device_status_fast failed: %s", exc)
        return {"online": None, "randsalt": None, "error": str(exc)}


def cloud_device_status_probe(serial: str) -> dict[str, Any]:
    """Probe Easy4IP for device online + RandSalt (network; use from background endpoint)."""
    serial = (serial or "").strip().upper()
    if not serial:
        return {"online": False, "randsalt": None}
    try:
        from .dahua_p2p_tunnel import (
            _fetch_device_randsalt,
            check_p2p_dependencies,
            get_p2p_tunnel_manager,
        )

        if check_p2p_dependencies():
            return {"online": False, "randsalt": None, "deps_ok": False}

        salt = _fetch_device_randsalt(serial)
        if salt:
            try:
                from .camera_config import load_camera_config, save_camera_config

                current = load_camera_config()
                merged = {**current["dahua_hero_a1"], "p2p_randsalt": salt}
                save_camera_config({"dahua_hero_a1": merged})
            except Exception:
                pass
        return {
            "online": bool(salt),
            "randsalt": bool(salt),
            "deps_ok": True,
            "tunnel": get_p2p_tunnel_manager().status(),
        }
    except Exception as exc:
        _log.warning("cloud_device_status_probe failed: %s", exc)
        return {"online": False, "randsalt": None, "error": str(exc)}


def public_dahua_config() -> dict[str, Any]:
    cfg = dahua_hero_a1_config()
    masked = {**cfg, "password": "********" if cfg.get("password") else ""}
    rtsp_url = ""
    configured = _dahua_is_configured(cfg)
    if configured:
        try:
            if _connection_mode(cfg) == "p2p":
                rtsp_url = build_rtsp_url(
                    host="127.0.0.1",
                    username=str(cfg.get("username") or "admin"),
                    password="********" if cfg.get("password") else "",
                    rtsp_port=int(cfg.get("p2p_local_port") or 18554),
                    stream=str(cfg.get("stream") or "sub"),
                )
            else:
                rtsp_url = build_rtsp_url(
                    host=str(cfg["host"]),
                    username=str(cfg.get("username") or "admin"),
                    password="********" if cfg.get("password") else "",
                    rtsp_port=int(cfg.get("rtsp_port") or 554),
                    stream=str(cfg.get("stream") or "sub"),
                )
        except ValueError:
            configured = False
    # Cloud summary is loaded separately via GET /cloud-status (never block settings page).
    cloud: dict[str, Any] = {}
    cartrack_relay = {}
    if _connection_mode(cfg) == "cartrack_relay":
        from .cartrack_cloud_relay import get_cartrack_relay_manager, relay_urls_from_config

        publish, view = relay_urls_from_config(cfg)
        cartrack_relay = {
            "publish_url": publish or None,
            "view_url": view or None,
            "relay": get_cartrack_relay_manager().status(),
        }
    from .camera_config import dahua_env_active

    return {
        "profile": hero_profile_for_config(cfg),
        "config": masked,
        "configured": configured,
        "rtsp_url_masked": rtsp_url,
        "source_token": HERO_A1_PROFILE["default_source_token"],
        "cloud": cloud,
        "cartrack_relay": cartrack_relay,
        "connection_mode": _connection_mode(cfg),
        "env_configured": dahua_env_active(),
    }


def _ffmpeg_rtsp_options(use_tcp: bool, *, relay: bool = False) -> str:
    transport = "tcp" if use_tcp else "udp"
    if relay:
        # Easy4IP media-relay path: the RTSP negotiation + first keyframe travel
        # VPS → Dahua relay agent → camera (behind CGNAT), so the open phase is far
        # slower than a LAN camera. Give FFmpeg/OpenCV enough patience to ride out
        # that warm-up (both stimeout and the newer `timeout` key, name varies by
        # FFmpeg build), and keep a small reorder buffer to absorb relay jitter.
        return (
            f"rtsp_transport;{transport}"
            "|stimeout;45000000|timeout;45000000|rw_timeout;45000000"
            "|max_delay;500000|reorder_queue_size;512"
            "|fflags;nobuffer|flags;low_delay"
        )
    # stimeout/rw_timeout in microseconds — avoid 30s OpenCV hang on unreachable hosts
    return (
        f"rtsp_transport;{transport}|stimeout;15000000|rw_timeout;20000000"
        "|fflags;nobuffer|flags;low_delay|max_delay;0"
    )


def _ffmpeg_hls_options() -> str:
    """FFmpeg options for cloud HLS (.m3u8 over http/https), e.g. Easy4IP Open
    Platform. HLS first-frame is slow on a cold stream and the cloud edge can
    briefly drop segments, so enable transparent reconnect and a generous read
    timeout instead of the RTSP-oriented options."""
    return (
        "reconnect;1|reconnect_streamed;1|reconnect_on_network_error;1"
        "|reconnect_delay_max;5|rw_timeout;30000000|timeout;30000000"
        "|fflags;nobuffer|flags;low_delay"
    )


def _is_relay_tunnel_url(rtsp_url: str) -> bool:
    """True for RTSP URLs served by a local Easy4IP P2P/relay tunnel (127.0.0.1:1855x)."""
    try:
        host = urlparse(rtsp_url).hostname or ""
    except Exception:
        return False
    return host in ("127.0.0.1", "localhost", "::1")


def _md5_hex(value: str) -> str:
    return hashlib.md5(value.encode("utf-8")).hexdigest()


def _parse_digest_challenge(header: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    for chunk in re.split(r",(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)", header.replace("Digest ", "", 1)):
        if "=" not in chunk:
            continue
        key, val = chunk.strip().split("=", 1)
        fields[key.strip().lower()] = val.strip().strip('"')
    return fields


def _rtsp_digest_header(
    *,
    method: str,
    uri: str,
    username: str,
    password: str,
    challenge: dict[str, str],
) -> str:
    realm = challenge.get("realm", "")
    nonce = challenge.get("nonce", "")
    qop = challenge.get("qop", "")
    opaque = challenge.get("opaque", "")
    ha1 = _md5_hex(f"{username}:{realm}:{password}")
    ha2 = _md5_hex(f"{method}:{uri}")
    if qop:
        nc = "00000001"
        cnonce = _md5_hex(f"{nonce}{time.time()}")[:16]
        response = _md5_hex(f"{ha1}:{nonce}:{nc}:{cnonce}:{qop}:{ha2}")
        digest = (
            f'Digest username="{username}", realm="{realm}", nonce="{nonce}", '
            f'uri="{uri}", response="{response}", qop={qop}, nc={nc}, cnonce="{cnonce}"'
        )
    else:
        response = _md5_hex(f"{ha1}:{nonce}:{ha2}")
        digest = (
            f'Digest username="{username}", realm="{realm}", nonce="{nonce}", '
            f'uri="{uri}", response="{response}"'
        )
    if opaque:
        digest += f', opaque="{opaque}"'
    return digest


def _is_local_tunnel_host(host: str | None) -> bool:
    return (host or "").strip().lower() in ("127.0.0.1", "localhost", "::1")


def verify_rtsp_credentials(
    rtsp_url: str,
    *,
    username: str,
    password: str,
    timeout_sec: float = 4.0,
) -> dict[str, Any]:
    """Check RTSP Digest login (Hero A1 rejects Basic auth in the URL for some clients)."""
    parsed = urlparse(rtsp_url)
    host = parsed.hostname or ""
    if _is_local_tunnel_host(host):
        from .dahua_p2p_tunnel import get_p2p_tunnel_manager

        st = get_p2p_tunnel_manager().status()
        if not st.get("running"):
            return {
                "ok": False,
                "error": (
                    "Cloud tunnel is not ready yet. Click Start cloud tunnel and wait until "
                    "status shows ready (not only port listening)."
                ),
            }
        return {"ok": True, "detail": "P2P tunnel ready (stream auth via RTSP)."}
    port = parsed.port or 554
    path = parsed.path or "/"
    if parsed.query:
        path = f"{path}?{parsed.query}"
    uri = path
    user = normalize_dahua_username(username)
    try:
        with socket.create_connection((host, port), timeout=timeout_sec) as sock:
            sock.settimeout(timeout_sec)
            opts = (
                f"OPTIONS rtsp://{host}:{port}{path} RTSP/1.0\r\n"
                "CSeq: 1\r\nUser-Agent: CarTrack\r\n\r\n"
            )
            sock.sendall(opts.encode("utf-8"))
            first = sock.recv(4096).decode("utf-8", errors="replace")
            if "401" not in first:
                return {"ok": True, "detail": "RTSP port reachable (no digest challenge)."}
            challenge_line = next(
                (ln for ln in first.split("\r\n") if ln.lower().startswith("www-authenticate:")),
                "",
            )
            if "digest" not in challenge_line.lower():
                return {"ok": False, "error": "Camera did not offer Digest authentication."}
            challenge = _parse_digest_challenge(challenge_line.split(":", 1)[-1].strip())
            auth = _rtsp_digest_header(
                method="DESCRIBE",
                uri=uri,
                username=user,
                password=password,
                challenge=challenge,
            )
            describe = (
                f"DESCRIBE rtsp://{host}:{port}{path} RTSP/1.0\r\n"
                "CSeq: 2\r\n"
                "Accept: application/sdp\r\n"
                f"Authorization: {auth}\r\n\r\n"
            )
            sock.sendall(describe.encode("utf-8"))
            second = sock.recv(4096).decode("utf-8", errors="replace")
    except OSError as exc:
        err = str(exc).lower()
        if "timed out" in err or "timeout" in err:
            return {
                "ok": False,
                "error": (
                    f"Cannot reach camera at {host}:{port} (timed out). "
                    "Use the same Wi‑Fi as the camera, confirm IP in DMSS → Device info, or Scan network."
                ),
            }
        return {"ok": False, "error": f"Cannot reach camera at {host}:{port} ({exc})."}

    if second.startswith("RTSP/1.0 200"):
        return {"ok": True, "detail": "RTSP credentials accepted."}
    if "401" in second:
        return {
            "ok": False,
            "error": (
                "Wrong username or password. Hero A1 RTSP uses username admin and the "
                "device password you set in DMSS (Device settings), not your DMSS email login."
            ),
            "auth_code": 401,
        }
    if "403" in second:
        return {
            "ok": False,
            "error": (
                "RTSP access denied (403). In DMSS open the camera, Settings, confirm the "
                "device password, or reset it and update it here."
            ),
            "auth_code": 403,
        }
    return {"ok": False, "error": f"Unexpected RTSP response: {second.split(chr(10), 1)[0][:120]}"}


def _ffmpeg_exe() -> str | None:
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def _probe_ffmpeg_frame(rtsp_url: str, *, use_tcp: bool, timeout_sec: float) -> dict[str, Any]:
    ffmpeg = _ffmpeg_exe()
    if not ffmpeg:
        return {"ok": False, "error": "ffmpeg not available"}
    transport = "tcp" if use_tcp else "udp"
    cmd = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-rtsp_transport",
        transport,
        "-i",
        rtsp_url,
        "-frames:v",
        "1",
        "-f",
        "null",
        "-",
    ]
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=max(4.0, float(timeout_sec)),
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "RTSP timed out waiting for the first video frame."}
    if proc.returncode == 0:
        return {"ok": True, "width": 0, "height": 0, "fps": 0.0, "backend": "ffmpeg"}
    err = (proc.stderr or "").strip()
    if "401" in err or "Unauthorized" in err:
        return {
            "ok": False,
            "error": (
                "Wrong password for RTSP. Use username admin and the device password from DMSS setup."
            ),
            "auth_code": 401,
        }
    if "403" in err or "Forbidden" in err:
        return {
            "ok": False,
            "error": "RTSP forbidden — verify the device password in DMSS and try the sub stream.",
            "auth_code": 403,
        }
    return {"ok": False, "error": err[:240] or "ffmpeg could not open RTSP stream."}


def open_dahua_stream(
    rtsp_url: str,
    *,
    use_tcp: bool = True,
    buffer_size: int = 1,
) -> cv2.VideoCapture:
    """Open RTSP with FFmpeg backend and low-latency options (Windows-friendly)."""
    import os

    prev = os.environ.get("OPENCV_FFMPEG_CAPTURE_OPTIONS")
    scheme = (urlparse(rtsp_url).scheme or "").lower()
    if scheme in ("http", "https"):
        os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = _ffmpeg_hls_options()
    else:
        relay = _is_relay_tunnel_url(rtsp_url)
        os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = _ffmpeg_rtsp_options(use_tcp, relay=relay)
    cap = cv2.VideoCapture(rtsp_url, cv2.CAP_FFMPEG)
    try:
        cap.set(cv2.CAP_PROP_BUFFERSIZE, buffer_size)
    except Exception:
        pass
    if prev is None:
        os.environ.pop("OPENCV_FFMPEG_CAPTURE_OPTIONS", None)
    else:
        os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = prev
    return cap


def probe_stream(
    rtsp_url: str,
    *,
    use_tcp: bool = True,
    timeout_sec: float = 8.0,
    username: str | None = None,
    password: str | None = None,
) -> dict[str, Any]:
    """Try to read one frame and return stream metadata."""
    started = time.monotonic()
    parsed = urlparse(rtsp_url)
    user = normalize_dahua_username(username or (parsed.username or "admin"))
    pwd = password if password is not None else (parsed.password or "")

    # Cloud HLS / HTTP(S) streams (Easy4IP Open Platform .m3u8) carry no RTSP
    # digest auth — open them directly with OpenCV (FFmpeg) and read a frame.
    scheme = (parsed.scheme or "").lower()
    if scheme in ("http", "https"):
        # Cold HLS first-frame can take 10-20s while the cloud edge spins up the
        # live session; use the reconnect-tolerant opener and wait generously.
        cap = open_dahua_stream(rtsp_url, use_tcp=use_tcp)
        try:
            deadline = started + max(25.0, float(timeout_sec))
            opened = cap.isOpened()
            while time.monotonic() < deadline:
                if not opened:
                    opened = cap.isOpened()
                if opened:
                    ret, _ = cap.read()
                    if ret:
                        return {
                            "ok": True,
                            "width": int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0),
                            "height": int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0),
                            "fps": round(float(cap.get(cv2.CAP_PROP_FPS) or 0.0), 2),
                            "connection_mode": "cloud_hls",
                            "elapsed_ms": int((time.monotonic() - started) * 1000),
                        }
                time.sleep(0.25)
            return {
                "ok": False,
                "error": (
                    "Cloud stream opened but no frame arrived in time. The camera may be "
                    "waking, busy in another app (close DMSS/Imou Life), or on weak Wi-Fi. Try again."
                ),
                "elapsed_ms": int((time.monotonic() - started) * 1000),
            }
        finally:
            cap.release()

    is_tunnel = _is_local_tunnel_host(parsed.hostname)
    if not is_tunnel:
        auth_check = verify_rtsp_credentials(
            rtsp_url,
            username=user,
            password=pwd,
            timeout_sec=min(4.0, timeout_sec),
        )
        if not auth_check.get("ok"):
            auth_check["elapsed_ms"] = int((time.monotonic() - started) * 1000)
            return auth_check

    ff_timeout = max(12.0, float(timeout_sec)) if is_tunnel else timeout_sec
    ff = _probe_ffmpeg_frame(rtsp_url, use_tcp=use_tcp, timeout_sec=ff_timeout)
    if ff.get("ok"):
        ff["elapsed_ms"] = int((time.monotonic() - started) * 1000)
        cap = open_dahua_stream(rtsp_url, use_tcp=use_tcp)
        try:
            if cap.isOpened():
                ret, _ = cap.read()
                if ret:
                    ff["width"] = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
                    ff["height"] = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
                    ff["fps"] = round(float(cap.get(cv2.CAP_PROP_FPS) or 0.0), 2)
        finally:
            cap.release()
        return ff

    cap = open_dahua_stream(rtsp_url, use_tcp=use_tcp)
    try:
        if not cap.isOpened():
            err = ff.get("error") or "Could not open RTSP stream (check IP, password, and Wi-Fi)."
            return {
                "ok": False,
                "error": err,
                "elapsed_ms": int((time.monotonic() - started) * 1000),
            }
        deadline = started + max(2.0, float(timeout_sec))
        frame_ok = False
        while time.monotonic() < deadline:
            ret, _ = cap.read()
            if ret:
                frame_ok = True
                break
            time.sleep(0.15)
        if not frame_ok:
            return {
                "ok": False,
                "error": "Stream opened but no video frame arrived (camera busy or wrong stream).",
                "elapsed_ms": int((time.monotonic() - started) * 1000),
            }
        w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
        h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
        fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
        return {
            "ok": True,
            "width": w,
            "height": h,
            "fps": round(fps, 2),
            "elapsed_ms": int((time.monotonic() - started) * 1000),
        }
    finally:
        cap.release()


def probe_saved_hero_a1(*, timeout_sec: float = 8.0) -> dict[str, Any]:
    cfg = dahua_hero_a1_config()
    if not str(cfg.get("host") or "").strip():
        return {"ok": False, "error": "Hero A1 IP/hostname not configured."}
    try:
        url = build_rtsp_url(
            host=str(cfg["host"]),
            username=str(cfg.get("username") or "admin"),
            password=str(cfg.get("password") or ""),
            rtsp_port=int(cfg.get("rtsp_port") or 554),
            stream=str(cfg.get("stream") or "sub"),
        )
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    result = probe_stream(
        url,
        use_tcp=bool(cfg.get("use_tcp_transport", True)),
        timeout_sec=timeout_sec,
        username=str(cfg.get("username") or "admin"),
        password=str(cfg.get("password") or ""),
    )
    result["rtsp_url_masked"] = url.replace(cfg.get("password") or "", "********") if cfg.get("password") else url
    return result


def _local_ipv4_addresses() -> list[str]:
    """Collect IPv4 addresses for this PC (Windows-friendly)."""
    addrs: set[str] = set()
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("203.0.113.1", 1))
            addrs.add(sock.getsockname()[0])
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith("127."):
                addrs.add(ip)
    except OSError:
        pass
    if sys.platform == "win32":
        try:
            out = subprocess.check_output(
                [
                    "powershell",
                    "-NoProfile",
                    "-Command",
                    "Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | "
                    "Where-Object { $_.IPAddress -notmatch '^127\\.' } | "
                    "Select-Object -ExpandProperty IPAddress",
                ],
                text=True,
                timeout=8,
                stderr=subprocess.DEVNULL,
            )
            for line in out.splitlines():
                ip = line.strip()
                if ip and not ip.startswith("127."):
                    addrs.add(ip)
        except Exception:
            pass
    return sorted(addrs)


def diagnose_connectivity(cfg: dict[str, Any] | None = None) -> dict[str, Any]:
    """Explain why cloud/LAN connect may fail — used by settings UI (no long probes)."""
    cfg = cfg or dahua_hero_a1_config()
    lan_host = str(cfg.get("host") or "").strip()
    rtsp_port = int(cfg.get("rtsp_port") or 554)
    pc_ips = _local_ipv4_addresses()
    pc_subnets = {
        ".".join(ip.split(".")[:3])
        for ip in pc_ips
        if ip.count(".") == 3 and not ip.startswith("127.")
    }
    cam_subnet = ".".join(lan_host.split(".")[:3]) if lan_host.count(".") == 3 else ""
    subnet_mismatch = bool(
        cam_subnet and cam_subnet not in pc_subnets and not lan_host.startswith("127.")
    )

    rtsp_reachable = False
    rtsp_error: str | None = None
    if lan_host and not lan_host.startswith("127."):
        try:
            with socket.create_connection((lan_host, rtsp_port), timeout=3.0):
                rtsp_reachable = True
        except OSError as exc:
            rtsp_error = str(exc)

    tunnel: dict[str, Any] = {}
    try:
        from .dahua_p2p_tunnel import get_p2p_tunnel_manager

        tunnel = get_p2p_tunnel_manager().status()
    except Exception:
        pass

    last_err = str(tunnel.get("last_error") or "")
    ptcp_blocked = "PTCP" in last_err or "ptcp" in last_err.lower()
    tunnel_running = bool(tunnel.get("running"))

    fixes: list[str] = []
    if subnet_mismatch:
        fixes.append(
            f"Your PC is on {', '.join(pc_ips) or 'unknown'} but the camera IP is {lan_host}. "
            "Connect this PC to the same Wi‑Fi as the camera, open DMSS → Device info, "
            "copy the new IP into LAN IP (fallback), then try again."
        )
    elif lan_host and not rtsp_reachable and not subnet_mismatch:
        fixes.append(
            f"Camera at {lan_host}:{rtsp_port} is not reachable from this PC "
            f"({rtsp_error or 'timeout'}). Confirm IP in DMSS or use Scan network below."
        )
    if not tunnel_running and (ptcp_blocked or str(tunnel.get("phase") or "") in ("failed", "auth")):
        fixes.append(
            "Cloud video tunnel did not finish (UDP/PTCP blocked on many home/office networks). "
            "LAN on the same Wi‑Fi is the most reliable fix; DMSS on your phone may still work."
        )
    if not fixes:
        fixes.append(
            "Re-enter the device password from DMSS (not your email login, not the QR security code)."
        )

    return {
        "pc_ips": pc_ips,
        "camera_host": lan_host,
        "subnet_mismatch": subnet_mismatch,
        "lan_rtsp_reachable": rtsp_reachable,
        "lan_rtsp_error": rtsp_error,
        "cloud_tunnel_running": tunnel_running,
        "cloud_tunnel_phase": tunnel.get("phase"),
        "cloud_tunnel_message": tunnel.get("phase_message"),
        "fixes": fixes,
    }


def _is_scan_worthy_ipv4(ip: str) -> bool:
    """RFC1918 LAN addresses only — skip link-local APIPA and loopback."""
    try:
        addr = ipaddress.IPv4Address(ip)
    except ValueError:
        return False
    if addr.is_loopback or str(addr).startswith("169.254."):
        return False
    return addr.is_private


def _subnet_base_for_ip(ip: str) -> int:
    parts = ip.split(".")
    return int(ipaddress.IPv4Address(".".join(parts[:3]) + ".0"))


def _local_ipv4_networks(*, saved_host: str = "") -> list[tuple[int, int]]:
    """Return /24 subnets to scan (saved host first, then this PC's LAN interfaces)."""
    nets: list[tuple[int, int]] = []
    seen_bases: set[int] = set()

    if saved_host and _is_scan_worthy_ipv4(saved_host):
        base = _subnet_base_for_ip(saved_host)
        seen_bases.add(base)
        nets.append((base, 24))

    for ip in _local_ipv4_addresses():
        if not _is_scan_worthy_ipv4(ip):
            continue
        base = _subnet_base_for_ip(ip)
        if base not in seen_bases:
            seen_bases.add(base)
            nets.append((base, 24))

    if not nets:
        for fallback in ("192.168.1.0", "10.0.0.0"):
            base = int(ipaddress.IPv4Address(fallback))
            if base not in seen_bases:
                seen_bases.add(base)
                nets.append((base, 24))
    return nets[:6]


def _port_open(host: str, port: int, timeout: float = 0.35) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def _probe_host_ports(ip: str, timeout: float) -> dict[str, Any] | None:
    rtsp = _port_open(ip, 554, timeout=timeout)
    sdk = _port_open(ip, 37777, timeout=timeout)
    http = _port_open(ip, 80, timeout=timeout)
    if not rtsp and not sdk and not http:
        return None
    score = (2 if rtsp else 0) + (2 if sdk else 0) + (1 if http else 0)
    return {
        "host": ip,
        "rtsp_port_open": rtsp,
        "dahua_sdk_port_open": sdk,
        "http_port_open": http,
        "confidence": "high" if score >= 3 else "medium",
        "likely_model": "DH-H3A / Dahua IP camera" if score >= 2 else "IP camera",
    }


def discover_hero_a1_candidates(
    *,
    timeout_per_host: float = 0.12,
    workers: int = 64,
) -> dict[str, Any]:
    """
    Scan local /24 subnets for Dahua-like open ports (554 RTSP, 37777 SDK, 80 HTTP).
    Uses parallel probes and includes 10.x / 192.168.x from real interfaces.
    """
    cfg = dahua_hero_a1_config()
    saved_host = str(cfg.get("host") or "").strip()
    networks = _local_ipv4_networks(saved_host=saved_host)
    subnets = [str(ipaddress.IPv4Address(net_int)) for net_int, _ in networks]
    local_ips = [ip for ip in _local_ipv4_addresses() if _is_scan_worthy_ipv4(ip)]

    to_scan: list[str] = []
    seen: set[str] = set()

    if saved_host and saved_host not in seen:
        seen.add(saved_host)
        to_scan.append(saved_host)

    for net_int, prefix in networks:
        if prefix != 24:
            continue
        base = net_int & 0xFFFFFF00
        for host_offset in range(1, 255):
            ip = str(ipaddress.IPv4Address(base + host_offset))
            if ip in seen:
                continue
            seen.add(ip)
            to_scan.append(ip)

    candidates: list[dict[str, Any]] = []
    max_workers = max(8, min(int(workers), 96))
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = {
            pool.submit(_probe_host_ports, ip, timeout_per_host): ip for ip in to_scan
        }
        for fut in as_completed(futures):
            try:
                row = fut.result()
                if row:
                    candidates.append(row)
            except Exception:
                pass

    candidates.sort(
        key=lambda c: (c["rtsp_port_open"], c["dahua_sdk_port_open"], c.get("http_port_open", False)),
        reverse=True,
    )
    return {
        "candidates": candidates[:16],
        "scanned_subnets": subnets,
        "local_ips": local_ips,
        "hosts_checked": len(to_scan),
    }


def ptz_command(
    *,
    host: str,
    username: str,
    password: str,
    http_port: int = 80,
    action: str,
    code: str,
    arg2: int = 1,
    channel: int = 1,
    timeout: float = 4.0,
) -> dict[str, Any]:
    """
    Dahua HTTP PTZ CGI (pan/tilt for Hero A1).
    action: start | stop
    code: Up, Down, Left, Right, ZoomTele, ZoomWide, etc.
    """
    import urllib.error
    import urllib.request
    from base64 import b64encode

    host = host.strip()
    if not host:
        return {"ok": False, "error": "Camera host not configured."}
    act = action.strip().lower()
    if act not in ("start", "stop"):
        return {"ok": False, "error": "action must be start or stop"}
    url = (
        f"http://{host}:{int(http_port)}/cgi-bin/ptz.cgi"
        f"?action={act}&channel={int(channel)}&code={quote(code)}"
        f"&arg1=0&arg2={int(arg2)}&arg3=0"
    )
    req = urllib.request.Request(url, method="GET")
    token = b64encode(f"{username}:{password}".encode()).decode()
    req.add_header("Authorization", f"Basic {token}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read(512).decode("utf-8", errors="replace")
        return {"ok": True, "response": body.strip()[:200]}
    except urllib.error.HTTPError as exc:
        return {"ok": False, "error": f"HTTP {exc.code}", "detail": str(exc.reason)}
    except TimeoutError:
        return {
            "ok": False,
            "error": (
                "PTZ timed out. Hero A1 often has no HTTP API — use the DMSS app for pan/tilt, "
                "or switch to Same Wi-Fi (LAN) if the camera exposes HTTP on your network."
            ),
        }
    except OSError as exc:
        msg = str(exc).lower()
        if "timed out" in msg or "timeout" in msg:
            return {
                "ok": False,
                "error": "PTZ not reachable on HTTP (port 80). Use DMSS for pan/tilt in cloud mode.",
            }
        return {"ok": False, "error": str(exc)}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


# Map UI directions → Imou cloud PTZ operations (controlMovePTZ).
_CLOUD_PTZ_OPS = {
    "up": "up",
    "down": "down",
    "left": "left",
    "right": "right",
    "zoom_in": "zoom_in",
    "zoom_out": "zoom_out",
    "stop": "stop",
}


def ptz_supported(cfg: dict[str, Any]) -> bool:
    """True if this camera can pan/tilt: cloud HLS (with serial) or LAN HTTP CGI."""
    mode = _connection_mode(cfg)
    if mode == "cloud_hls":
        return bool(str(cfg.get("device_serial") or "").strip())
    return bool(str(cfg.get("host") or "").strip())


def wifi_supported(cfg: dict[str, Any]) -> bool:
    """True if we can manage this camera's Wi-Fi over the cloud (Easy4IP, with serial)."""
    if not str(cfg.get("device_serial") or "").strip():
        return False
    try:
        from .easy4ip_openapi import get_openapi_client

        return get_openapi_client(cfg) is not None
    except Exception:
        return False


def ptz_for_camera(cfg: dict[str, Any], direction: str, *, duration: int = 1) -> dict[str, Any]:
    """PTZ for any camera cfg: cloud (Easy4IP controlMovePTZ) or LAN (Dahua CGI)."""
    mode = _connection_mode(cfg)
    direction = (direction or "").strip().lower()

    if mode == "cloud_hls":
        op = _CLOUD_PTZ_OPS.get(direction)
        if not op:
            return {"ok": False, "error": f"Unsupported PTZ direction for cloud camera: {direction}"}
        from .easy4ip_openapi import easy4ip_ptz

        # UI duration is a 1..8 "nudge" scale; map to a sensible millisecond pulse.
        duration_ms = max(1, min(8, int(duration))) * 350
        return easy4ip_ptz(cfg, op, duration_ms)

    # LAN / HTTP CGI fallback
    host = str(cfg.get("host") or "").strip()
    if not host:
        return {"ok": False, "error": "Camera has no LAN IP and is not in cloud mode — cannot pan/tilt."}
    code_map = {"up": "Up", "down": "Down", "left": "Left", "right": "Right", "home": "ToPreset"}
    code = code_map.get(direction)
    if not code:
        return {"ok": False, "error": f"Unknown direction: {direction}"}
    username = str(cfg.get("username") or "admin")
    password = str(cfg.get("password") or "")
    http_port = int(cfg.get("http_port") or 80)
    start = ptz_command(
        host=host, username=username, password=password, http_port=http_port,
        action="start", code=code, arg2=max(1, min(8, int(duration))),
    )
    if not start.get("ok"):
        return start
    time.sleep(0.25)
    stop = ptz_command(
        host=host, username=username, password=password, http_port=http_port,
        action="stop", code=code,
    )
    return {"ok": True, "start": start, "stop": stop}


def ptz_info_for_source(source: str | None) -> dict[str, Any]:
    """Map a live source string to its camera id + PTZ capability for the UI.

    Returns {camera_id, ptz_supported}. Non-Dahua sources (USB index, plain
    RTSP) report no PTZ here."""
    if not is_dahua_alias(source):
        return {"camera_id": None, "ptz_supported": False, "wifi_supported": False}
    cid = dahua_id_from_source(source)
    cfg = _camera_cfg_for_id(cid)
    return {
        "camera_id": cid,
        "ptz_supported": bool(cfg and ptz_supported(cfg)),
        "wifi_supported": bool(cfg and wifi_supported(cfg)),
    }


def ptz_move(direction: str, *, duration: int = 1) -> dict[str, Any]:
    cfg = dahua_hero_a1_config()
    host = str(cfg.get("host") or "").strip()
    if not host:
        return {"ok": False, "error": "Configure Hero A1 IP in Settings first."}
    code_map = {
        "up": "Up",
        "down": "Down",
        "left": "Left",
        "right": "Right",
        "home": "ToPreset",
    }
    code = code_map.get(direction.strip().lower())
    if not code:
        return {"ok": False, "error": f"Unknown direction: {direction}"}
    start = ptz_command(
        host=host,
        username=str(cfg.get("username") or "admin"),
        password=str(cfg.get("password") or ""),
        http_port=int(cfg.get("http_port") or 80),
        action="start",
        code=code,
        arg2=max(1, min(8, int(duration))),
    )
    if not start.get("ok"):
        return start
    time.sleep(0.25)
    stop = ptz_command(
        host=host,
        username=str(cfg.get("username") or "admin"),
        password=str(cfg.get("password") or ""),
        http_port=int(cfg.get("http_port") or 80),
        action="stop",
        code=code,
    )
    return {"ok": True, "start": start, "stop": stop}
