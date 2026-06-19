#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# CarTrack — fast, data-safe deploy on the VPS (minimal user interruption).
#
# Usage (on VPS, from repo after code sync):
#   cd /opt/cartrack/deploy/cloud
#   export CADDY_DOMAIN=cartrackpro.duckdns.org
#   bash zero-downtime-deploy.sh frontend   # UI only (~3–5 min)
#   bash zero-downtime-deploy.sh backend    # API only (~2–15 min, pip cached)
#   bash zero-downtime-deploy.sh all        # both (slowest)
#
# DATA SAFETY: Never touches ./data (SQLite), uploads_data, outputs_data, or .env.cloud.
# Old containers keep serving until the new image is built and health-checked.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

TARGET="${1:-all}"
COMPOSE_FILE="docker-compose.oracle.yml"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

if [ -z "${CADDY_DOMAIN:-}" ]; then
  if [ -f .env.cloud ]; then
    CADDY_DOMAIN="$(grep -E '^CADDY_DOMAIN=' .env.cloud 2>/dev/null | cut -d= -f2- | tr -d "'\"" || true)"
  fi
fi
if [ -z "${CADDY_DOMAIN:-}" ]; then
  CADDY_DOMAIN="cartrackpro.duckdns.org"
fi
export CADDY_DOMAIN

echo "==> CarTrack deploy: target=$TARGET domain=$CADDY_DOMAIN"
echo "    Data preserved: $SCRIPT_DIR/data (SQLite + cameras + models)"
echo "    Live containers stay up until the replacement passes health checks."

_dc() { docker compose -f "$COMPOSE_FILE" "$@"; }

_patch_backend() {
  local app_src
  app_src="$(cd "$SCRIPT_DIR/../.." && pwd)/backend/app"
  if [ ! -d "$app_src" ]; then
    echo "ERROR: backend/app not found at $app_src (run deploy-fast.ps1 upload first)"
    exit 1
  fi
  echo "==> Hot-patch backend Python into running container (no pip, no image rebuild) ..."
  docker cp "$app_src/." cartrack_backend:/app/app/
  echo "==> Restarting backend (~15-30s for YOLO/OCR reload) ..."
  _dc restart backend
  _dc up -d --no-deps --wait backend
  echo "    Backend patched."
}

_roll() {
  local svc="$1"
  echo "==> Building $svc (old container still serving traffic) ..."
  _dc build "$svc"
  echo "==> Swapping $svc (brief cutover, ~5–20s) ..."
  _dc up -d --no-deps --wait "$svc"
  echo "    $svc healthy."
}

case "$TARGET" in
  frontend|web)
    _roll web
    ;;
  backend|api)
    _roll backend
    ;;
  patch-backend|patch|hotfix)
    _patch_backend
    ;;
  all|full)
    echo "==> Building images (services still running) ..."
    _dc build
    echo "==> Rolling backend first ..."
    _dc up -d --no-deps --wait backend
    echo "==> Rolling web ..."
    _dc up -d --no-deps --wait web
    ;;
  *)
    echo "Unknown target: $TARGET (use frontend|backend|patch-backend|all)"
    exit 1
    ;;
esac

echo ""
echo "Deploy complete. https://$CADDY_DOMAIN/api/health"
_dc ps
