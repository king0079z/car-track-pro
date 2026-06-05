"""Dark (black-background) plate helpers."""

import numpy as np

from app.services.visionflow_engine import (
    SpeedEstimator,
    _crop_gray_mean,
    _enhance_frame_for_detection,
    _is_dark_plate_crop,
)


def test_is_dark_plate_crop():
    dark = np.full((40, 120, 3), 25, dtype=np.uint8)
    light = np.full((40, 120, 3), 220, dtype=np.uint8)
    assert _is_dark_plate_crop(dark)
    assert not _is_dark_plate_crop(light)


def test_preprocess_inverts_dark_crop():
    est = SpeedEstimator.__new__(SpeedEstimator)
    est._ocr_preprocess = True
    dark = np.full((40, 120, 3), 30, dtype=np.uint8)
    out = est._preprocess_crop(dark)
    assert _crop_gray_mean(out) > _crop_gray_mean(dark)


def test_enhance_inverted_frame_preserves_shape():
    frame = np.random.randint(0, 255, (480, 640, 3), dtype=np.uint8)
    from app.services.visionflow_engine import _enhance_inverted_for_detection
    enhanced = _enhance_inverted_for_detection(frame)
    assert enhanced.shape == frame.shape


def test_enhance_frame_preserves_shape():
    frame = np.random.randint(0, 255, (480, 640, 3), dtype=np.uint8)
    enhanced = _enhance_frame_for_detection(frame)
    assert enhanced.shape == frame.shape
