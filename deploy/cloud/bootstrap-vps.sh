#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# CarTrack — one-shot VPS bootstrap (Hetzner / any Ubuntu 22.04/24.04).
#
# Run ON the VPS (or via scripts/deploy-to-hetzner.ps1 from your PC):
#   sudo bash bootstrap-vps.sh cartrackpro.duckdns.org <DUCKDNS_TOKEN> [camera_password]
#
# Does: git clone → place best.pt → .env.cloud → setup-oracle.sh (Docker + HTTPS + P2P)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

DOMAIN="${1:-}"
DUCKDNS_TOKEN="${2:-}"
CAM_PWD="${3:-}"
REPO_URL="${CARTRACK_REPO_URL:-https://github.com/king0079z/car-track-pro.git}"
INSTALL_DIR="${CARTRACK_INSTALL_DIR:-/opt/cartrack}"

if [ -z "$DOMAIN" ] || [ -z "$DUCKDNS_TOKEN" ]; then
  echo "Usage: sudo bash bootstrap-vps.sh <domain> <duckdns_token> [camera_admin_password]"
  echo "Example: sudo bash bootstrap-vps.sh cartrackpro.duckdns.org hf_xxx MyCamPass123"
  exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo bash bootstrap-vps.sh ..."
  exit 1
fi

echo "==> [1/4] Installing git (if needed)"
apt-get update -y
apt-get install -y git curl

echo "==> [2/4] Cloning CarTrack from $REPO_URL"
mkdir -p "$(dirname "$INSTALL_DIR")"
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "    Repo exists — pulling latest"
  git -C "$INSTALL_DIR" pull --ff-only || true
else
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

CLOUD_DIR="$INSTALL_DIR/deploy/cloud"
if [ ! -f "$CLOUD_DIR/setup-oracle.sh" ]; then
  echo "ERROR: $CLOUD_DIR/setup-oracle.sh not found. Check CARTRACK_REPO_URL."
  exit 1
fi

echo "==> [3/4] Placing model weights + .env.cloud"
mkdir -p "$CLOUD_DIR/data/models"
for f in cameras.json cartrack.db live_sessions.db analysis_history.db; do
  [ -e "$CLOUD_DIR/data/$f" ] || : > "$CLOUD_DIR/data/$f"
done

if [ -f /root/best.pt ]; then
  cp -f /root/best.pt "$CLOUD_DIR/data/models/best.pt"
  echo "    Installed /root/best.pt → data/models/best.pt"
elif [ ! -f "$CLOUD_DIR/data/models/best.pt" ] && [ ! -f "$CLOUD_DIR/data/models/"*.pt ]; then
  echo "    !! WARNING: no YOLO weights in data/models/ — ANPR will not load."
  echo "    !! From your PC: scp backend/models/best.pt root@<vps>:/root/best.pt then re-run."
fi

ENV_FILE="$CLOUD_DIR/.env.cloud"
if [ -f /root/env.cartrackpro.template ]; then
  cp -f /root/env.cartrackpro.template "$ENV_FILE"
  echo "    Using /root/env.cartrackpro.template"
elif [ -f "$CLOUD_DIR/env.cartrackpro.template" ]; then
  cp -f "$CLOUD_DIR/env.cartrackpro.template" "$ENV_FILE"
  echo "    Using env.cartrackpro.template from repo"
else
  cp -f "$CLOUD_DIR/.env.cloud.example" "$ENV_FILE"
fi

if [ -n "$CAM_PWD" ]; then
  ESC_PWD="$(printf '%s' "$CAM_PWD" | sed -e 's/[\/&|]/\\&/g')"
  sed -i "s|^DAHUA_PASSWORD=.*|DAHUA_PASSWORD=${ESC_PWD}|" "$ENV_FILE"
  echo "    Camera password set from argument."
fi

echo "==> [4/4] Running setup-oracle.sh (Docker, DuckDNS, HTTPS, P2P tunnel)"
cd "$CLOUD_DIR"
export CADDY_DOMAIN="$DOMAIN"
bash setup-oracle.sh "$DOMAIN" "$DUCKDNS_TOKEN"

echo
echo "══════════════════════════════════════════════════════════════"
echo " Done. Open:  https://$DOMAIN"
echo " Login:       admin / demo1234"
echo " Health:      https://$DOMAIN/api/health"
echo " Logs:        cd $CLOUD_DIR && docker compose -f docker-compose.oracle.yml logs -f backend"
echo "══════════════════════════════════════════════════════════════"
