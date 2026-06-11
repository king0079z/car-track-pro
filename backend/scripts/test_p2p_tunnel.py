"""Quick P2P tunnel diagnostic."""
import json
import time

from app.services.camera_config import load_camera_config
from app.services.dahua_p2p_tunnel import get_p2p_tunnel_manager

cfg = load_camera_config()["dahua_hero_a1"]
mgr = get_p2p_tunnel_manager()
print("Starting P2P for", cfg.get("device_serial"))
res = mgr.ensure_running(
    serial=str(cfg["device_serial"]),
    username=str(cfg.get("username") or "admin"),
    password=str(cfg["password"]),
    local_port=int(cfg.get("p2p_local_port") or 18554),
)
print("ensure_running:", json.dumps(res, indent=2)[:2500])
for i in range(16):
    st = mgr.status()
    phase = st.get("phase")
    running = st.get("running")
    err = (st.get("last_error") or "")[:160]
    print(f"t+{i * 15:3d}s phase={phase!r} running={running} err={err!r}")
    if running:
        print("SUCCESS")
        break
    if phase == "failed":
        print("FAILED tail:", (st.get("log_tail") or "")[-500:])
        break
    time.sleep(15)
