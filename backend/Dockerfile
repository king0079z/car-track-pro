# Multi-arch base: python:3.11-slim ships both linux/amd64 and linux/arm64,
# so the same Dockerfile builds on a normal cloud VM and on Oracle Cloud's free
# Ampere A1 (ARM64) — no changes needed per architecture.
FROM python:3.11-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

# System deps for OpenCV (headless) + video decode (RTSP/MP4) + OpenMP runtime
# used by Torch/ONNX. Package names are valid on Debian 12 "bookworm" (the slim
# base) AND available on both amd64 and arm64. build-essential lets pure-source
# wheels (e.g. lap for BoT-SORT) compile if no prebuilt arm64 wheel exists.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libglib2.0-0 \
        libgl1 \
        libgomp1 \
        ffmpeg \
        build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
# Containers run headless (no display), so swap the desktop OpenCV build for the
# headless one: smaller, needs no X11/GL libraries, identical cv2 API. Keeps the
# local (Windows/USB-webcam) requirements untouched.
RUN sed -i 's/^opencv-python>=/opencv-python-headless>=/' requirements.txt \
    && pip install --upgrade pip \
    && pip install -r requirements.txt

COPY . .

RUN mkdir -p uploads ai/models outputs

EXPOSE 8000

CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
