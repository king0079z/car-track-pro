"""
End-to-end test for the Imou/Easy4IP Open Platform cloud-HLS path.

Validates: accessToken -> deviceBaseDetailList (online?) -> bindDeviceLive ->
getLiveStreamInfo -> HLS URL, then (optionally) probes the HLS with ffprobe.

Usage (env or flags):
  set IMOU_APP_ID=...        (or --app-id)
  set IMOU_APP_SECRET=...    (or --app-secret)
  set IMOU_BASE_URL=https://openapi-sg.easy4ip.com   (or --base-url; pick your data center)
  python scripts/test_easy4ip_openapi.py --serial <DEVICE_SERIAL> [--channel 0] [--hd] [--probe]

Region base URLs (console - Basic Information - My Information):
  East Asia       https://openapi-sg.easy4ip.com
  Central Europe  https://openapi-fk.easy4ip.com
  Western America https://openapi-or.easy4ip.com
  Mainland China  https://openapi.lechange.cn
"""

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

# Allow importing the backend client.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from app.services.easy4ip_openapi import Easy4IpError, Easy4IpOpenAPI  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--app-id", default=os.environ.get("IMOU_APP_ID"))
    ap.add_argument("--app-secret", default=os.environ.get("IMOU_APP_SECRET"))
    ap.add_argument("--base-url", default=os.environ.get("IMOU_BASE_URL") or "https://openapi-sg.easy4ip.com")
    ap.add_argument("--serial", required=True, help="device serial number")
    ap.add_argument("--channel", default="0")
    ap.add_argument("--hd", action="store_true", help="prefer HD main stream (default SD sub)")
    ap.add_argument("--probe", action="store_true", help="ffprobe the HLS URL")
    args = ap.parse_args()

    if not args.app_id or not args.app_secret:
        print("ERROR: provide --app-id/--app-secret or IMOU_APP_ID/IMOU_APP_SECRET", file=sys.stderr)
        return 2

    client = Easy4IpOpenAPI(args.app_id, args.app_secret, args.base_url)

    print(f"[1] accessToken @ {args.base_url} ...")
    try:
        tok = client.access_token()
        print(f"    OK token={tok[:12]}…")
    except Easy4IpError as e:
        print(f"    FAILED: {e}  (code={e.code})")
        return 1

    print(f"[2] device detail / online status for {args.serial} ch{args.channel} ...")
    try:
        detail = client.device_detail(args.serial, args.channel)
        print("    " + json.dumps(detail, ensure_ascii=False)[:600])
    except Easy4IpError as e:
        print(f"    (device_detail failed: {e})")

    print("[3] bindDeviceLive ...")
    try:
        print("    " + json.dumps(client.bind_device_live(args.serial, args.channel), ensure_ascii=False)[:300])
    except Easy4IpError as e:
        print(f"    (bindDeviceLive: {e})  [may already exist; continuing]")

    print("[4] getLiveStreamInfo ...")
    try:
        streams = client.get_live_stream_info(args.serial, args.channel)
        print("    " + json.dumps(streams, ensure_ascii=False)[:800])
    except Easy4IpError as e:
        print(f"    FAILED: {e}  (code={e.code})")
        return 1

    url = client.live_hls_url(args.serial, args.channel, prefer_hd=args.hd)
    print(f"\n==> HLS URL: {url}")
    if not url:
        return 1

    if args.probe:
        print("\n[5] ffprobe ...")
        try:
            out = subprocess.run(
                ["ffprobe", "-v", "error", "-show_streams", "-of", "json", url],
                capture_output=True, text=True, timeout=40,
            )
            print(out.stdout[:1200] or out.stderr[:1200])
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            print(f"    ffprobe unavailable/timeout: {e}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
