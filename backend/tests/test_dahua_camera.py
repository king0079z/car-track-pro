"""Tests for Dahua Hero A1 camera integration."""

import pytest

from app.services.camera_config import load_camera_config, sanitize_dahua_patch, save_camera_config
from app.services.dahua_camera import (
    HERO_A1_ALIASES,
    build_rtsp_url,
    is_dahua_alias,
    resolve_dahua_source,
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
    save_camera_config({
        "dahua_hero_a1": {
            "enabled": True,
            "host": "10.0.0.88",
            "username": "admin",
            "password": "pass",
            "stream": "sub",
        },
    })
    url = resolve_dahua_source("dahua-hero-a1")
    assert url is not None
    assert "10.0.0.88" in url
    assert "subtype=1" in url


def test_normalize_resolves_dahua_alias(tmp_path, monkeypatch):
    cfg_file = tmp_path / "cameras.json"
    monkeypatch.setattr(
        "app.services.camera_config._CONFIG_FILE",
        str(cfg_file),
    )
    save_camera_config({
        "dahua_hero_a1": {
            "enabled": True,
            "host": "192.168.0.20",
            "password": "x",
        },
    })
    out = normalize_live_source("hero-a1")
    assert out.startswith("rtsp://")
    assert "192.168.0.20" in out


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


@pytest.mark.parametrize("alias", sorted(HERO_A1_ALIASES))
def test_all_aliases_recognized(alias):
    assert is_dahua_alias(alias)
