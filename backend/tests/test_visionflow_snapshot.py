"""VisionFlow live preview snapshot endpoint."""

from app.routers import visionflow as vf


def test_snapshot_unknown_job_returns_404(client):
    r = client.get("/vf/api/jobs/does-not-exist/snapshot.jpg")
    assert r.status_code == 404


def test_snapshot_waiting_for_frame_returns_204(client):
    job_id = "test-job-waiting"
    with vf._jobs_lock:
        vf._jobs[job_id] = {
            "status": "running",
            "progress": 0,
            "message": "Loading models…",
            "processed_frames": 0,
            "total_frames_est": 100,
            "output_file": None,
            "input_name": "clip.mp4",
            "vehicles": [],
        }
    try:
        r = client.get(f"/vf/api/jobs/{job_id}/snapshot.jpg")
        assert r.status_code == 204
    finally:
        with vf._jobs_lock:
            vf._jobs.pop(job_id, None)


def test_snapshot_returns_jpeg_when_ready(client):
    job_id = "test-job-frame"
    jpeg = b"\xff\xd8\xff\xd9"
    with vf._jobs_lock:
        vf._jobs[job_id] = {
            "status": "running",
            "progress": 10,
            "message": "Analyzing…",
            "processed_frames": 5,
            "total_frames_est": 100,
            "output_file": None,
            "input_name": "clip.mp4",
            "vehicles": [],
        }
    with vf._preview_lock:
        vf._preview_jpeg[job_id] = jpeg
    try:
        r = client.get(f"/vf/api/jobs/{job_id}/snapshot.jpg")
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("image/jpeg")
        assert r.content == jpeg
    finally:
        with vf._preview_lock:
            vf._preview_jpeg.pop(job_id, None)
        with vf._jobs_lock:
            vf._jobs.pop(job_id, None)
