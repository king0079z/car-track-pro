"""
Imou / Easy4IP Open Platform client (official, supported cloud API).

This is the DMSS-grade *pure-cloud* media path discovered by reverse-engineering
the DMSS APK: instead of the fragile peer PTCP relay, we use the documented
Open Platform to obtain an **HLS (.m3u8)** live URL served by Dahua's cloud
media gateway (cmgw-vpc.lechange.com). FFmpeg/OpenCV read HLS natively over
HTTPS, so it works through any NAT/CGNAT with no on-site hardware.

Flow (https://open.imoulife.com/book/en/http/...):
  1. accessToken   -> administrator token (md5 sign over appId/appSecret), 3-day TTL
  2. bindDeviceLive-> create the device's live address (idempotent in practice)
  3. getLiveStreamInfo -> HLS URLs (streamId 0 = HD main, 1 = SD sub)

Signing (Development Specification §4):
  sign = md5( "time:{ts},nonce:{uuid},appSecret:{secret}" )  # 32-char lowercase hex
  request envelope = {"system": {ver, appId, sign, time, nonce}, "id": uuid, "params": {...}}

Config is read from the camera cfg dict first, then environment:
  IMOU_APP_ID, IMOU_APP_SECRET, IMOU_BASE_URL
Region base URLs (data center shown in console - Basic Information):
  East Asia        https://openapi-sg.easy4ip.com
  Central Europe   https://openapi-fk.easy4ip.com
  Western America  https://openapi-or.easy4ip.com
  Mainland China   https://openapi.lechange.cn
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
import time
import uuid
from typing import Any
from urllib import request as _urlrequest
from urllib.error import HTTPError, URLError

_log = logging.getLogger(__name__)

_DEFAULT_BASE_URL = "https://openapi-sg.easy4ip.com"
_HTTP_TIMEOUT = 15.0
# accessToken is valid 3 days; refresh a little early.
_TOKEN_REFRESH_MARGIN_SEC = 6 * 3600


class Easy4IpError(RuntimeError):
    """Open Platform call failed. ``code`` is the platform error code (e.g. TK1002)."""

    def __init__(self, message: str, *, code: str | None = None, method: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.method = method


class Easy4IpOpenAPI:
    """Thread-safe Imou/Easy4IP Open Platform client with token caching."""

    def __init__(self, app_id: str, app_secret: str, base_url: str | None = None) -> None:
        if not app_id or not app_secret:
            raise Easy4IpError("Easy4IP OpenAPI requires app_id and app_secret")
        self.app_id = app_id.strip()
        self.app_secret = app_secret.strip()
        self.base_url = (base_url or _DEFAULT_BASE_URL).strip().rstrip("/")
        self._token: str | None = None
        self._token_expiry: float = 0.0
        self._lock = threading.Lock()

    # ---- low-level transport -------------------------------------------------

    def _sign(self, ts: int, nonce: str) -> str:
        raw = f"time:{ts},nonce:{nonce},appSecret:{self.app_secret}"
        return hashlib.md5(raw.encode("utf-8")).hexdigest()

    def _post(self, method: str, params: dict[str, Any], *, timeout: float | None = None) -> dict[str, Any]:
        ts = int(time.time())
        nonce = str(uuid.uuid4())
        body = {
            "system": {
                "ver": "1.0",
                "appId": self.app_id,
                "sign": self._sign(ts, nonce),
                "time": ts,
                "nonce": nonce,
            },
            "id": str(uuid.uuid4()),
            "params": params,
        }
        url = f"{self.base_url}/openapi/{method}"
        data = json.dumps(body).encode("utf-8")
        req = _urlrequest.Request(
            url, data=data, headers={"Content-Type": "application/json"}, method="POST"
        )
        try:
            with _urlrequest.urlopen(req, timeout=timeout or _HTTP_TIMEOUT) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
        except HTTPError as exc:  # noqa: PERF203
            raise Easy4IpError(f"{method} HTTP {exc.code}", method=method) from exc
        except (URLError, TimeoutError, OSError) as exc:
            raise Easy4IpError(f"{method} network error: {exc}", method=method) from exc
        except ValueError as exc:
            raise Easy4IpError(f"{method} bad JSON response", method=method) from exc

        result = payload.get("result") or {}
        code = str(result.get("code") or "")
        if code and code != "0":
            msg = str(result.get("msg") or "unknown error")
            raise Easy4IpError(f"{method} -> {code}: {msg}", code=code, method=method)
        return result.get("data") or {}

    # ---- auth ----------------------------------------------------------------

    def access_token(self, *, force: bool = False) -> str:
        with self._lock:
            now = time.time()
            if not force and self._token and now < self._token_expiry:
                return self._token
            data = self._post("accessToken", {})
            token = str(data.get("accessToken") or "")
            if not token:
                raise Easy4IpError("accessToken: empty token in response", method="accessToken")
            expire = float(data.get("expireTime") or (now + 3 * 86400))
            # expireTime is an absolute epoch (seconds) per docs.
            self._token = token
            self._token_expiry = max(now + 60, expire - _TOKEN_REFRESH_MARGIN_SEC)
            _log.info("Easy4IP accessToken acquired (expires ~%.0fh)", (expire - now) / 3600.0)
            return token

    def _post_auth(self, method: str, params: dict[str, Any], *, timeout: float | None = None) -> dict[str, Any]:
        """POST with token, transparently refreshing on TK1002 (token expired)."""
        p = dict(params)
        p["token"] = self.access_token()
        try:
            return self._post(method, p, timeout=timeout)
        except Easy4IpError as exc:
            if exc.code in ("TK1002", "TK1001"):
                p["token"] = self.access_token(force=True)
                return self._post(method, p, timeout=timeout)
            raise

    # ---- device + live -------------------------------------------------------

    def device_detail(self, device_id: str, channel: str = "0") -> dict[str, Any]:
        """Online status / model / encrypt mode via deviceBaseDetailList."""
        return self._post_auth(
            "deviceBaseDetailList",
            {"deviceList": [{"deviceId": device_id, "channelList": str(channel)}]},
        )

    def check_bound(self, device_id: str) -> dict[str, Any]:
        """Return {isBind, isMine} for the device under this app account."""
        return self._post_auth("checkDeviceBindOrNot", {"deviceId": device_id})

    def bind_device(self, device_id: str, code: str = "") -> dict[str, Any]:
        """Attach the device to this app's account. ``code`` is the device admin
        password when the device has auth set, else the label security code (or
        blank if none). Fails DV1001 if still bound to another account."""
        params: dict[str, Any] = {"deviceId": device_id}
        if code:
            params["code"] = code
        return self._post_auth("bindDevice", params)

    def unbind_device(self, device_id: str) -> dict[str, Any]:
        """Release the device from this app's account (only if it is ours)."""
        return self._post_auth("unBindDevice", {"deviceId": device_id})

    # ---- PTZ (pan/tilt/zoom) -------------------------------------------------

    # controlMovePTZ operation codes (open.imoulife.com/book/en/http/device/operate)
    PTZ_OPERATIONS = {
        "up": 0,
        "down": 1,
        "left": 2,
        "right": 3,
        "upper_left": 4,
        "lower_left": 5,
        "upper_right": 6,
        "lower_right": 7,
        "zoom_in": 8,
        "zoom_out": 9,
        "stop": 10,
    }

    # ---- Wi-Fi configuration -------------------------------------------------

    def wifi_around(self, device_id: str) -> list[dict[str, Any]]:
        """List the Wi-Fi networks the device can currently see (SSID, BSSID, signal)."""
        data = self._post_auth("wifiAround", {"deviceId": device_id}, timeout=40.0)
        nets = data.get("wLan") or data.get("wifiList") or data.get("aroundWifiList") or data.get("list")
        return nets if isinstance(nets, list) else []

    def current_device_wifi(self, device_id: str) -> dict[str, Any]:
        """The Wi-Fi the device is connected to now (ssid, linkEnable, intensity)."""
        return self._post_auth("currentDeviceWifi", {"deviceId": device_id}, timeout=30.0)

    def control_device_wifi(
        self,
        device_id: str,
        ssid: str,
        bssid: str,
        password: str = "",
        *,
        link_enable: bool = True,
    ) -> dict[str, Any]:
        """Switch the device onto the given Wi-Fi. Slow (~60-90s); device reboots
        onto the new network. Call ``wifi_around`` first to get the BSSID."""
        params: dict[str, Any] = {
            "deviceId": device_id,
            "ssid": ssid,
            "bssid": bssid,
            "linkEnable": bool(link_enable),
        }
        if password:
            params["password"] = password
        return self._post_auth("controlDeviceWifi", params, timeout=95.0)

    def control_move_ptz(
        self, device_id: str, operation: str, duration_ms: int = 500, channel: str = "0"
    ) -> dict[str, Any]:
        """Move the PTZ in a direction for ``duration_ms`` milliseconds.

        ``operation`` is one of PTZ_OPERATIONS keys (up/down/left/right/zoom_in/…).
        Requires the device to have PT/PTZ capability (the H3A is pan/tilt)."""
        op = self.PTZ_OPERATIONS.get(operation.strip().lower())
        if op is None:
            raise Easy4IpError(f"Unknown PTZ operation: {operation}", method="controlMovePTZ")
        return self._post_auth(
            "controlMovePTZ",
            {
                "deviceId": device_id,
                "channelId": str(channel),
                "operation": str(op),
                "duration": str(max(1, int(duration_ms))),
            },
        )

    def bind_device_live(
        self, device_id: str, channel: str = "0", stream_id: int = 0
    ) -> dict[str, Any]:
        """Create the device's live address (required before getLiveStreamInfo).

        ``stream_id``: 0 = HD main stream (best for plate legibility), 1 = SD sub.
        The cloud provisions HD+SD+HTTP+HTTPS in the background regardless; this
        call returns the requested stream's address.
        """
        return self._post_auth(
            "bindDeviceLive",
            {
                "deviceId": device_id,
                "channelId": str(channel),
                "streamId": int(stream_id),
                "liveMode": "proxy",
            },
        )

    def get_live_stream_info(self, device_id: str, channel: str = "0") -> list[dict[str, Any]]:
        data = self._post_auth(
            "getLiveStreamInfo", {"deviceId": device_id, "channelId": str(channel)}
        )
        streams = data.get("streams")
        return streams if isinstance(streams, list) else []

    def _safe_stream_info(self, device_id: str, channel: str) -> list[dict[str, Any]]:
        """getLiveStreamInfo, treating LV1002 'live does not exist' as empty."""
        try:
            return self.get_live_stream_info(device_id, channel)
        except Easy4IpError as exc:
            if exc.code == "LV1002":
                return []
            raise

    def _ensure_live(self, device_id: str, channel: str, want: int) -> list[dict[str, Any]]:
        """Return current live streams, creating the live address if needed.

        ``bindDeviceLive`` must be called per streamId; we create the wanted one
        (and tolerate LV1001 'already exists')."""
        streams = self._safe_stream_info(device_id, channel)
        have = {int(s.get("streamId", -1)) for s in streams if s.get("hls")}
        if want in have:
            return streams
        try:
            self.bind_device_live(device_id, channel, want)
        except Easy4IpError as exc:
            if exc.code != "LV1001":  # already exists is fine
                _log.warning("bindDeviceLive(stream %s) -> %s", want, exc)
        return self._safe_stream_info(device_id, channel)

    def live_hls_url(
        self, device_id: str, channel: str = "0", *, prefer_hd: bool = True
    ) -> str | None:
        """Return an HLS (.m3u8) live URL for the device, creating the live
        address first if needed. ``prefer_hd`` picks streamId 0 (HD main, best
        for plate legibility); set False for the lighter SD sub stream."""
        if not device_id:
            return None
        want = 0 if prefer_hd else 1
        try:
            streams = self._ensure_live(device_id, channel, want)
        except Easy4IpError as exc:
            _log.warning("Easy4IP live resolve failed: %s", exc)
            return None

        chosen = None
        for s in streams:
            if int(s.get("streamId", -1)) == want and s.get("hls"):
                chosen = s
                break
        if chosen is None:  # fall back to any available HLS (e.g. the other stream)
            for s in streams:
                if s.get("hls"):
                    chosen = s
                    break
        return str(chosen.get("hls")) if chosen else None


