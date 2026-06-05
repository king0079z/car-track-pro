"""Disable OpenCV GUI windows when running the FastAPI backend (no desktop pop-ups)."""
from __future__ import annotations

import os

_applied = False


def ensure_headless_opencv() -> None:
    """Force headless OpenCV + Ultralytics display checks (safe to call repeatedly)."""
    global _applied
    os.environ["HEADLESS"] = "1"
    if _applied:
        return
    _applied = True

    try:
        import cv2

        def _noop(*_args, **_kwargs):
            return None

        cv2.imshow = _noop  # type: ignore[attr-defined, assignment]
        cv2.namedWindow = _noop  # type: ignore[attr-defined, assignment]
        cv2.destroyAllWindows = _noop  # type: ignore[attr-defined, assignment]
        cv2.waitKey = lambda *_a, **_k: -1  # type: ignore[attr-defined, assignment]
    except Exception:
        pass

    try:
        from ultralytics.utils import checks

        def _check_imshow_noop(warn: bool = False) -> bool:
            return False

        checks.check_imshow = _check_imshow_noop
    except Exception:
        pass
