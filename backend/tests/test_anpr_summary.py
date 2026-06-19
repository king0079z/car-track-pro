"""ANPR dashboard summary endpoint."""

from datetime import UTC, datetime, timedelta

from app.models.anpr import ANPRDetection


def test_anpr_summary_groups_by_plate(client, admin_token):
    headers = {"Authorization": f"Bearer {admin_token}"}
    from app.database import SessionLocal

    db = SessionLocal()
    try:
        db.add(ANPRDetection(
            plate="8174 HGL",
            job_id="job-a",
            track_id=1,
            duration_sec=30.0,
            presence_duration_sec=45.0,
            speed_kmh=40,
            detected_at=datetime.now(UTC),
        ))
        db.add(ANPRDetection(
            plate="8174 HGL",
            job_id="job-a",
            track_id=2,
            duration_sec=20.0,
            presence_duration_sec=45.0,
            speed_kmh=55,
            detected_at=datetime.now(UTC) - timedelta(minutes=5),
        ))
        db.add(ANPRDetection(
            plate="652190",
            job_id="job-b",
            track_id=3,
            duration_sec=15.0,
            presence_duration_sec=15.0,
            detected_at=datetime.now(UTC),
        ))
        db.commit()
    finally:
        db.close()

    r = client.get("/api/anpr/summary?limit_plates=10&lookback_days=7", headers=headers)
    assert r.status_code == 200
    data = r.json()
    assert data["total_plates"] >= 2
    hgl = next(p for p in data["plates"] if p["plate"] == "8174 HGL")
    assert hgl["segment_count"] == 2
    assert hgl["total_presence_sec"] == 45.0
    assert hgl["total_duration_sec"] == 50.0
    assert len(hgl["segments"]) == 2
