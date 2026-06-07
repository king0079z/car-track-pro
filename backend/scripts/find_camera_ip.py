"""Scan LAN and probe RTSP to find the Dahua Hero A1 IP from this PC."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.camera_config import load_camera_config
from app.services.dahua_camera import (
    build_rtsp_url,
    dahua_hero_a1_config,
    diagnose_connectivity,
    discover_hero_a1_candidates,
    probe_stream,
)


def main() -> int:
    cfg = load_camera_config()["dahua_hero_a1"]
    serial = str(cfg.get("device_serial") or "").strip()

    print("=== PC / network ===")
    diag = diagnose_connectivity(cfg)
    print("PC IPs:", ", ".join(diag["pc_ips"]) or "(none)")
    print("Saved host in cameras.json:", diag["camera_host"])
    print("Subnet mismatch:", diag["subnet_mismatch"])
    print()

    print("=== LAN scan (RTSP 554 / Dahua SDK 37777) ===")
    scan = discover_hero_a1_candidates(timeout_per_host=0.15, workers=64)
    print("Scanned subnets:", scan.get("scanned_subnets"))
    print("Hosts checked:", scan.get("hosts_checked"))
    cands = scan.get("candidates") or []
    if not cands:
        print("No Dahua-like devices found on this PC's network.")
    else:
        print("Candidates (best first):")
        for c in cands[:10]:
            print(
                f"  {c['host']:15}  RTSP={c.get('rtsp_port_open')}  "
                f"SDK={c.get('dahua_sdk_port_open')}  {c.get('confidence')}  {c.get('likely_model')}"
            )
    print()

    test_ips: list[str] = []
    for ip in [str(cfg.get("host") or ""), "192.168.1.138", "10.0.0.13"]:
        ip = ip.strip()
        if ip and ip not in test_ips:
            test_ips.append(ip)
    for c in cands[:3]:
        h = c.get("host")
        if h and h not in test_ips:
            test_ips.append(h)

    best_ip: str | None = None
    for test_ip in test_ips:
        print(f"=== RTSP video probe {test_ip} ===")
        try:
            url = build_rtsp_url(
                host=test_ip,
                username=str(cfg.get("username") or "admin"),
                password=str(cfg.get("password") or ""),
                stream=str(cfg.get("stream") or "sub"),
            )
            r = probe_stream(
                url,
                use_tcp=True,
                timeout_sec=12.0,
                username=str(cfg.get("username") or "admin"),
                password=str(cfg.get("password") or ""),
            )
        except Exception as exc:
            print("  ERROR:", exc)
            continue
        if r.get("ok"):
            w, h = r.get("width"), r.get("height")
            fps = r.get("fps")
            print(f"  OK - stream works ({w}x{h} @ {fps} fps)")
            best_ip = test_ip
        else:
            err = str(r.get("error") or "unknown")
            print("  FAIL:", err.encode("ascii", "replace").decode())
        print()

    print("=== Result ===")
    if best_ip:
        print(f"Camera IP for CarTrack (verified RTSP): {best_ip}")
        if serial:
            print(f"Serial: {serial}")
        return 0
    if cands:
        print(f"Likely camera IP (ports only, RTSP not verified): {cands[0]['host']}")
        print("Fix password in Settings if RTSP auth failed.")
        return 1
    print("No camera found. Connect this PC to the same Wi-Fi as the camera and run again.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
