"""Tests for 24/7 live camera persistence and memory management."""

import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from app.services import live_persistence as persist
from app.services.visionflow_engine import SpeedEstimator


@pytest.fixture
def db_path(tmp_path):
    p = tmp_path / "live_sessions.db"
    persist.init_db(p)
    return p


def test_live_session_upsert_and_list(db_path):
    persist.upsert_session(
        db_path,
        "sess1",
        source="rtsp://cam/stream",
        label="Gate cam",
        opts={"conf": 0.16, "stride": 2},
        job_id="job-abc",
    )
    rows = persist.list_sessions(db_path)
    assert len(rows) == 1
    assert rows[0]["session_id"] == "sess1"
    assert rows[0]["opts"]["stride"] == 2
    assert rows[0]["job_id"] == "job-abc"


def test_disable_session(db_path):
    persist.upsert_session(
        db_path,
        "sess2",
        source="0",
        label="USB",
        opts={},
    )
    persist.disable_session(db_path, "sess2")
    assert persist.list_sessions(db_path, enabled_only=True) == []
    disabled = persist.get_session(db_path, "sess2")
    assert disabled is not None
    assert disabled["enabled"] is False


def test_dedupe_by_source_keeps_newest(db_path):
    persist.upsert_session(db_path, "old", source="0", label="Old cam", opts={})
    persist.upsert_session(db_path, "new", source="webcam", label="New cam", opts={})
    removed = persist.dedupe_by_source(db_path)
    assert removed == 1
    enabled = persist.list_sessions(db_path, enabled_only=True)
    assert len(enabled) == 1
    assert enabled[0]["session_id"] == "new"


def test_disable_all_except(db_path):
    persist.upsert_session(db_path, "a", source="0", label="A", opts={})
    persist.upsert_session(db_path, "b", source="1", label="B", opts={}, slot_index=1)
    n = persist.disable_all_except(db_path, "b")
    assert n == 1
    assert persist.get_session(db_path, "a")["enabled"] is False
    assert persist.get_session(db_path, "b")["enabled"] is True


def test_prune_sessions_for_missing_usb_cameras(db_path, monkeypatch):
    persist.upsert_session(db_path, "s0", source="0", label="Cam0", opts={}, slot_index=0)
    persist.upsert_session(db_path, "s3", source="3", label="Cam3", opts={}, slot_index=3)

    def fake_probe(max_index=4):
        return [{"index": 0, "width": 1280, "height": 720, "fps": 30.0}]

    monkeypatch.setattr("app.services.live_camera.probe_local_cameras", fake_probe)
    n = persist.prune_sessions_for_missing_usb_cameras(db_path, max_index=4)
    assert n == 1
    assert persist.get_session(db_path, "s0")["enabled"] is True
    assert persist.get_session(db_path, "s3")["enabled"] is False


def test_speed_estimator_prune_memory():
    est = SpeedEstimator.__new__(SpeedEstimator)
    est._track_registry = {}
    est._completed_rows = []
    est.spd = {}
    est._spd_ema = {}
    est._speed_sum = {}
    est._speed_count = {}
    est._last_ocr_text = {}
    est._plate_votes = {}
    est._ocr_tick = {}
    est._best_plate_ever = {}
    est._last_seen_frame = {}
    est._seen_track_ids = set()
    est._visible_track_ids = set()
    est.logged_ids = set()

    for i in range(5):
        tid = i + 1
        est._track_registry[tid] = {
            "track_id": tid,
            "plate": f"P{i}",
            "status": "exited",
            "t_exit_sec": float(i),
        }
        est._speed_sum[tid] = 10.0
        est._speed_count[tid] = 1

    n = est.prune_memory(max_registry_tracks=2)
    assert n == 3
    assert len(est._track_registry) == 2
    assert len(est._completed_rows) == 3


def test_open_video_writer_even_size():
    from app.services.video_writer_util import even_size, open_video_writer

    assert even_size((1119, 629)) == (1118, 628)


def test_segmented_writer_skips_when_codec_unavailable(tmp_path, monkeypatch):
    from app.services.live_segment_writer import SegmentedVideoWriter
    import numpy as np

    monkeypatch.setattr(
        "app.services.live_segment_writer.open_video_writer",
        lambda *a, **k: (None, tmp_path / "x.mp4"),
    )
    w = SegmentedVideoWriter(tmp_path, fps=10.0, size=(64, 48), segment_seconds=3600)
    frame = np.zeros((48, 64, 3), dtype=np.uint8)
    w.write(frame)
    assert w.recording_enabled is False
    assert w.last_error is not None
    assert w.segment_names == []


def test_segmented_writer_rotates(tmp_path):
    pytest.importorskip("cv2")
    from app.services.live_segment_writer import SegmentedVideoWriter
    import numpy as np

    w = SegmentedVideoWriter(
        tmp_path,
        fps=10.0,
        size=(64, 48),
        segment_seconds=0.05,
        prefer_fast_encoder=True,
    )
    frame = np.zeros((48, 64, 3), dtype=np.uint8)
    try:
        for _ in range(30):
            w.write(frame)
        w.close()
        assert len(w.segment_names) >= 1
        for name in w.segment_names:
            assert (tmp_path / name).is_file()
    except RuntimeError:
        pytest.skip("VideoWriter not available in this environment")
