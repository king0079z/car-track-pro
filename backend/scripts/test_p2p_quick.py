"""Quick cloud P2P test after auth fix."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.dahua_camera import build_rtsp_url, dahua_hero_a1_config, probe_stream
from app.services.dahua_p2p_tunnel import get_p2p_tunnel_manager


def main() -> None:
    cfg = dahua_hero_a1_config()
    serial = str(cfg.get("device_serial") or "").strip().upper()
    pwd = str(cfg.get("password") or "")
    user = str(cfg.get("username") or "admin")
    port = int(cfg.get("p2p_local_port") or 18554)
    if not serial or not pwd:
        print("Configure device_serial and password in backend/cameras.json first.")
        sys.exit(1)

    m = get_p2p_tunnel_manager()
    m.stop()
    p2p = m.ensure_running(serial=serial, username=user, password=pwd, local_port=port)
    print("P2P ok:", p2p.get("ok"), "dtype:", p2p.get("dtype"))
    if not p2p.get("ok"):
        print("error:", (p2p.get("error") or "")[:300])
        detail = p2p.get("detail") or ""
        print("InvalidSalt:", "DevPwd_InvalidSalt" in detail)
        return
    url = build_rtsp_url(host="127.0.0.1", username=user, password=pwd, rtsp_port=port, stream="sub")
    tun = probe_stream(url, username=user, password=pwd, timeout_sec=35)
    print("Tunnel RTSP:", tun.get("ok"), tun.get("error") or f"{tun.get('width')}x{tun.get('height')}")
    m.stop()


if __name__ == "__main__":
    main()
