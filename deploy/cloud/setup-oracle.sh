#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# CarTrack — ALL-IN-ONE installer for a fresh Oracle Cloud Ampere A1 (ARM64) VM
# (also works on any Ubuntu 22.04/24.04 x86 host).
#
# Brings up the WHOLE app on ONE server — React frontend + FastAPI backend +
# Easy4IP P2P camera tunnel + YOLO/OCR ANPR — behind Caddy with automatic HTTPS.
# No Vercel, no on-site PC.
#
# Usage (run ON the VM, from the repo after cloning):
#   cd "Car Tracking system/deploy/cloud"
#   sudo bash setup-oracle.sh yourname.duckdns.org <DUCKDNS_TOKEN>
#
# Before running, copy your YOLO/OCR weights to:  deploy/cloud/data/models/
#   (best.pt / yolo26_best.pt — they are git-ignored, so transfer them once.)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

DOMAIN="${1:-}"
DUCKDNS_TOKEN="${2:-}"

if [ -z "$DOMAIN" ]; then
  echo "ERROR: pass your domain, e.g.  sudo bash setup-oracle.sh mycam.duckdns.org <token>"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPOSE_FILE="docker-compose.oracle.yml"

echo "==> [1/7] Installing Docker + compose plugin"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
if ! docker compose version >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y docker-compose-plugin
fi

echo "==> [2/7] Opening firewall"
# Oracle Ubuntu images use iptables with a restrictive default; open 80/443.
if command -v ufw >/dev/null 2>&1; then
  ufw allow 22/tcp  || true
  ufw allow 80/tcp  || true
  ufw allow 443/tcp || true
fi
# Oracle's images also have netfilter-persistent iptables rules — add HTTP/HTTPS.
if command -v iptables >/dev/null 2>&1; then
  iptables -I INPUT -p tcp --dport 80  -j ACCEPT || true
  iptables -I INPUT -p tcp --dport 443 -j ACCEPT || true
  command -v netfilter-persistent >/dev/null 2>&1 && netfilter-persistent save || true
fi

if [ -n "$DUCKDNS_TOKEN" ]; then
  SUB="${DOMAIN%%.duckdns.org}"
  echo "==> [3/7] Pointing DuckDNS '$SUB' at this VM"
  PUBIP="$(curl -fsSL https://api.ipify.org || true)"
  curl -fsSL "https://www.duckdns.org/update?domains=${SUB}&token=${DUCKDNS_TOKEN}&ip=${PUBIP}" && echo
  ( crontab -l 2>/dev/null | grep -v duckdns.org; \
    echo "*/5 * * * * curl -fsSL 'https://www.duckdns.org/update?domains=${SUB}&token=${DUCKDNS_TOKEN}&ip=' >/dev/null 2>&1" ) | crontab -
else
  echo "==> [3/7] Skipping DuckDNS (no token). Ensure $DOMAIN already points at this VM."
fi

echo "==> [4/7] Preparing .env.cloud (secrets + same-origin CORS)"
ENV_FILE="$SCRIPT_DIR/.env.cloud"
if [ ! -f "$ENV_FILE" ]; then
  if [ -f "$SCRIPT_DIR/env.cartrackpro.template" ]; then
    cp "$SCRIPT_DIR/env.cartrackpro.template" "$ENV_FILE"
  else
    cp "$SCRIPT_DIR/.env.cloud.example" "$ENV_FILE"
  fi
fi

if grep -q '^SECRET_KEY=CHANGE_ME' "$ENV_FILE"; then
  sed -i "s|^SECRET_KEY=.*|SECRET_KEY=$(openssl rand -hex 32)|" "$ENV_FILE"
  echo "    Generated SECRET_KEY."
fi
# All-in-one is same-origin: CORS origin = our own HTTPS domain.
sed -i "s|^ALLOWED_ORIGINS=.*|ALLOWED_ORIGINS=https://${DOMAIN}|" "$ENV_FILE"

if grep -q '^DAHUA_PASSWORD=CHANGE_ME' "$ENV_FILE"; then
  echo
  read -r -s -p "    Enter the camera 'admin' password: " CAM_PWD; echo
  if [ -z "$CAM_PWD" ]; then
    echo "ERROR: password cannot be empty. Edit $ENV_FILE then re-run."; exit 1
  fi
  ESC_PWD="$(printf '%s' "$CAM_PWD" | sed -e 's/[\/&|]/\\&/g')"
  sed -i "s|^DAHUA_PASSWORD=.*|DAHUA_PASSWORD=${ESC_PWD}|" "$ENV_FILE"
  echo "    Camera password saved (git-ignored)."
fi

echo "==> [5/7] Preparing persistent data dir + checking model weights"
mkdir -p "$SCRIPT_DIR/data/models"
for f in cameras.json cartrack.db live_sessions.db analysis_history.db; do
  [ -e "$SCRIPT_DIR/data/$f" ] || : > "$SCRIPT_DIR/data/$f"
done
if ! ls "$SCRIPT_DIR"/data/models/*.pt >/dev/null 2>&1; then
  echo "    !! WARNING: no YOLO weights found in $SCRIPT_DIR/data/models/"
  echo "    !! Copy best.pt (or yolo26_best.pt) there, then re-run, or ANPR won't load."
fi

echo "==> [6/7] Building & starting the all-in-one stack (CADDY_DOMAIN=$DOMAIN)"
cd "$SCRIPT_DIR"
export CADDY_DOMAIN="$DOMAIN"
docker compose -f "$COMPOSE_FILE" up -d --build

echo "==> [7/7] Waiting for HTTPS (Let's Encrypt ~30-60s)…"
sleep 25
echo
echo "Done. Open:  https://$DOMAIN   (dashboard)"
echo "Health:      https://$DOMAIN/api/health"
echo "Logs:        docker compose -f $COMPOSE_FILE logs -f backend"
echo
echo "In the Oracle console, also add INGRESS rules for TCP 80 and 443 in the VCN"
echo "Security List (the cloud firewall), or the site will be unreachable."