# ---- module-level factory / cache ------------------------------------------

_CLIENTS: dict[tuple[str, str, str], Easy4IpOpenAPI] = {}
_CLIENTS_LOCK = threading.Lock()

# ── HLS URL cache + failure backoff (interface-request quota saver) ─────────
# Every live (re)connect used to cost 2+ API calls (getLiveStreamInfo and
# often bindDeviceLive). With an unstable Wi-Fi camera that reconnects every
# minute, that is thousands of interface requests per day. Cache the resolved
# URL (it stays valid for the live-bind lifetime) and only re-resolve when the
# TTL lapses or a cached URL fails to open. When the device is offline, back
# off exponentially instead of re-hitting the API on every retry.
_HLS_CACHE: dict[tuple[str, str, str, int], tuple[str, float]] = {}
_HLS_FAIL: dict[tuple[str, str, str], tuple[float, int]] = {}
_HLS_LOCK = threading.Lock()


def _hls_settings() -> tuple[float, float, float]:
    try:
        from ..config import settings

        return (
            max(30.0, float(getattr(settings, "IMOU_HLS_CACHE_TTL_SEC", 600.0))),
            max(5.0, float(getattr(settings, "IMOU_FAIL_BACKOFF_BASE_SEC", 30.0))),
            max(30.0, float(getattr(settings, "IMOU_FAIL_BACKOFF_MAX_SEC", 600.0))),
        )
    except Exception:
        return 600.0, 30.0, 600.0


