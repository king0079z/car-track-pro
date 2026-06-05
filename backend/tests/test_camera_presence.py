"""Camera presence resume window and work-order dwell accumulation."""

from datetime import UTC, datetime, timedelta

import pytest

from app.models.anpr import ANPRDetection
from app.services.camera_presence import segment_already_synced


def test_segment_dedupe_allows_multiple_exits_same_plate():
    rows = [
        ANPRDetection(plate="8174 HGL", job_id="live-1", track_id=1, t_exit_sec=10.0, duration_sec=8.0),
    ]
    assert segment_already_synced(rows, "8174 HGL", 1, 10.0) is True
    assert segment_already_synced(rows, "8174 HGL", 2, 50.0) is False


def test_api_visit_resume_camera_dwell_after_two_segments(client, admin_token):
    """Two exited camera segments on an unsigned work order accumulate in-frame seconds."""
    headers = {"Authorization": f"Bearer {admin_token}"}
    plate = "QA-RESUME-1"
    v = client.post(
        "/api/vehicles",
        json={"plate_number": plate, "plate_country": "QA", "vehicle_type": "sedan"},
        headers=headers,
    )
    assert v.status_code == 201
    vehicle_id = v.json()["id"]
    svc = client.get("/api/services", headers=headers).json()[0]["id"]

    wo = client.post(
        "/api/visits",
        json={
            "vehicle_id": vehicle_id,
            "service_ids": [{"service_id": svc, "price": 50}],
        },
        headers=headers,
    )
    assert wo.status_code == 201
    visit_id = wo.json()["id"]
    assert wo.json().get("signature_captured_at") is None

    from app.routers.visionflow import _auto_sync_to_cartrack

    job_id = "test-live-resume"
    _auto_sync_to_cartrack(job_id, "cam-0", [
        {
            "plate": plate,
            "track_id": 10,
            "duration_sec": 30.0,
            "t_enter_sec": 0.0,
            "t_exit_sec": 30.0,
            "status": "exited",
        },
        {
            "plate": plate,
            "track_id": 20,
            "duration_sec": 22.0,
            "t_enter_sec": 400.0,
            "t_exit_sec": 422.0,
            "status": "exited",
        },
    ])

    refreshed = client.get(f"/api/visits/{visit_id}", headers=headers)
    assert refreshed.status_code == 200

    from app.database import SessionLocal
    from app.models.anpr import ANPRDetection as Det

    s = SessionLocal()
    try:
        dets = s.query(Det).filter(Det.job_id == job_id).all()
        assert len(dets) == 2
        assert all(d.visit_id == visit_id for d in dets), [(d.track_id, d.visit_id, d.duration_sec) for d in dets]
    finally:
        s.close()

    assert refreshed.json()["anpr_camera_seconds"] == pytest.approx(52.0)

    signed = client.post(
        f"/api/visits/{visit_id}/signature",
        json={"signature": "data:image/png;base64,signed"},
        headers=headers,
    )
    assert signed.status_code == 200
    assert signed.json().get("signature_captured_at") is not None
    frozen_secs = signed.json()["anpr_camera_seconds"]

    _auto_sync_to_cartrack(job_id, "cam-0", [
        {
            "plate": plate,
            "track_id": 30,
            "duration_sec": 99.0,
            "t_enter_sec": 500.0,
            "t_exit_sec": 599.0,
            "status": "exited",
        },
    ])

    after = client.get(f"/api/visits/{visit_id}", headers=headers)
    assert after.json()["anpr_camera_seconds"] == pytest.approx(frozen_secs)


def test_api_no_visit_link_after_resume_gap_expired(client, admin_token, monkeypatch):
    """After 2h without camera activity, new segments stay unlinked (pending registration)."""
    monkeypatch.setattr("app.services.camera_presence.settings.PLATE_RESUME_GAP_SEC", 7200.0)
    headers = {"Authorization": f"Bearer {admin_token}"}
    plate = "QA-GAP-EXP"
    v = client.post(
        "/api/vehicles",
        json={"plate_number": plate, "plate_country": "QA", "vehicle_type": "sedan"},
        headers=headers,
    )
    assert v.status_code == 201
    vehicle_id = v.json()["id"]
    svc = client.get("/api/services", headers=headers).json()[0]["id"]
    wo = client.post(
        "/api/visits",
        json={"vehicle_id": vehicle_id, "service_ids": [{"service_id": svc, "price": 40}]},
        headers=headers,
    )
    visit_id = wo.json()["id"]

    from app.database import SessionLocal
    from app.models.anpr import ANPRDetection as Det

    session = SessionLocal()
    try:
        old = Det(
            plate=plate,
            visit_id=visit_id,
            job_id="old",
            track_id=1,
            duration_sec=15.0,
            detected_at=datetime.now(UTC) - timedelta(hours=3),
        )
        session.add(old)
        session.commit()
    finally:
        session.close()

    from app.routers.visionflow import _auto_sync_to_cartrack

    _auto_sync_to_cartrack("gap-job", "cam", [{
        "plate": plate,
        "track_id": 2,
        "duration_sec": 10.0,
        "t_exit_sec": 10.0,
        "status": "exited",
    }])

    refreshed = client.get(f"/api/visits/{visit_id}", headers=headers)
    assert refreshed.json()["anpr_camera_seconds"] in (None, 15.0, pytest.approx(15.0))
