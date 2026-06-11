#!/usr/bin/env bash
set -euo pipefail
docker cp /root/cameras.py cartrack_backend:/app/app/routers/cameras.py
docker cp /root/dahua_camera.py cartrack_backend:/app/app/services/dahua_camera.py
docker cp /root/main.py cartrack_backend:/app/app/main.py
docker cp /root/helpers.py cartrack_backend:/app/vendor/dh_p2p/helpers.py
docker cp /root/dahua_p2p_tunnel.py cartrack_backend:/app/app/services/dahua_p2p_tunnel.py
docker restart cartrack_backend
