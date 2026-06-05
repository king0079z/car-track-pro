"""Service duration auto-sync from shop entry → supervisor sign-off."""
from datetime import UTC, datetime, timedelta

from app.services.service_duration import (
    collect_service_duration_samples,
    visit_shop_duration_minutes,
)


def test_visit_shop_duration_uses_signature(client, admin_token):
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
    assert body.get("duration_minutes") is not None
    assert body["duration_minutes"] >= 40

    svc = client.get(f"/api/services/{service_id}", headers=headers)
    assert svc.status_code == 200
    data = svc.json()
    assert data["is_auto_calculated"] is True
    assert data["duration_job_count"] >= 1
    assert data["estimated_duration_minutes"] >= 40


def test_infer_shop_duration_helper():
    from app.models.visit import Visit

    entry = datetime(2026, 6, 1, 10, 0, tzinfo=UTC)
    signed = datetime(2026, 6, 1, 11, 30, tzinfo=UTC)
    visit = Visit(entry_time=entry, signature_captured_at=signed)
    mins = visit_shop_duration_minutes(visit)
    assert mins == 90.0
