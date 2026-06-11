"""Persisted IP camera profiles (Dahua Hero A1, etc.) + multi-camera registry."""

from __future__ import annotations

import json
import os
import re
from copy import deepcopy
from typing import Any

# Cloud deploy stores the camera registry in the bind-mounted data dir so it
# survives container recreates; local dev falls back to backend/cameras.json.
_DATA_DIR = os.environ.get("CARTRACK_DATA_DIR")
if _DATA_DIR and os.path.isdir(_DATA_DIR):
    _CONFIG_FILE = os.path.join(_DATA_DIR, "cameras.json")
else:
    _CONFIG_FILE = os.path.join(os.path.dirname(__file__), "..", "..", "cameras.json")

# Base localhost port for the first Dahua cloud (P2P) tunnel; each extra cloud
# camera gets the next free port (18554, 18555, ...).
P2P_PORT_BASE = 18554

DEFAULT_DAHUA_HERO_A1: dict[str, Any] = {
    "enabled": False,
    "host": "",
    "rtsp_port": 554,
    "http_port": 80,
    "username": "admin",
    "password": "",
    "stream": "sub",  # sub = lower latency for live ANPR; main = full 1080p
    "label": "Dahua Hero A1",
    "use_tcp_transport": True,
    # lan | auto | p2p | cartrack_relay (your media server, not Dahua Easy4IP)
    "connection_mode": "lan",
    "cartrack_relay_publish_url": "",
    "cartrack_relay_view_url": "",
    "p2p_local_port": 18554,
    # From device QR: {SN:...,DT:...,SC:...} — used for DMSS pairing hints, not RTSP auth
    "device_serial": "",
    "device_type": "",
    "security_code": "",
    # Cached from cloud /info/device — speeds cloud tunnel start (DH-H3A)
    "p2p_randsalt": "",
    # Imou / Easy4IP Open Platform (connection_mode=cloud_hls) — cloud HLS path.
    # Secrets normally come from env (IMOU_APP_ID/IMOU_APP_SECRET); kept here so
    # the resolver can read them from the camera cfg too.
    "openapi_app_id": "",
    "openapi_app_secret": "",
    "openapi_base_url": "",
    "openapi_channel": "0",
    "openapi_prefer_hd": True,
}

DEFAULT_CONFIG: dict[str, Any] = {
    "dahua_hero_a1": deepcopy(DEFAULT_DAHUA_HERO_A1),
}


def _normalize_connection_mode(raw: str | None) -> str:
    s = str(raw or "lan").strip().lower()
    if s in ("cloud_hls", "easy4ip", "openapi", "imou", "easy4ip_hls"):
        return "cloud_hls"
    if s in ("p2p", "cloud", "remote"):
        return "p2p"
    if s == "auto":
        return "auto"
    if s in ("cartrack", "cartrack_relay", "cartrack_cloud"):
        return "cartrack_relay"
    return "lan"


