#!/usr/bin/env bash
# CarTrack Cloud Relay — install MediaMTX on a fresh Linux VPS (Ubuntu/Debian).
# Usage:  sudo bash setup-vps.sh
# After this runs, set the username/password in /opt/mediamtx/mediamtx.yml,
# then:  sudo systemctl restart mediamtx
set -euo pipefail

MTX_VERSION="v1.11.3"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64)  PKG="linux_amd64" ;;
  aarch64) PKG="linux_arm64v8" ;;
  *) echo "Unsupported arch: $ARCH" && exit 1 ;;
esac

echo "==> Installing MediaMTX ${MTX_VERSION} (${PKG})"
mkdir -p /opt/mediamtx
cd /opt/mediamtx
URL="https://github.com/bluenviron/mediamtx/releases/download/${MTX_VERSION}/mediamtx_${MTX_VERSION}_${PKG}.tar.gz"
curl -fsSL "$URL" -o mediamtx.tar.gz
tar -xzf mediamtx.tar.gz
rm -f mediamtx.tar.gz

# Drop in CarTrack config if not already present (copy mediamtx.yml next to this script first).
if [ -f "$(dirname "$0")/mediamtx.yml" ]; then
  cp "$(dirname "$0")/mediamtx.yml" /opt/mediamtx/mediamtx.yml
  echo "==> Installed CarTrack mediamtx.yml (EDIT the password inside it!)"
fi

echo "==> Creating systemd service"
cat >/etc/systemd/system/mediamtx.service <<'UNIT'
[Unit]
Description=MediaMTX (CarTrack Cloud Relay)
After=network.target

[Service]
ExecStart=/opt/mediamtx/mediamtx /opt/mediamtx/mediamtx.yml
Restart=always
RestartSec=3
User=root

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable mediamtx
systemctl restart mediamtx

echo "==> Opening firewall (ufw, if present)"
if command -v ufw >/dev/null 2>&1; then
  ufw allow 8554/tcp || true
  ufw allow 8000/udp || true
  ufw allow 8888/tcp || true
  ufw allow 8889/tcp || true
fi

echo
echo "Done. MediaMTX is running."
echo "1) Edit /opt/mediamtx/mediamtx.yml  -> set a strong 'pass:'"
echo "2) sudo systemctl restart mediamtx"
echo "3) ALSO open these ports in your cloud provider's security group / firewall:"
echo "     8554/tcp (RTSP), 8000/udp (RTSP-UDP), 8888/tcp (HLS), 8889/tcp (WebRTC)"
echo
echo "Publish/View URL for CarTrack:"
echo "   rtsp://cartrack:YOUR_PASS@<THIS_VPS_PUBLIC_IP>:8554/hero-a1"
