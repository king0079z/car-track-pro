# syntax=docker/dockerfile:1
# Multi-arch: python:3.11-slim builds on amd64 and Oracle Ampere arm64.
FROM python:3.11-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# System deps for OpenCV headless + FFmpeg + OpenMP (Torch/ONNX).
RUN apt-get update && apt-get install -y --no-install-recommends \
        libglib2.0-0 \
        libgl1 \
        libgomp1 \
        ffmpeg \
        build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
# Layer 1 (heavy, cached until requirements.txt changes):
# - CPU-only PyTorch (~200 MB) — VPS has no GPU; easyocr otherwise pulls ~2 GB CUDA wheels.
# - BuildKit pip cache survives rebuilds when only app/ code changes.
RUN --mount=type=cache,target=/root/.cache/pip \
    sed -i 's/^opencv-python>=/opencv-python-headless>=/' requirements.txt \
    && pip install --upgrade pip \
    && pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu \
    && pip install -r requirements.txt

# Layer 2 (fast): only this layer rebuilds for routine Python fixes under app/.
COPY . .

RUN mkdir -p uploads ai/models outputs

EXPOSE 8000

CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
