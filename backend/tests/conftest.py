"""Pytest: environment must be set before importing `app` (engine binds at import time)."""
from __future__ import annotations

import os
import tempfile
from pathlib import Path

_tmp_root = Path(tempfile.mkdtemp(prefix="cartrack_pytest_"))
_test_db = _tmp_root / "test.db"
os.environ["DATABASE_URL"] = f"sqlite:///{_test_db.as_posix()}"
os.environ["AUDIT_RUN_ON_STARTUP"] = "false"
os.environ["AUDIT_PERIODIC_INTERVAL_SECONDS"] = "86400"
os.environ["AUDIT_STARTUP_DELAY_SECONDS"] = "86400"
os.environ["UPLOAD_DIR"] = str(_tmp_root / "uploads")

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture(scope="session")
def client() -> TestClient:
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="session")
def admin_token(client: TestClient) -> str:
    r = client.post(
        "/api/auth/login",
        json={"username": "admin", "password": "demo1234"},
    )
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


@pytest.fixture(scope="session")
def staff_token(client: TestClient, admin_token: str) -> str:
    """Create a staff user via admin API and return their JWT."""
    headers = {"Authorization": f"Bearer {admin_token}"}
    payload = {
        "full_name": "Staff Tester",
        "email": "staff_test@cartrack.qa",
        "username": "staff_test",
        "password": "staffpass123",
        "role": "staff",
    }
    r = client.post("/api/users", json=payload, headers=headers)
    assert r.status_code == 201, r.text
    r2 = client.post(
        "/api/auth/login",
        json={"username": "staff_test", "password": "staffpass123"},
    )
    assert r2.status_code == 200, r2.text
    return r2.json()["access_token"]


@pytest.fixture(scope="session")
def manager_token(client: TestClient, admin_token: str) -> str:
    headers = {"Authorization": f"Bearer {admin_token}"}
    payload = {
        "full_name": "Manager Tester",
        "email": "manager_test@cartrack.qa",
        "username": "manager_test",
        "password": "managerpass123",
        "role": "manager",
    }
    r = client.post("/api/users", json=payload, headers=headers)
    assert r.status_code == 201, r.text
    r2 = client.post(
        "/api/auth/login",
        json={"username": "manager_test", "password": "managerpass123"},
    )
    assert r2.status_code == 200, r2.text
    return r2.json()["access_token"]
