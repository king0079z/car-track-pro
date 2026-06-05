"""Persisted IP camera profiles (Dahua Hero A1, etc.)."""

from __future__ import annotations

import json
import os
from copy import deepcopy
from typing import Any

_CONFIG_FILE = os.path.join(os.path.dirname(__file__), "..", "..", "cameras.json")

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
}

DEFAULT_CONFIG: dict[str, Any] = {
    "dahua_hero_a1": deepcopy(DEFAULT_DAHUA_HERO_A1),
}


def _merge_dahua(raw: dict[str, Any] | None) -> dict[str, Any]:
    out = deepcopy(DEFAULT_DAHUA_HERO_A1)
    if not isinstance(raw, dict):
        return out
    for key in DEFAULT_DAHUA_HERO_A1:
        if key in raw and raw[key] is not None:
            out[key] = raw[key]
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
    return deepcopy(DEFAULT_CONFIG)


def save_camera_config(data: dict[str, Any]) -> dict[str, Any]:
    current = load_camera_config()
    if "dahua_hero_a1" in data and isinstance(data["dahua_hero_a1"], dict):
        current["dahua_hero_a1"] = _merge_dahua({**current["dahua_hero_a1"], **data["dahua_hero_a1"]})
    try:
        with open(_CONFIG_FILE, "w", encoding="utf-8") as fh:
            json.dump(current, fh, indent=2)
    except Exception:
        pass
    return current


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
            s = str(val).strip().lower()
            if s in ("p2p", "cloud", "remote"):
                out[key] = "p2p"
            elif s == "auto":
                out[key] = "auto"
            elif s in ("cartrack", "cartrack_relay", "cartrack_cloud"):
                out[key] = "cartrack_relay"
            else:
                out[key] = "lan"
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