def _hls_cache_get(key: tuple[str, str, str, int]) -> str | None:
    with _HLS_LOCK:
        hit = _HLS_CACHE.get(key)
        if hit and time.monotonic() < hit[1]:
            return hit[0]
        _HLS_CACHE.pop(key, None)
        return None


def _hls_cache_put(key: tuple[str, str, str, int], url: str) -> None:
    ttl, _, _ = _hls_settings()
    with _HLS_LOCK:
        _HLS_CACHE[key] = (url, time.monotonic() + ttl)
        _HLS_FAIL.pop(key[:3], None)


def _hls_fail_blocked(fail_key: tuple[str, str, str]) -> float:
    """Seconds until the next resolve attempt is allowed (0 = allowed now)."""
    with _HLS_LOCK:
        entry = _HLS_FAIL.get(fail_key)
        if not entry:
            return 0.0
        return max(0.0, entry[0] - time.monotonic())


def _hls_fail_record(fail_key: tuple[str, str, str]) -> None:
    _, base, cap = _hls_settings()
    with _HLS_LOCK:
        fails = (_HLS_FAIL.get(fail_key) or (0.0, 0))[1] + 1
        delay = min(cap, base * (2 ** min(6, fails - 1)))
        _HLS_FAIL[fail_key] = (time.monotonic() + delay, fails)
        _log.warning(
            "Easy4IP resolve failed for %s (attempt %d) — next attempt in %.0fs",
            fail_key[1], fails, delay,
        )


