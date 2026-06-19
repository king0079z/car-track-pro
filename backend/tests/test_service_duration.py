"""Service duration auto-sync from shop entry → checkout (Done)."""
from datetime import UTC, datetime, timedelta

import pytest

from app.models.visit import Visit, VisitStatus
from app.services.service_duration import (
    collect_service_duration_samples,
    visit_shop_duration_minutes,
)


def test_visit_shop_duration_uses_checkout(client, admin_token):
    headers = {"Authorization": f"Bearer {admin_token}"}
    v = client.post(
        "/api/vehicles",
        json={"plate_number": "QA-DUR-SIG", "plate_country": "QA"},
        headers=headers,
    )
    assert v.status_code == 201
    svc_list = client.get("/api/services", headers=headers)
    service_id = svc_list.json()[0]["id"]

    entry = datetime.now(UTC) - timedelta(minutes=45)
    visit = client.post(
        "/api/visits",
        json={
            "vehicle_id": v.json()["id"],
            "entry_time": entry.isoformat(),
            "supervisor_signature": "data:image/png;base64,test",
            "service_ids": [{"service_id": service_id, "price": 80}],
        },
        headers=headers,
    )
    assert visit.status_code == 201
    body = visit.json()
    visit_id = body["id"]
    # Issue signature must not collapse duration to ~0 while still open.
    assert body.get("duration_minutes") in (None, 0)

    checkout = client.post(f"/api/visits/{visit_id}/checkout", headers=headers)
    assert checkout.status_code == 200
    checked = checkout.json()
    assert checked["duration_minutes"] is not None
    assert checked["duration_minutes"] >= 40

    svc = client.get(f"/api/services/{service_id}", headers=headers)
    assert svc.status_code == 200
    data = svc.json()
    assert data["is_auto_calculated"] is True
    assert data["duration_job_count"] >= 1
    assert data["estimated_duration_minutes"] >= 40


def test_infer_shop_duration_helper():
    entry = datetime(2026, 6, 1, 10, 0, tzinfo=UTC)
    done = datetime(2026, 6, 1, 11, 30, tzinfo=UTC)
    visit = Visit(
        entry_time=entry,
        exit_time=done,
        status=VisitStatus.COMPLETED,
        anpr_camera_seconds=5400.0,
    )
    mins = visit_shop_duration_minutes(visit)
    assert mins == 90.0


def test_camera_preferred_over_long_wall_clock():
    """8 min on camera must not inflate to 6h open work-order wall time."""
    entry = datetime(2026, 6, 1, 10, 0, tzinfo=UTC)
    done = datetime(2026, 6, 1, 16, 0, tzinfo=UTC)
    visit = Visit(
        entry_time=entry,
        exit_time=done,
        status=VisitStatus.COMPLETED,
        anpr_camera_seconds=480.0,
    )
    assert visit_shop_duration_minutes(visit) == pytest.approx(8.0)


def test_camera_seconds_used_when_checkout_is_instant():
    entry = datetime(2026, 6, 1, 10, 0, tzinfo=UTC)
    visit = Visit(
        entry_time=entry,
        exit_time=entry,
        status=VisitStatus.COMPLETED,
        anpr_camera_seconds=1800.0,
    )
    assert visit_shop_duration_minutes(visit) == 30.0


def test_collect_samples_skips_open_visits(client, admin_token):
    headers = {"Authorization": f"Bearer {admin_token}"}
    v = client.post(
        "/api/vehicles",
        json={"plate_number": "QA-DUR-OPEN", "plate_country": "QA"},
        headers=headers,
    )
    svc_id = client.get("/api/services", headers=headers).json()[0]["id"]
    visit = client.post(
        "/api/visits",
        json={
            "vehicle_id": v.json()["id"],
            "service_ids": [{"service_id": svc_id, "price": 50}],
        },
        headers=headers,
    ).json()

    from app.database import SessionLocal

    db = SessionLocal()
    try:
        samples = collect_service_duration_samples(db, service_id=svc_id)
        assert all(s[0] > 0 for s in samples)
    finally:
        db.close()

    assert visit["status"] == "waiting"