def _env_dahua_overrides() -> dict[str, Any]:
    """Cloud deploy: DAHUA_* env vars override cameras.json (survives container redeploy)."""
    try:
        from ..config import settings
    except Exception:
        return {}

    serial = (settings.DAHUA_DEVICE_SERIAL or "").strip().upper()
    password = settings.DAHUA_PASSWORD or ""
    username = (settings.DAHUA_USERNAME or "admin").strip() or "admin"
    host = (settings.DAHUA_HOST or "").strip()
    device_type = (settings.DAHUA_DEVICE_TYPE or "").strip()
    stream = str(settings.DAHUA_STREAM or "sub").strip().lower()
    mode = _normalize_connection_mode(settings.DAHUA_CONNECTION_MODE or "p2p")

    has_credentials = bool(serial and password)
    # Cloud HLS only needs the serial + OpenAPI app creds (no device password).
    _imou_ready = bool(
        (getattr(settings, "IMOU_APP_ID", "") or "").strip()
        and (getattr(settings, "IMOU_APP_SECRET", "") or "").strip()
    )
    has_cloud_hls = mode == "cloud_hls" and bool(serial) and _imou_ready
    has_any = has_credentials or has_cloud_hls or settings.DAHUA_ENABLED or bool(host)
    if not has_any:
        return {}

    patch: dict[str, Any] = {"connection_mode": mode}
    if serial:
        patch["device_serial"] = serial
    if password:
        patch["password"] = password

    # Imou/Easy4IP Open Platform creds for the cloud_hls path.
    app_id = (getattr(settings, "IMOU_APP_ID", "") or "").strip()
    app_secret = (getattr(settings, "IMOU_APP_SECRET", "") or "").strip()
    if app_id:
        patch["openapi_app_id"] = app_id
    if app_secret:
        patch["openapi_app_secret"] = app_secret
    base_url = (getattr(settings, "IMOU_BASE_URL", "") or "").strip()
    if base_url:
        patch["openapi_base_url"] = base_url
    patch["openapi_channel"] = (getattr(settings, "IMOU_CHANNEL", "") or "0").strip() or "0"
    patch["openapi_prefer_hd"] = bool(getattr(settings, "IMOU_PREFER_HD", True))
    if username:
        patch["username"] = username
    if host:
        patch["host"] = host
    if device_type:
        patch["device_type"] = device_type
    patch["stream"] = "main" if stream == "main" else "sub"
    patch["p2p_local_port"] = max(1024, min(65535, int(settings.DAHUA_P2P_LOCAL_PORT or 18554)))

    publish = (settings.CARTRACK_RELAY_PUBLISH_URL or "").strip()
    view = (settings.CARTRACK_RELAY_VIEW_URL or "").strip()
    if publish:
        patch["cartrack_relay_publish_url"] = publish
    if view:
        patch["cartrack_relay_view_url"] = view

    if settings.DAHUA_ENABLED:
        patch["enabled"] = True
    elif has_credentials and mode in ("p2p", "auto"):
        # Cloud VPS: serial + password + p2p mode → enable without extra flag
        patch["enabled"] = True
    elif has_cloud_hls:
        # Cloud VPS: serial + OpenAPI creds + cloud_hls mode → enable automatically
        patch["enabled"] = True

    return patch


def dahua_env_active() -> bool:
    """True when DAHUA_* env vars supply cloud camera settings."""
    return bool(_env_dahua_overrides())


def dahua_prewarm_on_startup() -> bool:
    """Whether startup should prewarm Easy4IP when env-based cloud config is present."""
    if not dahua_env_active():
        return False
    try:
        from ..config import settings

        return bool(settings.DAHUA_P2P_PREWARM_ON_STARTUP)
    except Exception:
        return True


def _merge_dahua(raw: dict[str, Any] | None) -> dict[str, Any]:
    out = deepcopy(DEFAULT_DAHUA_HERO_A1)
    if not isinstance(raw, dict):
        raw = {}
    for key in DEFAULT_DAHUA_HERO_A1:
        if key in raw and raw[key] is not None:
            out[key] = raw[key]
    env_patch = _env_dahua_overrides()
    if env_patch:
        out.update(env_patch)
    return out


