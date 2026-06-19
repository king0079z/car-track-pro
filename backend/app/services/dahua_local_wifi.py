"""
Local Dahua Wi-Fi setup (DMSS-style) over HTTP on the shop LAN.

Works when CarTrack backend can reach the camera (same Wi-Fi / camera AP):
  - Discover camera (192.168.1.108 default in AP mode)
  - Scan nearby Wi-Fi (wlan.cgi scanWlanDevices)
  - Connect camera to shop SSID (configManager WLan)

Does NOT use Imou Open Platform HTTP (that is for remote switch when already online).
"""

from __future__ import annotations

import re
import socket
import urllib.error
import urllib.request
from base64 import b64encode
from typing import Any
from urllib.parse import quote

_DEFAULT_AP_HOSTS = ("192.168.1.108", "192.168.0.108", "10.1.1.1", "192.168.1.1")
_WLAN_INTERFACE = "eth2"  # common on DH-H3A / Imou cube cameras


def _http_get(
    host: str,
    path: str,
    *,
    username: str = "admin",
    password: str = "",
    http_port: int = 80,
    timeout: float = 10.0,
) -> tuple[int, str]:
    url = f"http://{host}:{int(http_port)}{path}"
    req = urllib.request.Request(url, method="GET")
    if username or password:
        token = b64encode(f"{username}:{password}".encode()).decode()
        req.add_header("Authorization", f"Basic {token}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read(65536).decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        body = exc.read(4096).decode("utf-8", errors="replace") if exc.fp else ""
        return exc.code, body
    except (TimeoutError, OSError) as exc:
        return 0, str(exc)


def _parse_key_value_body(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if "=" not in line:
            continue
        k, _, v = line.partition("=")
        out[k.strip()] = v.strip()
    return out


def _parse_wlan_scan(text: str) -> list[dict[str, Any]]:
    """Parse wlan.cgi scanWlanDevices response."""
    kv = _parse_key_value_body(text)
    try:
        count = int(kv.get("Found Num") or kv.get("found") or "0")
    except ValueError:
        count = 0
    if count <= 0:
        # fallback: count wlanDevice[n] keys
        indices = {int(m.group(1)) for m in re.finditer(r"wlanDevice\[(\d+)\]\.", text)}
        count = max(indices) + 1 if indices else 0
    nets: list[dict[str, Any]] = []
    for i in range(max(count, 0)):
        prefix = f"wlanDevice[{i}]."
        ssid = kv.get(f"{prefix}SSID") or kv.get(f"{prefix}ssid")
        if not ssid:
            continue
        bssid = kv.get(f"{prefix}BSSID") or kv.get(f"{prefix}bssid") or ""
        try:
            quality = int(kv.get(f"{prefix}LinkQuality") or kv.get(f"{prefix}RSSIQuality") or 0)
        except ValueError:
            quality = 0
        nets.append({"ssid": ssid, "bssid": bssid, "intensity": min(5, max(0, quality // 6)), "index": i})
    return nets


def probe_local_camera(
    host: str,
    *,
    username: str = "admin",
    password: str = "",
    http_port: int = 80,
    timeout: float = 10.0,
) -> dict[str, Any]:
    host = host.strip()
    if not host:
        return {"ok": False, "error": "Camera IP is required."}
    for pwd in [password, ""]:
        status, body = _http_get(
            host,
            "/cgi-bin/magicBox.cgi?action=getSerialNo",
            username=username,
            password=pwd,
            http_port=http_port,
            timeout=timeout,
        )
        if status == 200 and "serialNumber=" in body.lower():
            kv = _parse_key_value_body(body.replace("serialNumber=", "serialNumber="))
            serial = kv.get("serialNumber") or ""
            if not serial:
                m = re.search(r"serialNumber=([^\r\n]+)", body, re.I)
                serial = m.group(1).strip() if m else ""
            return {
                "ok": True,
                "host": host,
                "serial": serial.upper(),
                "auth_password": pwd if pwd else None,
                "needs_password": pwd == "" and bool(password),
            }
    return {
        "ok": False,
        "error": f"Camera not reachable at {host}:{http_port} (HTTP {status or 'timeout'}).",
        "detail": body[:200] if body else None,
    }


def scan_local_wlan(
    host: str,
    *,
    username: str = "admin",
    password: str = "",
    http_port: int = 80,
) -> dict[str, Any]:
    host = host.strip()
    path = "/cgi-bin/wlan.cgi?action=scanWlanDevices"
    last_body = ""
    for pwd in [password, ""]:
        status, body = _http_get(host, path, username=username, password=pwd, http_port=http_port)
        last_body = body
        if status == 200:
            nets = _parse_wlan_scan(body)
            return {"ok": True, "host": host, "networks": nets, "raw_preview": body[:400]}
    return {
        "ok": False,
        "error": "Wi-Fi scan failed — wrong password or camera not in setup mode.",
        "detail": last_body[:300],
    }


def connect_local_wlan(
    host: str,
    *,
    ssid: str,
    wifi_password: str,
    username: str = "admin",
    device_password: str = "",
    http_port: int = 80,
    interface: str = _WLAN_INTERFACE,
) -> dict[str, Any]:
    """Push shop Wi-Fi credentials to the camera (DMSS Soft AP / LAN setup step)."""
    host = host.strip()
    ssid = ssid.strip()
    if not host or not ssid:
        return {"ok": False, "error": "Camera IP and Wi-Fi SSID are required."}
    iface = interface.strip() or _WLAN_INTERFACE
    enc = "WPA-PSK-CCMP" if wifi_password else "Off"
    params = {
        f"WLan.{iface}.Enable": "true",
        f"WLan.{iface}.SSID": ssid,
        f"WLan.{iface}.LinkMode": "Infrastructure",
        f"WLan.{iface}.Encryption": enc,
        f"WLan.{iface}.KeyFlag": "true" if wifi_password else "false",
        f"WLan.{iface}.KeyID": "0",
        f"WLan.{iface}.KeyType": "ASCII",
        f"WLan.{iface}.Keys[0]": wifi_password,
    }
    qs = "&".join(f"{quote(k, safe='')}={quote(v, safe='')}" for k, v in params.items())
    path = f"/cgi-bin/configManager.cgi?action=setConfig&{qs}"
    last_body = ""
    for pwd in [device_password, ""]:
        status, body = _http_get(host, path, username=username, password=pwd, http_port=http_port, timeout=25.0)
        last_body = body
        if status == 200 and "OK" in body.upper():
            return {
                "ok": True,
                "host": host,
                "ssid": ssid,
                "message": "Wi-Fi sent to camera — it may reboot (wait 1–2 minutes, then bind in CarTrack).",
            }
    return {
        "ok": False,
        "error": "Could not apply Wi-Fi settings on the camera.",
        "detail": last_body[:300],
    }


def discover_ap_mode_cameras(*, http_port: int = 80) -> dict[str, Any]:
    """Try common Dahua AP-mode IPs on networks reachable from this backend."""
    from .dahua_camera import _local_ipv4_addresses, discover_hero_a1_candidates

    found: list[dict[str, Any]] = []
    seen: set[str] = set()

    for host in _DEFAULT_AP_HOSTS:
        if host in seen:
            continue
        seen.add(host)
        pr = probe_local_camera(host, http_port=http_port, timeout=3.0)
        if pr.get("ok"):
            found.append(pr)

    local_ips = [ip for ip in _local_ipv4_addresses() if not ip.startswith("127.")]
    remote_server = bool(
        local_ips
        and all(ip.startswith("172.") or ip.startswith("127.") for ip in local_ips)
    )

    if not remote_server:
        disc = discover_hero_a1_candidates(timeout_per_host=0.12, workers=64)
        for c in disc.get("candidates") or []:
            h = str(c.get("host") or "")
            if not h or h in seen:
                continue
            seen.add(h)
            pr = probe_local_camera(h, http_port=http_port, timeout=3.0)
            if pr.get("ok"):
                pr["discovered_via"] = "port_scan"
                found.append(pr)
        scanned = disc.get("scanned_subnets") or []
    else:
        scanned = []
        local_ips = []

    return {
        "ok": bool(found),
        "cameras": found,
        "local_ips": local_ips,
        "scanned_subnets": scanned,
        "requires_shop_network": remote_server or not found,
        "remote_server": remote_server,
        "hint": (
            "Join the camera hotspot Dahua_XXXX on this device (IP 192.168.1.108), then tap Find camera. "
            "The cloud server cannot reach 192.168.x — use your phone/PC on the camera Wi‑Fi."
            if remote_server
            else "Run this at the shop on the same Wi-Fi as the camera, or connect to the camera hotspot."
        ),
    }
