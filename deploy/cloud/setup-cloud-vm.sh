#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# CarTrack CLOUD backend — one-shot installer for a fresh Ubuntu VM
# (Azure Qatar Central B1s, AWS EC2, or any Ubuntu 22.04/24.04 host).
#
# It installs Docker, opens the firewall, registers a free DuckDNS domain for
# automatic HTTPS, and brings up the CarTrack backend + Easy4IP P2P tunnel.
#
# Usage (run ON the VM, from the repo root after cloning):
#   cd "Car Tracking system/deploy/cloud"
#   cp .env.cloud.example .env.cloud   # then edit it (serial, password, vercel url)
#   sudo bash setup-cloud-vm.sh yourname.duckdns.org <DUCKDNS_TOKEN>
#
# DuckDNS is free: create a subdomain + token at https://www.duckdns.org
# (skip the token arg if you use your own DNS A-record pointing at this VM).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

DOMAIN="${1:-}"
DUCKDNS_TOKEN="${2:-}"

if [ -z "$DOMAIN" ]; then
  echo "ERROR: pass your domain, e.g.  sudo bash setup-cloud-vm.sh mycam.duckdns.org <token>"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "==> [1/6] Installing Docker + compose plugin"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
# compose v2 plugin
if ! docker compose version >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y docker-compose-plugin
fi

echo "==> [2/6] Opening firewall (ufw, if present)"
if command -v ufw >/dev/null 2>&1; then
  ufw allow 22/tcp   || true   # SSH
  ufw allow 80/tcp   || true   # HTTP (Let's Encrypt challenge)
  ufw allow 443/tcp  || true   # HTTPS (frontend ↔ backend)
fi

# DuckDNS dynamic-DNS update so the domain points at THIS VM's public IP.
if [ -n "$DUCKDNS_TOKEN" ]; then
  SUB="${DOMAIN%%.duckdns.org}"
  echo "==> [3/6] Pointing DuckDNS '$SUB' at this VM"
  PUBIP="$(curl -fsSL https://api.ipify.org || true)"
  curl -fsSL "https://www.duckdns.org/update?domains=${SUB}&token=${DUCKDNS_TOKEN}&ip=${PUBIP}" && echo
  # keep it fresh every 5 min in case the public IP changes
  ( crontab -l 2>/dev/null | grep -v duckdns.org; \
    echo "*/5 * * * * curl -fsSL 'https://www.duckdns.org/update?domains=${SUB}&token=${DUCKDNS_TOKEN}&ip=' >/dev/null 2>&1" ) | crontab -
else
  echo "==> [3/6] Skipping DuckDNS (no token). Make sure $DOMAIN already points at this VM."
fi

echo "==> [4/6] Preparing .env.cloud (auto-create + secrets)"
ENV_FILE="$SCRIPT_DIR/.env.cloud"
if [ ! -f "$ENV_FILE" ]; then
  echo "    .env.cloud not found — creating it from .env.cloud.example"
  cp "$SCRIPT_DIR/.env.cloud.example" "$ENV_FILE"
fi

# Auto-generate a strong SECRET_KEY if it's still the placeholder.
if grep -q '^SECRET_KEY=CHANGE_ME' "$ENV_FILE"; then
  NEW_SECRET="$(openssl rand -hex 32)"
  sed -i "s|^SECRET_KEY=.*|SECRET_KEY=${NEW_SECRET}|" "$ENV_FILE"
  echo "    Generated a new SECRET_KEY."
fi

# Prompt once for the camera password if still the placeholder.
if grep -q '^DAHUA_PASSWORD=CHANGE_ME' "$ENV_FILE"; then
  echo
  echo "    The camera (Dahua DH-H3A) password is required for the Easy4IP cloud tunnel."
  read -r -s -p "    Enter the camera 'admin' password: " CAM_PWD
  echo
  if [ -z "$CAM_PWD" ]; then
    echo "ERROR: password cannot be empty. Edit $ENV_FILE and set DAHUA_PASSWORD, then re-run."
    exit 1
  fi
  # Escape characters that are special to sed's replacement.
  ESC_PWD="$(printf '%s' "$CAM_PWD" | sed -e 's/[\/&|]/\\&/g')"
  sed -i "s|^DAHUA_PASSWORD=.*|DAHUA_PASSWORD=${ESC_PWD}|" "$ENV_FILE"
  echo "    Camera password saved to .env.cloud (git-ignored)."
fi

echo "    .env.cloud is ready."

# Persistent data dir (camera registry + databases survive container redeploys).
echo "==> Preparing persistent data dir ($SCRIPT_DIR/data)"
mkdir -p "$SCRIPT_DIR/data"
for f in cameras.json cartrack.db live_sessions.db analysis_history.db; do
  [ -e "$SCRIPT_DIR/data/$f" ] || : > "$SCRIPT_DIR/data/$f"
done

echo "==> [5/6] Building & starting CarTrack cloud backend (CADDY_DOMAIN=$DOMAIN)"
cd "$SCRIPT_DIR"
export CADDY_DOMAIN="$DOMAIN"
docker compose -f docker-compose.cloud.yml up -d --build

echo "==> [6/6] Waiting for HTTPS to come up (Let's Encrypt may take ~30-60s)…"
sleep 20
echo
echo "Done. Backend should be live at:  https://$DOMAIN/api/health"
echo
echo "Next:"
echo "  • In Azure/AWS, also open inbound 80 and 443 in the Network Security Group."
echo "  • On Vercel, set  VITE_API_URL = https://$DOMAIN  then redeploy the frontend."
echo "  • Check the Easy4IP tunnel:  docker compose -f docker-compose.cloud.yml logs -f backend"
