"""Quick Dahua Hero test — LAN + P2P."""
from app.services.dahua_camera import build_rtsp_url, parse_dahua_qr_payload, probe_stream
from app.services.dahua_p2p_tunnel import _fetch_device_randsalt, get_p2p_tunnel_manager

SERIAL = "BF0E4C7GAGB833C"
PWD = "a5013463"
USER = "admin"
HOST = "192.168.1.132"
QR = "{SN:BF0E4C7GAGB833C,DT:DH-H3A,SC:L219E7D3}"


def main() -> None:
    qr = parse_dahua_qr_payload(QR)
    print("QR serial:", qr["parsed"]["serial_number"], "model:", qr["parsed"]["device_type"])
    print("QR security code (NOT password):", qr["parsed"]["security_code"])

    salt = _fetch_device_randsalt(SERIAL)
    print("RandSalt OK:", bool(salt), salt or "none")

    print("\n--- LAN RTSP", HOST, "---")
    url = build_rtsp_url(host=HOST, username=USER, password=PWD, stream="sub")
    lan = probe_stream(url, username=USER, password=PWD, timeout_sec=12)
    print("LAN ok:", lan.get("ok"), lan.get("error") or f"{lan.get('width')}x{lan.get('height')}")

    print("\n--- Cloud P2P ---")
    m = get_p2p_tunnel_manager()
    m.stop()
    p2p = m.ensure_running(serial=SERIAL, username=USER, password=PWD, local_port=18562)
    print("P2P ok:", p2p.get("ok"))
    err = (p2p.get("error") or "")[:240]
    print("P2P error:", err.encode("ascii", errors="replace").decode())
    detail = p2p.get("detail") or ""
    if "DevPwd_InvalidSalt" in detail:
        print("Cloud auth: DevPwd_InvalidSalt (wrong device password for cloud)")
    if p2p.get("ok"):
        url2 = build_rtsp_url(host="127.0.0.1", username=USER, password=PWD, rtsp_port=18562, stream="sub")
        tun = probe_stream(url2, username=USER, password=PWD, timeout_sec=25)
        print("Tunnel RTSP ok:", tun.get("ok"), tun.get("error") or f"{tun.get('width')}x{tun.get('height')}")
        print("status:", m.status())
    m.stop()


if __name__ == "__main__":
    main()
