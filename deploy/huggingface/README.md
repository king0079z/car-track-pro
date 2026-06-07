---
title: CarTrack ANPR
emoji: 🚗
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
short_description: AI car-tracking & Qatar license-plate ANPR (upload + live 24/7)
---

# CarTrack — ANPR (Hugging Face demo)

AI-powered car-tracking dashboard with Qatar license-plate recognition
(YOLO plate detection + BoT-SORT tracking + plate OCR).

## Two ways to use this Space

**1. Upload a video (works out of the box).** Open the dashboard → **VisionFlow /
ANPR** → **upload a video file** and watch it detect, track, and read plates.

**2. Live 24/7 ANPR (needs 3 secrets).** The image runs the live supervisor and
auto-(re)starts cameras on boot. Set these in **Settings → Variables and secrets**:

- `LIVE_RTSP_URL` — an **internet-reachable** stream (a cloud-relay view URL, a
  public RTSP-over-TCP camera, or an HLS URL). HF can't reach a LAN camera or the
  Dahua Easy4IP **P2P (UDP)** tunnel, so the camera must be exposed via a relay or
  public RTSP (see `deploy/relay/`).
- `DATABASE_URL` — a free managed **Postgres** (Neon/Supabase). Free Spaces have
  **no persistent disk**, so detections only survive restarts when stored off-box.
- `SECRET_KEY` — your own ≥32-char string for stable login sessions.

See `.env.huggingface.example` and `DEPLOY-HUGGINGFACE.md` for the full setup.

**Default login:** `admin` / `demo1234`

## Free-tier limits to know

- Free Spaces **sleep** after ~48 h of no HTTP traffic — keep it awake for true
  24/7 with a free uptime pinger (UptimeRobot / cron-job.org) hitting `/api/ready`.
- **No persistent disk** — recordings reset on restart; use `DATABASE_URL` so the
  extracted plates/speeds/times persist.

For a never-sleeping, no-relay live system, deploy `deploy/cloud/` on Oracle A1
(always-free VM) — same code.
