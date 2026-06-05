"""Tests for headless OpenCV / Ultralytics GUI suppression."""
import os

import cv2

from app.services.opencv_headless import ensure_headless_opencv


def test_headless_env_and_imshow_noop():
    ensure_headless_opencv()
    assert os.environ.get("HEADLESS") == "1"
    assert cv2.imshow("would-open-window", None) is None

    from ultralytics.utils import checks

    assert checks.check_imshow(warn=False) is False
