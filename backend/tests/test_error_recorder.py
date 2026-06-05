"""Tests for structured application error recording."""

import pytest

from app.database import SessionLocal
from app.services.error_recorder import make_fingerprint, record_application_error


@pytest.fixture
def db(client):
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


def test_make_fingerprint_stable():
    a = make_fingerprint("visionflow", "ocr", "bad read")
    b = make_fingerprint("visionflow", "ocr", "bad read")
    assert a == b
    assert len(a) == 48


def test_record_and_dedupe(db):
    fp = make_fingerprint("test", "unit", "dedupe")
    row1 = record_application_error(
        db,
        severity="error",
        category="visionflow",
        source="test.unit",
        message="Plate sync failed",
        job_id="job-abc",
        fingerprint=fp,
        dedupe_seconds=300,
    )
    assert row1 is not None
    assert row1.occurrence_count == 1

    row2 = record_application_error(
        db,
        severity="error",
        category="visionflow",
        source="test.unit",
        message="Plate sync failed",
        job_id="job-abc",
        fingerprint=fp,
        dedupe_seconds=300,
    )
    assert row2 is not None
    assert row2.id == row1.id
    assert row2.occurrence_count == 2


def test_list_errors_api(client, admin_token, db):
    record_application_error(
        db,
        severity="warning",
        category="camera",
        source="test.live",
        message="Stream reconnect",
        job_id="live-1",
    )
    headers = {"Authorization": f"Bearer {admin_token}"}
    res = client.get("/api/errors/stats", headers=headers)
    assert res.status_code == 200
    data = res.json()
    assert data["total"] >= 1
    assert data["plate_monitoring"] >= 1

    res2 = client.get("/api/errors?categories=visionflow,anpr,camera", headers=headers)
    assert res2.status_code == 200
    rows = res2.json()
    assert any(r["category"] == "camera" for r in rows)


def test_resolve_error(client, admin_token, db):
    row = record_application_error(
        db,
        severity="error",
        category="api",
        source="test.api",
        message="HTTP 500 on /api/foo",
    )
    headers = {"Authorization": f"Bearer {admin_token}"}
    res = client.patch(f"/api/errors/{row.id}", json={"resolved": True}, headers=headers)
    assert res.status_code == 200
    assert res.json()["resolved"] is True


def test_non_admin_forbidden(client, staff_token):
    res = client.get(
        "/api/errors/stats",
        headers={"Authorization": f"Bearer {staff_token}"},
    )
    assert res.status_code == 403
