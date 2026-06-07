# ─────────────────────────────────────────────────────────────────────────────
# CarTrack — Hugging Face Docker Space (single-port, all-in-one)
#
# HF Spaces expose ONLY ONE port (7860), so this image runs the FastAPI backend
# (YOLO + OCR ANPR) AND serves the React SPA on that same port. The browser then
# reaches the API at /api, VisionFlow at /vf and the live WebSocket at
# wss://<your-space>.hf.space/ws — all same-origin.
#
# IMPORTANT — this is the FREE OFFLINE demo of the engine:
#   • HF free Spaces SLEEP after inactivity and have NO persistent disk, so the
#     databases/recordings reset on restart.
#   • The live camera (Easy4IP P2P) needs outbound UDP that HF blocks, so use the
#     "Upload video → analyze" flow here, not the live camera.
# For the always-on live system, deploy on Oracle A1 / GCP (see deploy/cloud).
#
# This Dockerfile MUST sit at the ROOT of the Space repo (build context = root),
# because it copies ./frontend and ./backend. push-to-space.ps1 places it there.
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: build the React SPA in gateway (relative-URL) mode ───────────────
FROM node:20-alpine AS web
WORKDIR /web
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
# Gateway mode → API_BASE_URL="" (relative /api) and WS → wss://<host>/ws, so the
# bundle talks to the same origin it is served from (this Space).
RUN printf 'VITE_GATEWAY_MODE=true\n' > .env.production \
    && npm run build

# ── Stage 2: FastAPI backend + serve the built SPA ────────────────────────────
FROM python:3.11-slim
WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    FRONTEND_DIST=/app/frontend_dist \
    PORT=7860 \
    # Keep all ML caches in writable /tmp (HF home dir is read-only at runtime).
    HF_HOME=/tmp/hf \
    MPLCONFIGDIR=/tmp/mpl \
    YOLO_CONFIG_DIR=/tmp/ultralytics \
    EASYOCR_MODULE_PATH=/tmp/easyocr \
    # ── 24/7 live ANPR (all overridable in Space → Settings → Variables/Secrets) ─
    # The supervisor runs and auto-(re)starts every enabled camera on boot, so ANPR
    # comes back by itself after a Space restart. Point it at an internet-reachable
    # stream with the LIVE_RTSP_URL secret (a cloud-relay view URL or public RTSP/
    # HLS) — HF can't reach a LAN camera or the Easy4IP P2P UDP tunnel.
    LIVE_24_7_ENABLED=true \
    LIVE_RESUME_ON_STARTUP=true \
    LIVE_PROBE_CAMERAS_ON_STARTUP=false \
    # P2P UDP is blocked on HF — never block boot prewarming a tunnel that can't form.
    DAHUA_P2P_PREWARM_ON_STARTUP=false \
    # Free Spaces have NO persistent disk; cap recordings so the container FS can't
    # fill. The extracted plates/speeds/times live in the DB (use an external
    # DATABASE_URL secret to persist them across restarts).
    LIVE_SEGMENT_MAX_GB=2 \
    ANALYSIS_MEDIA_RETENTION_HOURS=6

# OpenCV (headless) + video decode + OpenMP runtime for Torch/ONNX.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libglib2.0-0 libgl1 libgomp1 ffmpeg build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt .
# Headless OpenCV in containers (no X11/GL); identical cv2 API, smaller image.
RUN sed -i 's/^opencv-python>=/opencv-python-headless>=/' requirements.txt \
    && pip install --upgrade pip \
    && pip install -r requirements.txt

# Backend source + trained YOLO/OCR weights (backend/models/*.pt, ~6 MB each).
COPY backend/ .
# Built SPA from stage 1.
COPY --from=web /web/dist /app/frontend_dist

# HF runs containers as a non-root user (UID 1000); make the app dir writable so
# SQLite DBs, uploads and outputs can be created at runtime.
RUN useradd -m -u 1000 appuser \
    && mkdir -p uploads outputs models ai/models /tmp/hf /tmp/mpl /tmp/ultralytics /tmp/easyocr \
    && chown -R appuser:appuser /app /tmp/hf /tmp/mpl /tmp/ultralytics /tmp/easyocr
USER appuser

EXPOSE 7860

CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-7860}"]
