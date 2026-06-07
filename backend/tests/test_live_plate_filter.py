"""Tiny-box filtering for phone-screen false positives."""

import numpy as np

from app.services.visionflow_engine import (
    SpeedEstimator,
    _min_plate_area_for_frame,
)


def test_min_plate_area_scales_with_frame():
    # Larger frames demand a larger minimum plate area (scales with frame area)...
    assert _min_plate_area_for_frame(1080, 1920) > _min_plate_area_for_frame(540, 960)
    # ...but never drops below the small-frame floor.
    assert _min_plate_area_for_frame(540, 960) >= 450


def test_filter_tiny_boxes_drops_phone_ui_fragment():
    est = SpeedEstimator.__new__(SpeedEstimator)
    # Small UI chip on a phone screen — not a plate.
    est.boxes = np.array([[420.0, 310.0, 455.0, 335.0]], dtype=float)
    est.track_ids = [1]
    est.clss = [0]
    est._filter_tiny_boxes(540, 960)
    est._normalize_detection_state()
    assert len(est.boxes) == 0
    list(zip(est.boxes, est.track_ids, est.clss))


def test_filter_tiny_boxes_keeps_wide_plate_box():
    est = SpeedEstimator.__new__(SpeedEstimator)
    est.boxes = np.array([[280.0, 260.0, 520.0, 310.0]], dtype=float)
    est.track_ids = [2]
    est.clss = [0]
    est._filter_tiny_boxes(540, 960)
    assert est.boxes is not None and len(est.boxes) == 1