def load_camera_config() -> dict[str, Any]:
    try:
        if os.path.exists(_CONFIG_FILE):
            with open(_CONFIG_FILE, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            if isinstance(data, dict):
                return {"dahua_hero_a1": _merge_dahua(data.get("dahua_hero_a1"))}
    except Exception:
        pass
    return {"dahua_hero_a1": _merge_dahua(None)}


def save_camera_config(data: dict[str, Any]) -> dict[str, Any]:
    current = load_camera_config()
    if "dahua_hero_a1" in data and isinstance(data["dahua_hero_a1"], dict):
        # Persist UI edits to file; env overrides still apply on next load.
        raw = _read_raw()
        merged_file = _merge_dahua({**raw.get("dahua_hero_a1", {}), **data["dahua_hero_a1"]})
        raw["dahua_hero_a1"] = merged_file
        # Never drop the multi-camera registry when saving the legacy profile.
        _write_raw(raw)
        current["dahua_hero_a1"] = _merge_dahua(merged_file)
    return current


# ── Raw file I/O (preserves both the legacy profile and the cameras[] registry) ──

def _read_raw() -> dict[str, Any]:
    try:
        if os.path.exists(_CONFIG_FILE):
            with open(_CONFIG_FILE, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            if isinstance(data, dict):
                return data
    except Exception:
        pass
    return {}


def _write_raw(data: dict[str, Any]) -> None:
    try:
        with open(_CONFIG_FILE, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2)
    except Exception:
        pass


# ── Multi-camera registry ────────────────────────────────────────────────────
# A camera is either a Dahua Easy4IP/P2P cloud device (type "dahua_p2p") or a
# generic RTSP/NVR stream (type "rtsp"). The legacy single Dahua profile
# (``dahua_hero_a1``) is surfaced as camera id "hero-a1" for backward compat.

DEFAULT_CAMERA: dict[str, Any] = {
    "id": "",
    "name": "",
    "type": "rtsp",              # "rtsp" | "dahua_p2p"
    "enabled": False,
    "slot_index": 0,
    "connection_mode": "auto",   # dahua: lan | auto | p2p (ignored for rtsp)
    # Dahua cloud / LAN
    "device_serial": "",
    "device_type": "",
    "security_code": "",
    "p2p_local_port": P2P_PORT_BASE,
    "p2p_randsalt": "",
    # Shared network credentials
    "host": "",
    "rtsp_port": 554,
    "http_port": 80,
    "username": "admin",
    "password": "",
    "stream": "sub",
    "use_tcp_transport": True,
    # Imou / Easy4IP Open Platform (connection_mode=cloud_hls)
    "openapi_app_id": "",
    "openapi_app_secret": "",
    "openapi_base_url": "",
    "openapi_channel": "0",
    "openapi_prefer_hd": True,
    # Generic RTSP / NVR
    "rtsp_url": "",
    # Per-camera speed calibration: metres represented by one pixel of motion.
    # 0 = use the global default (settings.YOLO11_METER_PER_PIXEL). Set this from
    # a known reference (lane width / two ground points) for accurate speed.
    "meter_per_pixel": 0.0,
    # Service bay this camera monitors (auto-fills work orders from ANPR).
    "assigned_bay": None,
}


def _slugify(value: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", str(value or "").strip().lower()).strip("-")
    return s[:40]


def _normalize_camera_type(raw: str | None) -> str:
    s = str(raw or "rtsp").strip().lower()
    if s in ("dahua", "dahua_p2p", "dahua_lan", "p2p", "easy4ip"):
        return "dahua_p2p"
    return "rtsp"


def _merge_camera(raw: dict[str, Any] | None) -> dict[str, Any]:
    out = deepcopy(DEFAULT_CAMERA)
    if isinstance(raw, dict):
        for key in DEFAULT_CAMERA:
            if key in raw and raw[key] is not None:
                out[key] = raw[key]
        # accept "name" provided as label
        if not out.get("name") and raw.get("label"):
            out["name"] = raw["label"]
    out["type"] = _normalize_camera_type(out.get("type"))
    out["connection_mode"] = _normalize_connection_mode(out.get("connection_mode"))
    out["enabled"] = bool(out.get("enabled"))
    out["use_tcp_transport"] = bool(out.get("use_tcp_transport"))
    out["stream"] = "main" if str(out.get("stream")).lower() == "main" else "sub"
    for k, default in (("slot_index", 0), ("p2p_local_port", P2P_PORT_BASE),
                       ("rtsp_port", 554), ("http_port", 80)):
        try:
            out[k] = int(out.get(k))
        except (TypeError, ValueError):
            out[k] = default
    try:
        out["meter_per_pixel"] = max(0.0, float(out.get("meter_per_pixel") or 0.0))
    except (TypeError, ValueError):
        out["meter_per_pixel"] = 0.0
    out["id"] = str(out.get("id") or "").strip()
    out["device_serial"] = str(out.get("device_serial") or "").strip().upper()
    return out


def _hero_as_camera() -> dict[str, Any] | None:
    """Expose the legacy ``dahua_hero_a1`` profile as camera id 'hero-a1'."""
    cfg = _merge_dahua(_read_raw().get("dahua_hero_a1"))
    configured = bool(cfg.get("enabled") or cfg.get("device_serial") or cfg.get("host"))
    if not configured:
        return None
    return _merge_camera({
        "id": "hero-a1",
        "name": cfg.get("label") or "Dahua Hero A1",
        "type": "dahua_p2p",
        "enabled": bool(cfg.get("enabled")),
        "slot_index": 0,
        "connection_mode": cfg.get("connection_mode") or "auto",
        "device_serial": cfg.get("device_serial", ""),
        "device_type": cfg.get("device_type", ""),
        "security_code": cfg.get("security_code", ""),
        "p2p_local_port": cfg.get("p2p_local_port") or P2P_PORT_BASE,
        "p2p_randsalt": cfg.get("p2p_randsalt", ""),
        "host": cfg.get("host", ""),
        "rtsp_port": cfg.get("rtsp_port") or 554,
        "http_port": cfg.get("http_port") or 80,
        "username": cfg.get("username", "admin"),
        "password": cfg.get("password", ""),
        "stream": cfg.get("stream", "sub"),
        "use_tcp_transport": cfg.get("use_tcp_transport", True),
        "openapi_app_id": cfg.get("openapi_app_id", ""),
        "openapi_app_secret": cfg.get("openapi_app_secret", ""),
        "openapi_base_url": cfg.get("openapi_base_url", ""),
        "openapi_channel": cfg.get("openapi_channel", "0"),
        "openapi_prefer_hd": cfg.get("openapi_prefer_hd", True),
    })


def _env_rtsp_camera() -> dict[str, Any] | None:
    """Expose ``LIVE_RTSP_URL`` (cloud/HF deploy) as the enabled camera 'cloud-rtsp'.

    Lets a hosted server with no LAN/P2P access run live ANPR off a single env var
    pointing at an internet-reachable stream (relay view URL, public RTSP-over-TCP,
    or HLS). Controlled entirely by env — UI edits don't persist to it.
    """
    try:
        from ..config import settings
    except Exception:
        return None
    url = (settings.LIVE_RTSP_URL or "").strip()
    if not url:
        return None
    try:
        slot = int(settings.LIVE_RTSP_SLOT)
    except (TypeError, ValueError):
        slot = 0
    try:
        mpp = max(0.0, float(settings.LIVE_RTSP_METER_PER_PIXEL or 0.0))
    except (TypeError, ValueError):
        mpp = 0.0
    return _merge_camera({
        "id": "cloud-rtsp",
        "name": (settings.LIVE_RTSP_NAME or "Cloud Camera").strip() or "Cloud Camera",
        "type": "rtsp",
        "enabled": True,
        "slot_index": slot,
        "rtsp_url": url,
        "meter_per_pixel": mpp,
    })


def list_cameras() -> list[dict[str, Any]]:
    """All registered cameras (registry array + legacy hero-a1 + env RTSP), sorted by slot."""
    raw = _read_raw()
    entries = raw.get("cameras")
    cams: list[dict[str, Any]] = []
    seen: set[str] = set()
    if isinstance(entries, list):
        for entry in entries:
            cam = _merge_camera(entry)
            if not cam["id"] or cam["id"] in seen:
                continue
            cams.append(cam)
            seen.add(cam["id"])
    env_rtsp = _env_rtsp_camera()
    if env_rtsp and env_rtsp["id"] not in seen:
        cams.append(env_rtsp)
        seen.add(env_rtsp["id"])
    if "hero-a1" not in seen:
        hero = _hero_as_camera()
        if hero:
            cams.insert(0, hero)
    cams.sort(key=lambda c: int(c.get("slot_index") or 0))
    return cams


def get_camera(camera_id: str) -> dict[str, Any] | None:
    cid = (camera_id or "").strip()
    for cam in list_cameras():
        if cam["id"] == cid:
            return cam
    return None


def _allocate_slot(cams: list[dict[str, Any]]) -> int:
    used = {int(c.get("slot_index") or 0) for c in cams}
    idx = 0
    while idx in used:
        idx += 1
    return idx


def _allocate_p2p_port(cams: list[dict[str, Any]]) -> int:
    used = {int(c.get("p2p_local_port") or 0) for c in cams if c.get("type") == "dahua_p2p"}
    port = P2P_PORT_BASE
    while port in used:
        port += 1
    return port


def sanitize_camera_patch(body: dict[str, Any]) -> dict[str, Any]:
    allowed = set(DEFAULT_CAMERA) | {"name", "label"}
    out: dict[str, Any] = {}
    for key, val in body.items():
        if key not in allowed:
            continue
        if key == "label":
            out["name"] = str(val).strip() if val is not None else ""
        elif key in ("enabled", "use_tcp_transport", "openapi_prefer_hd"):
            out[key] = bool(val) if isinstance(val, bool) else str(val).lower() in ("1", "true", "yes", "on")
        elif key in ("rtsp_port", "http_port", "p2p_local_port", "slot_index", "assigned_bay"):
            try:
                out[key] = int(val) if val not in (None, "") else None
            except (TypeError, ValueError):
                continue
        elif key == "meter_per_pixel":
            try:
                out[key] = max(0.0, float(val))
            except (TypeError, ValueError):
                continue
        elif key == "stream":
            out[key] = "main" if str(val).lower() == "main" else "sub"
        elif key == "connection_mode":
            out[key] = _normalize_connection_mode(str(val))
        elif key == "type":
            out[key] = _normalize_camera_type(str(val))
        else:
            out[key] = str(val).strip() if val is not None else ""
    return out


def _camera_patch_to_hero(patch: dict[str, Any]) -> dict[str, Any]:
    """Map registry camera fields back onto the legacy dahua_hero_a1 schema."""
    hero: dict[str, Any] = {}
    for key in (
        "enabled", "host", "rtsp_port", "http_port", "username", "password",
        "stream", "use_tcp_transport", "connection_mode", "device_serial",
        "device_type", "security_code", "p2p_local_port", "p2p_randsalt",
    ):
        if key in patch:
            hero[key] = patch[key]
    if "name" in patch:
        hero["label"] = patch["name"]
    return hero


def add_camera(data: dict[str, Any]) -> dict[str, Any]:
    existing = list_cameras()
    cam = _merge_camera(sanitize_camera_patch(data))
    base = _slugify(cam.get("name") or cam.get("type") or "camera") or "camera"
    taken = {c["id"] for c in existing} | {"hero-a1"}
    cid, n = base, 2
    while cid in taken:
        cid = f"{base}-{n}"
        n += 1
    cam["id"] = cid
    cam["slot_index"] = _allocate_slot(existing)
    if cam["type"] == "dahua_p2p":
        cam["p2p_local_port"] = _allocate_p2p_port(existing)
    raw = _read_raw()
    arr = raw.get("cameras")
    if not isinstance(arr, list):
        arr = []
    arr.append(cam)
    raw["cameras"] = arr
    _write_raw(raw)
    return cam


def update_camera(camera_id: str, patch: dict[str, Any]) -> dict[str, Any] | None:
    cid = (camera_id or "").strip()
    clean = sanitize_camera_patch(patch)
    raw = _read_raw()
    arr = raw.get("cameras") if isinstance(raw.get("cameras"), list) else []

    # Legacy hero-a1 that lives only in dahua_hero_a1 → route to that schema.
    if cid == "hero-a1" and not any(isinstance(c, dict) and c.get("id") == "hero-a1" for c in arr):
        save_camera_config({"dahua_hero_a1": _camera_patch_to_hero(clean)})
        return get_camera("hero-a1")

    for i, entry in enumerate(arr):
        if isinstance(entry, dict) and entry.get("id") == cid:
            merged = _merge_camera({**entry, **clean, "id": cid})
            arr[i] = merged
            raw["cameras"] = arr
            _write_raw(raw)
            return merged
    return None


def delete_camera(camera_id: str) -> bool:
    cid = (camera_id or "").strip()
    raw = _read_raw()
    arr = raw.get("cameras") if isinstance(raw.get("cameras"), list) else []
    kept = [c for c in arr if not (isinstance(c, dict) and c.get("id") == cid)]
    removed = len(kept) != len(arr)
    if removed:
        raw["cameras"] = kept
        _write_raw(raw)
        return True
    # Legacy hero-a1 (not in array) → disable it.
    if cid == "hero-a1":
        save_camera_config({"dahua_hero_a1": {"enabled": False}})
        return True
    return False


def sanitize_dahua_patch(body: dict[str, Any]) -> dict[str, Any]:
    allowed = set(DEFAULT_DAHUA_HERO_A1)
    out: dict[str, Any] = {}
    for key, val in body.items():
        if key not in allowed:
            continue
        if key == "enabled" or key == "use_tcp_transport":
            out[key] = bool(val) if isinstance(val, bool) else str(val).lower() in ("1", "true", "yes", "on")
        elif key in ("rtsp_port", "http_port"):
            try:
                out[key] = max(1, min(65535, int(val)))
            except (TypeError, ValueError):
                continue
        elif key == "stream":
            s = str(val).strip().lower()
            out[key] = "main" if s == "main" else "sub"
        elif key == "connection_mode":
            out[key] = _normalize_connection_mode(str(val))
        elif key == "p2p_local_port":
            try:
                out[key] = max(1024, min(65535, int(val)))
            except (TypeError, ValueError):
                continue
        elif key in (
            "host",
            "username",
            "password",
            "label",
            "device_serial",
            "device_type",
            "security_code",
            "p2p_randsalt",
            "cartrack_relay_publish_url",
            "cartrack_relay_view_url",
        ):
            out[key] = str(val).strip() if val is not None else ""
    return out
