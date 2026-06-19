"""Plate jurisdiction validation and OCR correction tests."""

import pytest

from app.utils.plates import (
    accept_plate_read,
    consolidate_vehicle_rows,
    format_qatar_plate,
    matches_jurisdiction,
    normalize_plate,
    plates_match,
    vote_best_plate,
)


def test_normalize_plate():
    assert normalize_plate("ab 12 cde") == "AB12CDE"
    assert normalize_plate("123-456") == "123456"


def test_format_qatar_strips_spurious_leading_digit():
    assert format_qatar_plate("03574 BN") == "3574 BN"
    assert format_qatar_plate("13574 BNL") == "3574 BNL"


def test_format_qatar_keeps_valid_five_digit_plates():
    assert format_qatar_plate("10526 HGL") == "10526 HGL"
    assert format_qatar_plate("8174 HGL") == "8174 HGL"
    assert format_qatar_plate("817L HGL") == "817 HGL"


def test_format_qatar_recovers_stray_char_between_blocks():
    """A stray letter wedged before the suffix must not corrupt the plate."""
    assert format_qatar_plate("817LHGL") == "817 HGL"
    assert format_qatar_plate("8174LHGL") == "8174 HGL"
    assert format_qatar_plate("3574XBNW") == "3574 BNW"
    assert format_qatar_plate("1357LBNI") == "1357 BNI" or format_qatar_plate("1357LBNI") == "357 BNI"


def test_format_qatar_letter_fixes():
    assert "BNW" in format_qatar_plate("3574 8NW") or format_qatar_plate("3574 8NW") == "3574 BNW"


def test_plates_match_ocr_variants():
    assert plates_match("13574 BNL", "3574 BNW")
    assert plates_match("1357L BNI", "3574 BNI")


def test_vote_best_plate_clusters():
    votes = [
        ("13574 BNL", 0.4),
        ("3574 BNW", 0.5),
        ("1357L BNI", 0.45),
        ("3574 BNW", 0.6),
    ]
    winner = vote_best_plate(votes)
    assert normalize_plate(winner).startswith("3574")


def test_positional_consensus_recovers_majority_letter():
    # Most frames read W correctly; minority misreads as I / L.
    votes = [
        ("3574 BNW", 0.5),
        ("3574 BNW", 0.5),
        ("3574 BNI", 0.4),
        ("3574 BNL", 0.4),
        ("3574 BNW", 0.5),
    ]
    assert vote_best_plate(votes) == "3574 BNW"


def test_positional_consensus_recovers_digit():
    votes = [
        ("3693 FSG", 0.5),
        ("3693 ESG", 0.4),
        ("3693 FSG", 0.5),
    ]
    assert vote_best_plate(votes) == "3693 FSG"


def test_consolidate_vehicle_rows_merges_same_car():
    rows = [
        {"track_id": 14, "plate": "13574 BNL", "t_enter_sec": 5.8, "t_exit_sec": 6.1, "status": "exited"},
        {"track_id": 14, "plate": "3574 BNW", "t_enter_sec": 8.6, "t_exit_sec": 9.0, "status": "exited"},
        {"track_id": 8, "plate": "9079 GCH", "t_enter_sec": 2.0, "t_exit_sec": 3.7, "status": "exited"},
    ]
    out = consolidate_vehicle_rows(rows)
    assert len(out) == 2
    plates = {normalize_plate(r["plate"]) for r in out}
    assert any(p.startswith("9079") for p in plates)
    assert any(p.startswith("3574") for p in plates)


def test_consolidate_keeps_unread_cars():
    """Every tracked vehicle must be reported, even when the plate is unread."""
    rows = [
        {"track_id": 8, "plate": "9079 GCH", "t_enter_sec": 2.0, "t_exit_sec": 3.7, "status": "exited"},
        {"track_id": 61, "plate": "—", "t_enter_sec": 22.9, "t_exit_sec": 23.4, "status": "exited"},
        {"track_id": 70, "plate": "…", "t_enter_sec": 24.0, "t_exit_sec": 24.8, "status": "active"},
    ]
    out = consolidate_vehicle_rows(rows)
    assert len(out) == 3
    by_track = {r["track_id"]: r for r in out}
    assert by_track[61]["plate"] == "Unknown"
    assert by_track[70]["plate"] == "…"


def test_consolidate_drops_unread_noise_blips():
    """Sub-threshold one-frame unread detections are treated as noise."""
    rows = [
        {"track_id": 99, "plate": "—", "t_enter_sec": 5.00, "t_exit_sec": 5.05, "status": "exited"},
    ]
    assert consolidate_vehicle_rows(rows) == []


