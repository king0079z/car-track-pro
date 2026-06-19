def test_services_list_authenticated(client, admin_token):
    r = client.get(
        "/api/services",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert r.status_code == 200
    services = r.json()
    assert len(services) >= 1


def test_vehicles_list_and_create(client, admin_token):
    headers = {"Authorization": f"Bearer {admin_token}"}
    r = client.get("/api/vehicles", headers=headers)
    assert r.status_code == 200
    r2 = client.post(
        "/api/vehicles",
        json={
            "plate_number": "QA-TEST-001",
            "plate_country": "QA",
            "make": "Test",
            "model": "Car",
            "owner_name": "Pytest",
        },
        headers=headers,
    )
    assert r2.status_code == 201
    vid = r2.json()["id"]
    r3 = client.get(f"/api/vehicles/{vid}", headers=headers)
    assert r3.status_code == 200
    assert r3.json()["plate_number"] == "QA-TEST-001"


def test_visits_list_and_create(client, admin_token):
    headers = {"Authorization": f"Bearer {admin_token}"}
    v = client.post(
        "/api/vehicles",
        json={"plate_number": "QA-VISIT-01", "plate_country": "QA"},
        headers=headers,
    )
    assert v.status_code == 201
    vehicle_id = v.json()["id"]
    r = client.post(
        "/api/visits",
        json={"vehicle_id": vehicle_id, "customer_name": "Walk-in"},
        headers=headers,
    )
    assert r.status_code == 201
    visit_id = r.json()["id"]
    r2 = client.get("/api/visits", headers=headers)
    assert r2.status_code == 200
    ids = {row["id"] for row in r2.json()}
    assert visit_id in ids


def test_in_shop_vehicles(client, admin_token):
    headers = {"Authorization": f"Bearer {admin_token}"}
    r = client.get("/api/visits/in-shop", headers=headers)
    assert r.status_code == 200
    assert isinstance(r.json(), list)


def test_update_service_item_duration_mixed_tz(client, admin_token):
    """Complete service line — must not 500 when started/completed tz differs."""
    headers = {"Authorization": f"Bearer {admin_token}"}
    v = client.post(
        "/api/vehicles",
        json={"plate_number": "QA-SVC-TZ", "plate_country": "QA"},
        headers=headers,
    )
    assert v.status_code == 201
    svc_list = client.get("/api/services", headers=headers)
    assert svc_list.status_code == 200
    service_id = svc_list.json()[0]["id"]
    visit = client.post(
        "/api/visits",
        json={
            "vehicle_id": v.json()["id"],
            "service_ids": [{"service_id": service_id, "price": 50}],
        },
        headers=headers,
    )
    assert visit.status_code == 201
    body = visit.json()
    visit_id = body["id"]
    item_id = body["service_items"][0]["id"]
    start = client.patch(
        f"/api/visits/{visit_id}/services/{item_id}",
        json={"status": "in_progress", "started_at": "2026-06-02T10:00:00"},
        headers=headers,
    )
    assert start.status_code == 200
    done = client.patch(
        f"/api/visits/{visit_id}/services/{item_id}",
        json={"status": "completed", "completed_at": "2026-06-02T11:30:00Z"},
        headers=headers,
    )
    assert done.status_code == 200
    item = done.json()["service_items"][0]
    assert item["actual_duration_minutes"] == 90.0


def test_checkout_marks_payment_paid(client, admin_token):
    headers = {"Authorization": f"Bearer {admin_token}"}
    v = client.post(
        "/api/vehicles",
        json={"plate_number": "QA-PAY-01", "plate_country": "QA"},
        headers=headers,
    )
    assert v.status_code == 201
    visit = client.post(
        "/api/visits",
        json={"vehicle_id": v.json()["id"], "customer_name": "Pay test"},
        headers=headers,
    )
    assert visit.status_code == 201
    visit_id = visit.json()["id"]
    assert visit.json()["payment_status"] == "unpaid"

    checkout = client.post(f"/api/visits/{visit_id}/checkout", headers=headers)
    assert checkout.status_code == 200
    body = checkout.json()
    assert body["status"] == "completed"
    assert body["payment_status"] == "paid"


def test_complete_visit_via_patch_marks_payment_paid(client, admin_token):
    headers = {"Authorization": f"Bearer {admin_token}"}
    v = client.post(
        "/api/vehicles",
        json={"plate_number": "QA-PAY-02", "plate_country": "QA"},
        headers=headers,
   )
    assert v.status_code == 201
    visit = client.post(
        "/api/visits",
        json={"vehicle_id": v.json()["id"]},
        headers=headers,
    )
    assert visit.status_code == 201
    visit_id = visit.json()["id"]

    updated = client.patch(
        f"/api/visits/{visit_id}",
        json={"status": "completed", "exit_time": "2026-06-10T12:00:00Z"},
        headers=headers,
    )
    assert updated.status_code == 200
    assert updated.json()["status"] == "completed"
    assert updated.json()["payment_status"] == "paid"


def test_analytics_service_endpoints(client, admin_token):
    headers = {"Authorization": f"Bearer {admin_token}"}
    for path in (
        "/api/analytics/service-duration?days=7",
        "/api/analytics/service-duration-by-vehicle-type?days=90&vehicle_types=sedan,suv",
        "/api/analytics/by-vehicle-type?days=7",
    ):
        r = client.get(path, headers=headers)
        assert r.status_code == 200, f"{path} -> {r.status_code}: {r.text[:200]}"


def test_analytics_dashboard(client, admin_token):
    r = client.get(
        "/api/analytics/dashboard",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert r.status_code == 200
    data = r.json()
    assert "total_cars_today" in data
    assert "cars_in_shop" in data
