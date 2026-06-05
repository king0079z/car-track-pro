#!/bin/bash
# ══════════════════════════════════════════════════════════════════════════════
# CarTrack Pro — Production Deployment Script (Linux/Ubuntu server)
# ══════════════════════════════════════════════════════════════════════════════
# Run once on the server:  chmod +x deploy.sh && ./deploy.sh
# ──────────────────────────────────────────────────────────────────────────────
set -e

echo "============================================"
echo " CarTrack Pro — Deployment"
echo "============================================"

# ── 1. Check Docker ─────────────────────────────────────────────────────────
if ! command -v docker &> /dev/null; then
  echo "Installing Docker..."
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker $USER
  echo "Docker installed. Please log out and back in, then re-run this script."
  exit 1
fi

if ! command -v docker compose &> /dev/null; then
  echo "ERROR: docker compose plugin not found. Install Docker Engine 24+ which includes it."
  exit 1
fi

echo "Docker: $(docker --version)"

# ── 2. Check .env.production ─────────────────────────────────────────────────
if [ ! -f ".env.production" ]; then
  echo ""
  echo "ERROR: .env.production not found."
  echo "Run:  cp .env.production.example .env.production"
  echo "Then fill in SECRET_KEY, DB_PASSWORD, and ALLOWED_ORIGINS"
  exit 1
fi

# Verify SECRET_KEY is not the placeholder
if grep -q "<CHANGE THIS" .env.production; then
  echo "ERROR: .env.production still has placeholder values. Please fill them in."
  exit 1
fi

echo ".env.production: OK"

# ── 3. Create required directories ──────────────────────────────────────────
mkdir -p uploads ai/models
echo "Directories: OK"

# ── 4. Build and start ───────────────────────────────────────────────────────
echo ""
echo "Building and starting containers..."
docker compose --env-file .env.production up -d --build

# ── 5. Wait for health ──────────────────────────────────────────────────────
echo ""
echo "Waiting for services to be healthy..."
sleep 15

MAX_RETRIES=60
COUNT=0
echo "Waiting for /api/ready (OCR + YOLO loaded by backend lifespan)..."
until curl -sf http://localhost/api/ready > /dev/null 2>&1 || [ $COUNT -ge $MAX_RETRIES ]; do
  echo "  Waiting... ($COUNT/$MAX_RETRIES)"
  sleep 3
  COUNT=$((COUNT+1))
done

if curl -sf http://localhost/api/ready > /dev/null 2>&1; then
  echo ""
  echo "============================================"
  echo " CarTrack Pro is LIVE"
  echo " Open:  http://$(hostname -I | awk '{print $1}')"
  echo " Login: admin / demo1234  (change after first login!)"
  echo "============================================"
else
  echo "WARNING: /api/ready did not succeed after ${MAX_RETRIES} retries (OCR + YOLO may still be loading)."
  echo "Check logs:  docker compose logs backend"
fi
