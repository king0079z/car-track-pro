def test_users_list_forbidden_for_staff(client, staff_token):
    r = client.get(
        "/api/users",
        headers={"Authorization": f"Bearer {staff_token}"},
    )
    assert r.status_code == 403


def test_users_list_ok_for_admin(client, admin_token):
    r = client.get(
        "/api/users",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert r.status_code == 200
    assert isinstance(r.json(), list)


def test_audit_list_forbidden_for_staff(client, staff_token):
    r = client.get(
        "/api/audit",
        headers={"Authorization": f"Bearer {staff_token}"},
    )
    assert r.status_code == 403


def test_audit_list_ok_for_manager(client, manager_token):
    r = client.get(
        "/api/audit",
        headers={"Authorization": f"Bearer {manager_token}"},
    )
    assert r.status_code == 200


def test_settings_get_forbidden_for_manager(client, manager_token):
    r = client.get(
        "/api/settings",
        headers={"Authorization": f"Bearer {manager_token}"},
    )
    assert r.status_code == 403


def test_settings_get_ok_for_admin(client, admin_token):
    r = client.get(
        "/api/settings",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert r.status_code == 200
    assert "business_name" in r.json()


def test_service_create_forbidden_for_staff(client, staff_token):
    r = client.post(
        "/api/services",
        json={
            "name": "Temp Service",
            "category": "other",
            "base_price": 1,
            "estimated_duration_minutes": 5,
        },
        headers={"Authorization": f"Bearer {staff_token}"},
    )
    assert r.status_code == 403
