"""Vehicle registry session ledger and live sync edge cases."""

import pytest

from app.routers.visionflow import _collect_syncable_rows
from app.services.visionflow_engine import SpeedEstimator


def _estimator() -> SpeedEstimator:
    est = SpeedEstimator.__new__(SpeedEstimator)
    est._plate_jurisdiction = "qa_uk"
    return est


def test_session_merge_prefers_exited_over_stale_active():
    """A car that left must not stay Live because an older snapshot was active."""
    est = _estimator()
    prev = {
        "plate": "8174 HGL",
        "status": "active",
        "track_id": 10,
        "duration_sec": 25.0,
        "presence_duration_sec": 30.0,
        "t_enter_sec": 10.0,
        "t_exit_sec": 35.0,
        "ocr_locked": True,
    }
    new = {
        "plate": "8174 HGL",
        "status": "exited",
        "track_id": 10,
        "duration_sec": 25.0,
        "presence_duration_sec": 25.0,
        "t_enter_sec": 10.0,
        "t_exit_sec": 35.0,
        "resume_eligible": True,
        "ocr_locked": True,
    }
    out = est._merge_session_vehicle_row(prev, new)
    assert out["status"] == "exited"
    assert out.get("resume_eligible") is True


def test_collect_syncable_allows_second_segment_same_plate():
    rows = [
        {
            "plate": "8174 HGL",
            "track_id": 10,
            "t_exit_sec": 30.0,
            "duration_sec": 30.0,
            "status": "exited",
            "ocr_vote_count": 3,
            "ocr_confidence": 0.92,
        },
        {
            "plate": "8174 HGL",
            "track_id": 20,
            "t_exit_sec": 420.0,
            "duration_sec": 22.0,
            "status": "exited",
            "ocr_vote_count": 2,
            "ocr_confidence": 0.9,
        },
    ]
    keys: set[str] = set()
    first = _collect_syncable_rows(rows[:1], keys)
    second = _collect_syncable_rows(rows[1:2], keys)
    assert len(first) == 1
    assert len(second) == 1
    assert second[0]["track_id"] == 20


def test_collect_syncable_skips_active_rows():
    rows = [
        {
            "plate": "652190",
            "track_id": 1,
            "t_exit_sec": 50.0,
            "duration_sec": 20.0,
            "status": "active",
            "ocr_vote_count": 2,
            "ocr_confidence": 0.95,
        },
    ]
    assert _collect_syncable_rows(rows, set()) == []
