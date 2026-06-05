def test_health_ok(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert "app" in body
    assert "version" in body
    assert "visionflow_model_ready" in body
    assert "visionflow_model_family" in body


def test_ready_ok(client):
    r = client.get("/api/ready")
    assert r.status_code == 200
    assert r.json()["ready"] is True