def invalidate_hls_cache(cfg: dict[str, Any]) -> None:
    """Drop cached HLS URLs for a camera cfg (called when a cached URL fails
    to open, so the next resolve fetches a fresh one from the API)."""
    serial = str(cfg.get("device_serial") or "").strip()
    if not serial:
        return
    base_url = _cfg_or_env(cfg, "openapi_base_url", "IMOU_BASE_URL") or _DEFAULT_BASE_URL
    with _HLS_LOCK:
        for key in [k for k in _HLS_CACHE if k[0] == base_url and k[1] == serial]:
            _HLS_CACHE.pop(key, None)


def _cfg_or_env(cfg: dict[str, Any] | None, key: str, env: str) -> str:
    if cfg:
        val = str(cfg.get(key) or "").strip()
        if val:
            return val
    return str(os.environ.get(env) or "").strip()


def get_openapi_client(cfg: dict[str, Any] | None = None) -> Easy4IpOpenAPI | None:
    """Build (and cache) an OpenAPI client from camera cfg / env, or None if
    credentials are missing."""
    app_id = _cfg_or_env(cfg, "openapi_app_id", "IMOU_APP_ID")
    app_secret = _cfg_or_env(cfg, "openapi_app_secret", "IMOU_APP_SECRET")
    base_url = _cfg_or_env(cfg, "openapi_base_url", "IMOU_BASE_URL") or _DEFAULT_BASE_URL
    if not app_id or not app_secret:
        return None
    key = (app_id, app_secret, base_url)
    with _CLIENTS_LOCK:
        client = _CLIENTS.get(key)
        if client is None:
            client = Easy4IpOpenAPI(app_id, app_secret, base_url)
            _CLIENTS[key] = client
        return client