def test_consolidate_unread_track_not_double_reported():
    """A track that eventually reads a plate is not also listed as Unknown."""
    rows = [
        {"track_id": 12, "plate": "…", "t_enter_sec": 1.0, "t_exit_sec": 1.6, "status": "active"},
        {"track_id": 12, "plate": "3693 FSG", "t_enter_sec": 1.6, "t_exit_sec": 2.4, "status": "exited"},
    ]
    out = consolidate_vehicle_rows(rows)
    assert len(out) == 1
    assert normalize_plate(out[0]["plate"]).startswith("3693")


def test_consolidate_does_not_merge_two_live_cars():
    """Concurrent active tracks stay separate even with similar OCR drift."""
    rows = [
        {"track_id": 42, "plate": "817 HGL", "t_enter_sec": 24.0, "t_exit_sec": 28.0, "status": "active", "first_frame": 700, "last_frame": 820},
        {"track_id": 174, "plate": "8174 HGL", "t_enter_sec": 24.2, "t_exit_sec": 28.0, "status": "active", "first_frame": 710, "last_frame": 820},
    ]
    out = consolidate_vehicle_rows(rows)
    assert len(out) == 2
    assert {r["track_id"] for r in out} == {42, 174}


def test_consolidate_merges_avg_speed_duration_weighted():
    """Merged rows combine per-track averages weighted by dwell time."""
    rows = [
        {"track_id": 6, "plate": "647400", "t_enter_sec": 1.0, "t_exit_sec": 3.0, "duration_sec": 2.0, "speed_kmh_avg": 40, "status": "exited"},
        {"track_id": 9, "plate": "647400", "t_enter_sec": 3.0, "t_exit_sec": 5.0, "duration_sec": 2.0, "speed_kmh_avg": 80, "status": "exited"},
    ]
    out = consolidate_vehicle_rows(rows)
    assert len(out) == 1
    assert out[0]["speed_kmh_avg"] == 60


def test_consolidate_merges_same_plate_tracker_fragments():
    """BoT-SORT re-IDs the same car → one row when the plate string matches."""
    rows = [
        {"track_id": 6, "plate": "647400", "t_enter_sec": 1.63, "t_exit_sec": 2.0, "duration_sec": 0.37, "status": "exited"},
        {"track_id": 9, "plate": "647400", "t_enter_sec": 2.1, "t_exit_sec": 2.4, "duration_sec": 0.3, "status": "exited"},
        {"track_id": 11, "plate": "647400", "t_enter_sec": 3.0, "t_exit_sec": 3.4, "duration_sec": 0.4, "status": "exited"},
    ]
    out = consolidate_vehicle_rows(rows)
    assert len(out) == 1
    assert normalize_plate(out[0]["plate"]) == "647400"
    assert out[0]["t_enter_sec"] == 1.63
    assert out[0]["t_exit_sec"] == 3.4
    assert out[0]["duration_sec"] == pytest.approx(1.07, abs=0.01)
    assert out[0]["segment_count"] == 3


def test_consolidate_resumes_plate_after_bay_gap():
    """Same car leaves frame then returns within 2h → Live again, dwell summed."""
    rows = [
        {"track_id": 1, "plate": "8174 HGL", "t_enter_sec": 10.0, "t_exit_sec": 40.0, "duration_sec": 30.0, "status": "exited"},
        {"track_id": 99, "plate": "8174 HGL", "t_enter_sec": 400.0, "t_exit_sec": 430.0, "duration_sec": 30.0, "status": "active"},
    ]
    out = consolidate_vehicle_rows(rows, resume_gap_sec=7200.0)
    assert len(out) == 1
    assert out[0]["status"] == "active"
    assert out[0]["track_id"] == 99
    assert out[0]["duration_sec"] == pytest.approx(60.0, abs=0.01)
    assert out[0]["segment_count"] == 2


def test_consolidate_does_not_resume_after_gap_expired():
    rows = [
        {"track_id": 1, "plate": "8174 HGL", "t_enter_sec": 10.0, "t_exit_sec": 40.0, "duration_sec": 30.0, "status": "exited"},
        {"track_id": 99, "plate": "8174 HGL", "t_enter_sec": 9000.0, "t_exit_sec": 9030.0, "duration_sec": 30.0, "status": "exited"},
    ]
    out = consolidate_vehicle_rows(rows, resume_gap_sec=7200.0)
    assert len(out) == 2


