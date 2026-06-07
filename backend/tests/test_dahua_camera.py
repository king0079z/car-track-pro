"""Tests for Dahua Hero A1 camera integration."""

import pytest

from app.services.camera_config import (
    get_camera,
    list_cameras,
    load_camera_config,
    sanitize_dahua_patch,
    save_camera_config,
)
from app.services.dahua_camera import (
    HERO_A1_ALIASES,
    build_rtsp_url,
    is_dahua_alias,
    resolve_dahua_source,
    source_for_camera,
)
from app.services.live_camera import normalize_live_source


def test_is_dahua_alias():
    assert is_dahua_alias("dahua-hero-a1")
    assert is_dahua_alias("hero-a1")
    assert not is_dahua_alias("0")


def test_build_rtsp_url_main_and_sub():
    main = build_rtsp_url(host="192.168.1.50", password="secret", stream="main")
    sub = build_rtsp_url(host="192.168.1.50", password="secret", stream="sub")
    assert "subtype=0" in main
    assert "subtype=1" in sub
    assert "192.168.1.50:554" in main
    assert "admin" in main


def test_resolve_dahua_source_when_configured(tmp_path, monkeypatch):
    cfg_file = tmp_path / "cameras.json"
    monkeypatch.setattr(
        "app.services.camera_config._CONFIG_FILE",
        str(cfg_file),
    )
    from app.config import settings

    monkeypatch.setattr(settings, "DAHUA_DEVICE_SERIAL", "")
    monkeypatch.setattr(settings, "DAHUA_PASSWORD", "")
    monkeypatch.setattr(settings, "DAHUA_HOST", "")
    monkeypatch.setattr(settings, "DAHUA_CONNECTION_MODE", "lan")
    monkeypatch.setattr(settings, "DAHUA_ENABLED", False)
    save_camera_config({
        "dahua_hero_a1": {
            "enabled": True,
            "host": "10.0.0.88",
            "username": "admin",
            "password": "pass",
            "stream": "sub",
            "connection_mode": "lan",
        },
    })
    url = resolve_dahua_source("dahua-hero-a1")
    assert url is not None
    assert "10.0.0.88" in url
    assert "subtype=1" in url


def test_normalize_canonicalizes_dahua_alias_without_network():
    assert normalize_live_source("hero-a1") == "dahua-hero-a1"
    assert normalize_live_source("dahua-hero-a1") == "dahua-hero-a1"


def test_sanitize_dahua_patch():
    patch = sanitize_dahua_patch({
        "enabled": "true",
        "host": " 192.168.1.1 ",
        "rtsp_port": "554",
        "stream": "MAIN",
        "bogus": "ignored",
    })
    assert patch["enabled"] is True
    assert patch["host"] == "192.168.1.1"
    assert patch["stream"] == "main"
    assert "bogus" not in patch


def test_env_overrides_cameras_json(tmp_path, monkeypatch):
    cfg_file = tmp_path / "cameras.json"
    monkeypatch.setattr("app.services.camera_config._CONFIG_FILE", str(cfg_file))
    save_camera_config({
        "dahua_hero_a1": {
            "enabled": False,
            "host": "192.168.1.99",
            "connection_mode": "lan",
            "device_serial": "",
            "password": "file-pass",
        },
    })
    from app.config import settings

    monkeypatch.setattr(settings, "DAHUA_DEVICE_SERIAL", "BF0E4C7GAGB833C")
    monkeypatch.setattr(settings, "DAHUA_PASSWORD", "cloud-pass")
    monkeypatch.setattr(settings, "DAHUA_CONNECTION_MODE", "p2p")
    monkeypatch.setattr(settings, "DAHUA_ENABLED", False)
    cfg = load_camera_config()["dahua_hero_a1"]
    assert cfg["device_serial"] == "BF0E4C7GAGB833C"
    assert cfg["password"] == "cloud-pass"
    assert cfg["connection_mode"] == "p2p"
    assert cfg["enabled"] is True


@pytest.mark.parametrize("alias", sorted(HERO_A1_ALIASES))
def test_all_aliases_recognized(alias):
    assert is_dahua_alias(alias)


def test_env_rtsp_url_surfaces_as_enabled_cloud_camera(tmp_path, monkeypatch):
    """LIVE_RTSP_URL (cloud/HF deploy) becomes an auto-startable 'cloud-rtsp' camera."""
    cfg_file = tmp_path / "cameras.json"
    monkeypatch.setattr("app.services.camera_config._CONFIG_FILE", str(cfg_file))
    from app.config import settings

    monkeypatch.setattr(settings, "DAHUA_DEVICE_SERIAL", "")
    monkeypatch.setattr(settings, "DAHUA_PASSWORD", "")
    monkeypatch.setattr(settings, "DAHUA_HOST", "")
    monkeypatch.setattr(settings, "DAHUA_ENABLED", False)
    monkeypatch.setattr(settings, "LIVE_RTSP_URL", "rtsp://relay.example.com:8554/site/cam1")
    monkeypatch.setattr(settings, "LIVE_RTSP_NAME", "Front Gate")

    cam = get_camera("cloud-rtsp")
    assert cam is not None
    assert cam["enabled"] is True
    assert cam["type"] == "rtsp"
    assert cam["name"] == "Front Gate"
    # The live engine receives the RTSP URL verbatim (no LAN/P2P resolution needed).
    assert source_for_camera(cam) == "rtsp://relay.example.com:8554/site/cam1"


def test_no_env_rtsp_url_means_no_cloud_camera(tmp_path, monkeypatch):
    cfg_file = tmp_path / "cameras.json"
    monkeypatch.setattr("app.services.camera_config._CONFIG_FILE", str(cfg_file))
    from app.config import settings

    monkeypatch.setattr(settings, "LIVE_RTSP_URL", "")
    assert get_camera("cloud-rtsp") is None
    assert all(c["id"] != "cloud-rtsp" for c in list_cameras())