def ensure_device_bound(cfg: dict[str, Any]) -> dict[str, Any]:
    """Make sure the camera is bound to our Open Platform app so cloud HLS/PTZ work.

    Returns {ok, bound, mine, error}. If the device is bound to a *different*
    account (e.g. still in DMSS/Imou Life), returns ok=False with guidance —
    the user must unbind it there first."""
    client = get_openapi_client(cfg)
    if client is None:
        return {"ok": False, "error": "Easy4IP OpenAPI credentials not configured (IMOU_APP_ID/SECRET)."}
    serial = str(cfg.get("device_serial") or "").strip()
    if not serial:
        return {"ok": False, "error": "Camera serial number is required."}
    password = str(cfg.get("password") or "").strip()
    try:
        status = client.check_bound(serial)
        if status.get("isMine"):
            return {"ok": True, "bound": True, "mine": True}
        if status.get("isBind"):
            return {
                "ok": False,
                "bound": True,
                "mine": False,
                "error": (
                    "This camera is bound to another account (e.g. DMSS / Imou Life). "
                    "Remove/unbind it there first, then add it here."
                ),
            }
        if not password:
            return {"ok": False, "error": "Device password is required to bind the camera to the cloud app."}
        client.bind_device(serial, password)
        return {"ok": True, "bound": True, "mine": True, "just_bound": True}
    except Easy4IpError as exc:
        hint = ""
        if exc.code == "DV1016":
            hint = " Device password is incorrect."
        elif exc.code == "DV1001":
            hint = " Camera is bound to another account — unbind it from DMSS/Imou Life first."
        return {"ok": False, "error": str(exc) + hint, "code": exc.code}


def _wifi_client_serial(cfg: dict[str, Any]) -> tuple[Easy4IpOpenAPI | None, str, str | None]:
    client = get_openapi_client(cfg)
    if client is None:
        return None, "", "Easy4IP OpenAPI credentials not configured."
    serial = str(cfg.get("device_serial") or "").strip()
    if not serial:
        return None, "", "Camera serial number not configured."
    return client, serial, None


def easy4ip_wifi_current(cfg: dict[str, Any]) -> dict[str, Any]:
    """Current Wi-Fi the camera is on, via the Open Platform."""
    client, serial, err = _wifi_client_serial(cfg)
    if err:
        return {"ok": False, "error": err}
    try:
        data = client.current_device_wifi(serial)  # type: ignore[union-attr]
        return {"ok": True, "ssid": data.get("ssid"), "linkEnable": data.get("linkEnable"),
                "intensity": data.get("intensity")}
    except Easy4IpError as exc:
        return {"ok": False, "error": str(exc), "code": exc.code}


def easy4ip_wifi_scan(cfg: dict[str, Any]) -> dict[str, Any]:
    """Networks the camera can see (for the in-app Wi-Fi switcher)."""
    client, serial, err = _wifi_client_serial(cfg)
    if err:
        return {"ok": False, "error": err}
    try:
        nets = client.wifi_around(serial)  # type: ignore[union-attr]
        out = [
            {
                "ssid": n.get("ssid"),
                "bssid": n.get("bssid"),
                "intensity": n.get("intensity"),
                "encrypt": n.get("auth") or n.get("encryptionMode") or n.get("encrypt"),
            }
            for n in nets
            if n.get("ssid")
        ]
        # De-dupe by SSID (keep strongest), drop the currently-connected/empty ones last.
        best: dict[str, dict[str, Any]] = {}
        for n in out:
            ssid = str(n["ssid"])
            cur = best.get(ssid)
            if cur is None or (int(n.get("intensity") or 0) > int(cur.get("intensity") or 0)):
                best[ssid] = n
        return {"ok": True, "networks": list(best.values())}
    except Easy4IpError as exc:
        return {"ok": False, "error": str(exc), "code": exc.code}