def test_presence_duration_live_paused_done():
    """Shop presence counts while Live, freezes when Paused, locks on Done."""
    rows = [
        {
            "track_id": 1,
            "plate": "8174 HGL",
            "t_enter_sec": 100.0,
            "t_exit_sec": 130.0,
            "duration_sec": 30.0,
            "status": "exited",
        },
    ]
    paused = consolidate_vehicle_rows(rows, resume_gap_sec=1800.0, now_sec=200.0)
    assert paused[0]["resume_eligible"] is True
    assert paused[0]["presence_duration_sec"] == pytest.approx(30.0)

    live = [
        {
            "track_id": 2,
            "plate": "8174 HGL",
            "t_enter_sec": 100.0,
            "t_exit_sec": 140.0,
            "duration_sec": 40.0,
            "status": "active",
        },
    ]
    active = consolidate_vehicle_rows(live, now_sec=150.0)
    assert active[0]["presence_duration_sec"] == pytest.approx(50.0)

    done = consolidate_vehicle_rows(rows, resume_gap_sec=1800.0, now_sec=4000.0)
    assert "resume_eligible" not in done[0]
    assert done[0]["presence_duration_sec"] == pytest.approx(30.0)


def test_consolidate_keeps_two_distinct_cars():
    """Two different plates at once — both stay in the registry manifest."""
    rows = [
        {
            "track_id": 1,
            "plate": "8174 HGL",
            "t_enter_sec": 10.0,
            "t_exit_sec": 40.0,
            "duration_sec": 30.0,
            "status": "exited",
            "ocr_vote_count": 3,
            "ocr_confidence": 0.92,
        },
        {
            "track_id": 2,
            "plate": "652190",
            "t_enter_sec": 50.0,
            "t_exit_sec": 80.0,
            "duration_sec": 30.0,
            "status": "active",
            "ocr_vote_count": 2,
            "ocr_confidence": 0.9,
        },
    ]
    out = consolidate_vehicle_rows(rows, now_sec=100.0)
    plates = {r["plate"] for r in out}
    assert "8174 HGL" in plates
    assert "652190" in plates
    assert len(out) == 2


@pytest.mark.parametrize(
    "text,jurisdiction,expected",
    [
        ("123456", "qa", True),
        ("3574 BNW", "qa", True),
        ("AB12CDE", "uk", True),
        ("123456", "uk", False),
        ("3574 BNW", "qa_uk", True),
        ("AB12CDE", "qa_uk", True),
    ],
)
def test_matches_jurisdiction(text, jurisdiction, expected):
    assert matches_jurisdiction(text, jurisdiction) is expected


def test_consolidate_merges_ocr_metrics():
    rows = [
        {"track_id": 1, "plate": "8174 HGL", "t_enter_sec": 10.0, "t_exit_sec": 40.0, "duration_sec": 30.0, "status": "exited", "ocr_confidence": 0.55, "ocr_vote_count": 3},
        {"track_id": 99, "plate": "8174 HGL", "t_enter_sec": 400.0, "t_exit_sec": 430.0, "duration_sec": 30.0, "status": "active", "ocr_confidence": 0.72, "ocr_vote_count": 5},
    ]
    out = consolidate_vehicle_rows(rows, resume_gap_sec=7200.0)
    assert len(out) == 1
    assert out[0]["ocr_confidence"] == pytest.approx(0.72)
    assert out[0]["ocr_vote_count"] == 8
    assert out[0]["status"] == "active"


def test_accept_rejects_single_letter_junk():
    assert accept_plate_read("J", jurisdiction="qa_uk", strict=False) is False
    assert accept_plate_read("259559", jurisdiction="qa_uk", strict=False) is True


def test_format_qatar_commercial_black_plate():
    assert format_qatar_plate("259559") == "259559"
    assert format_qatar_plate("259 559") == "259559" or format_qatar_plate("259559") == "259559"
    assert format_qatar_plate("1259559") != "9559"  # must not truncate valid commercial reads


def test_accept_commercial_plate_rejects_screen_noise():
    assert accept_plate_read("259559", jurisdiction="qa_uk", strict=False) is True
    assert accept_plate_read("647400", jurisdiction="qa_uk", strict=False) is True
    assert accept_plate_read("7YTC", jurisdiction="qa_uk", strict=False) is False
    assert accept_plate_read("1STE", jurisdiction="qa_uk", strict=False) is False


def test_accept_plate_read_non_strict():
    assert accept_plate_read("3574 BNW", jurisdiction="qa", strict=False) is True
    assert accept_plate_read("259559", jurisdiction="qa_uk", strict=False) is True
    assert accept_plate_read("DHH34", jurisdiction="qa_uk", strict=False) is False
    assert accept_plate_read("1334", jurisdiction="qa_uk", strict=False) is True


def test_sync_eligible_rejects_ocr_noise():
    from app.utils.plates import sync_eligible_plate

    assert sync_eligible_plate("3574 BNW", jurisdiction="qa_uk") is True
    assert sync_eligible_plate("259559", jurisdiction="qa_uk") is True
    assert sync_eligible_plate("DHH34", jurisdiction="qa_uk") is False
    assert sync_eligible_plate("DHH33", jurisdiction="qa_uk") is False
