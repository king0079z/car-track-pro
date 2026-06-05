"""Tests for local USB / laptop webcam capture helpers."""

import pytest

from app.services.live_camera import (
    is_local_camera_source,
    local_camera_label,
    normalize_live_source,
)


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("", "0"),
        ("0", "0"),
        ("webcam", "0"),
        ("laptop", "0"),
        ("PC", "0"),
        ("2", "2"),
        ("rtsp://192.168.1.1/stream", "rtsp://192.168.1.1/stream"),
        ("dahua-hero-a1", "dahua-hero-a1"),  # unresolved without cameras.json config
    ],
)
def test_normalize_live_source(raw, expected):
    assert normalize_live_source(raw) == expected


def test_local_camera_label():
    assert "0" in local_camera_label("webcam") or "PC" in local_camera_label("webcam")


def test_is_local_camera_source():
    assert is_local_camera_source("")
    assert is_local_camera_source("rtsp://x") is False