def easy4ip_wifi_set(cfg: dict[str, Any], ssid: str, bssid: str, password: str = "") -> dict[str, Any]:
    """Switch the camera onto a new Wi-Fi (slow; camera reboots onto it)."""
    client, serial, err = _wifi_client_serial(cfg)
    if err:
        return {"ok": False, "error": err}
    if not ssid:
        return {"ok": False, "error": "Wi-Fi SSID is required."}
    try:
        client.control_device_wifi(serial, ssid, bssid, password)  # type: ignore[union-attr]
        return {"ok": True, "ssid": ssid}
    except Easy4IpError as exc:
        return {"ok": False, "error": str(exc), "code": exc.code}


def easy4ip_ptz(cfg: dict[str, Any], operation: str, duration_ms: int = 500) -> dict[str, Any]:
    """Cloud PTZ for a camera cfg via the Open Platform (controlMovePTZ)."""
    client = get_openapi_client(cfg)
    if client is None:
        return {"ok": False, "error": "Easy4IP OpenAPI credentials not configured."}
    serial = str(cfg.get("device_serial") or "").strip()
    if not serial:
        return {"ok": False, "error": "Camera serial number not configured."}
    channel = str(cfg.get("openapi_channel") or cfg.get("channel") or "0").strip()
    try:
        client.control_move_ptz(serial, operation, duration_ms, channel)
        return {"ok": True, "operation": operation, "duration_ms": int(duration_ms)}
    except Easy4IpError as exc:
        return {"ok": False, "error": str(exc), "code": exc.code}


def resolve_easy4ip_hls(
    cfg: dict[str, Any],
    *,
    prefer_hd_override: bool | None = None,
) -> str | None:
    """Resolve a camera cfg to a cloud HLS URL via the Open Platform, or None.

    Resolved URLs are cached (interface-request quota saver) and failed
    resolves are rate-limited with exponential backoff so an offline camera
    cannot generate an API-call storm. ``prefer_hd_override`` lets the stream
    governor pick SD/HD at runtime regardless of the saved camera default.
    """
    client = get_openapi_client(cfg)
    if client is None:
        _log.warning(
            "Easy4IP cloud HLS needs openapi_app_id/openapi_app_secret "
            "(register a free app at open.imoulife.com)."
        )
        return None
    serial = str(cfg.get("device_serial") or "").strip()
    if not serial:
        _log.warning("Easy4IP cloud HLS needs the device serial number.")
        return None
    channel = str(cfg.get("openapi_channel") or cfg.get("channel") or "0").strip()
    # Default to HD main stream for plate legibility; allow opt-out to SD.
    if prefer_hd_override is not None:
        prefer_hd = bool(prefer_hd_override)
    else:
        prefer_hd = bool(cfg.get("openapi_prefer_hd", True))

    cache_key = (client.base_url, serial, channel, 0 if prefer_hd else 1)
    cached = _hls_cache_get(cache_key)
    if cached:
        return cached

    fail_key = cache_key[:3]
    wait = _hls_fail_blocked(fail_key)
    if wait > 0:
        _log.debug(
            "Easy4IP resolve for %s suppressed (backoff, %.0fs left).", serial, wait
        )
        return None

    try:
        url = client.live_hls_url(serial, channel, prefer_hd=prefer_hd)
    except Easy4IpError as exc:
        _log.warning("Easy4IP cloud HLS resolve failed: %s", exc)
        _hls_fail_record(fail_key)
        return None
    if url:
        _hls_cache_put(cache_key, url)
        _log.info(
            "Easy4IP cloud HLS ready for %s ch%s (%s stream)",
            serial, channel, "HD" if prefer_hd else "SD",
        )
    else:
        _hls_fail_record(fail_key)
    return url
