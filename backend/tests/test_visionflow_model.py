"""VisionFlow YOLO weights resolver tests."""

from pathlib import Path

import pytest

import app.services.visionflow_model as vfm
from app.config import settings


@pytest.fixture(autouse=True)
def _clear_weight_env(monkeypatch):
    monkeypatch.setattr(settings, "YOLO26_WEIGHTS", "")
    monkeypatch.setattr(settings, "YOLO11_WEIGHTS", "")


def test_resolve_yolo_weights_prefers_yolo26(monkeypatch, tmp_path):
    models = tmp_path / "models"
    models.mkdir()
    y11 = models / "best.pt"
    y26 = models / "yolo26_best.pt"
    y11.write_bytes(b"x")
    y26.write_bytes(b"y")
    monkeypatch.setattr(vfm, "MODELS_DIR", models)
    monkeypatch.setattr(vfm, "_BACKEND_DIR", tmp_path)
    assert vfm.resolve_yolo_weights() == y26.resolve()


def test_resolve_yolo_weights_falls_back_to_best(monkeypatch, tmp_path):
    models = tmp_path / "models"
    models.mkdir()
    best = models / "best.pt"
    best.write_bytes(b"x")
    monkeypatch.setattr(vfm, "MODELS_DIR", models)
    monkeypatch.setattr(vfm, "_BACKEND_DIR", tmp_path)
    assert vfm.resolve_yolo_weights() == best.resolve()


def test_resolve_yolo_weights_env_override(monkeypatch, tmp_path):
    custom = tmp_path / "custom.pt"
    custom.write_bytes(b"z")
    monkeypatch.setattr(settings, "YOLO26_WEIGHTS", str(custom))
    monkeypatch.setattr(vfm, "MODELS_DIR", tmp_path / "models")
    monkeypatch.setattr(vfm, "_BACKEND_DIR", tmp_path)
    assert vfm.resolve_yolo_weights() == custom.resolve()


def test_model_status_not_ready(monkeypatch, tmp_path):
    monkeypatch.setattr(vfm, "MODELS_DIR", tmp_path / "models")
    monkeypatch.setattr(vfm, "_BACKEND_DIR", tmp_path)
    monkeypatch.setattr(vfm, "resolve_yolo_weights", lambda: None)
    info = vfm.model_status()
    assert info["ready"] is False
    assert info["path"] is None
