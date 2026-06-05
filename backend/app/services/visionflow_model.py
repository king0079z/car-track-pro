"""Resolve YOLO plate-detector weights for VisionFlow (YOLO11 / YOLO26)."""

from __future__ import annotations

from pathlib import Path

from ..config import settings

_BACKEND_DIR = Path(__file__).resolve().parents[2]
MODELS_DIR = _BACKEND_DIR / "models"


def resolve_yolo_weights() -> Path | None:
    """
    Pick the first existing plate-detector checkpoint.

    Priority:
      1. YOLO26_WEIGHTS / YOLO11_WEIGHTS env paths
      2. backend/models/yolo26_best.pt
      3. backend/models/best.pt
      4. backend/models/yolo11_best.pt
    """
    candidates: list[Path] = []
    for raw in (settings.YOLO26_WEIGHTS, settings.YOLO11_WEIGHTS):
        s = (raw or "").strip()
        if s:
            p = Path(s)
            candidates.append(p if p.is_absolute() else _BACKEND_DIR / p)
    candidates.extend(
        [
            MODELS_DIR / "yolo26_best.pt",
            MODELS_DIR / "best.pt",
            MODELS_DIR / "yolo11_best.pt",
        ]
    )
    seen: set[str] = set()
    for path in candidates:
        key = str(path.resolve()) if path.exists() else str(path)
        if key in seen:
            continue
        seen.add(key)
        if path.is_file():
            return path.resolve()
    return None


def model_status() -> dict:
    """Summary for health / status endpoints."""
    path = resolve_yolo_weights()
    name = path.name if path else None
    family = None
    if name:
        low = name.lower()
        if "yolo26" in low or low == "yolo26_best.pt":
            family = "yolo26"
        elif "yolo11" in low:
            family = "yolo11"
        else:
            family = "custom"
    return {
        "ready": path is not None,
        "path": str(path) if path else None,
        "filename": name,
        "family": family,
        "tracker": (settings.YOLO_TRACKER or "botsort.yaml").strip(),
        "ocr_engine": (settings.PLATE_OCR_ENGINE or "fast_plate").strip(),
    }
