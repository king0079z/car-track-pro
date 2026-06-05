# CarTrack Cloud Video (instead of Dahua Easy4IP)

CarTrack does **not** ship a hosted video cloud like DMSS. You can use **your own server** as “CarTrack cloud” and stop depending on Dahua’s P2P/STUN.

## How it works

```text
[DH-H3A camera] --Wi-Fi LAN RTSP--> [PC at site running CarTrack]
                                          |
                                    ffmpeg relay
                                          v
                              [Your VPS — MediaMTX]
                                          |
                              [CarTrack on VPS or browser]
```

1. Camera stays on **LAN** (`192.168.x.x`) — reliable.
2. **Site PC** (same Wi-Fi) runs **CarTrack Cloud Relay** → pushes RTSP to your VPS.
3. **Remote** CarTrack uses the **View URL** to read from your VPS (not from Dahua cloud).

The camera firmware **cannot** push directly to CarTrack; a small PC on site is required (same as any NVR gateway).

## 1. Install MediaMTX on a VPS

Example (Linux):

```bash
wget https://github.com/bluenviron/mediamtx/releases/latest/download/mediamtx_v1.9.0_linux_amd64.tar.gz
tar -xzf mediamtx_v1.9.0_linux_amd64.tar.gz
./mediamtx
```

Open firewall **TCP/UDP 8554** (RTSP) on the VPS.

Default path for publishing: `rtsp://YOUR_VPS_IP:8554/hero-a1`

## 2. Configure CarTrack (site PC)

**Settings → Dahua camera**

| Field | Example |
|--------|---------|
| Connection | **CarTrack Cloud Relay** |
| Camera IP | `192.168.1.178` (from DMSS) |
| Publish URL | `rtsp://YOUR_VPS:8554/hero-a1` |
| View URL | `rtsp://YOUR_VPS:8554/hero-a1` |
| Username / password | `admin` + device password |

Click **Save camera**, then **Start CarTrack relay**.

## 3. Remote CarTrack

Deploy CarTrack on the **same VPS** (or any machine that can reach the View URL). Set connection mode to **CarTrack Cloud Relay** with the same View URL, or use live source `dahua-hero-a1` after relay is running on the site PC.

Optional `.env` on the server:

```env
CARTRACK_RELAY_PUBLISH_URL=rtsp://your-vps:8554/hero-a1
CARTRACK_RELAY_VIEW_URL=rtsp://your-vps:8554/hero-a1
```

## 4. Test

On the **site PC**:

```powershell
cd backend\scripts
.\configure-dahua-cloud.ps1   # optional UDP firewall for Dahua P2P
```

In Settings: **Test RTSP** should work on LAN first, then start relay.

On the **VPS**, verify with VLC: `rtsp://admin:PASSWORD@YOUR_VPS:8554/hero-a1`

## Compare modes

| Mode | Cloud owner | Best for |
|------|-------------|----------|
| Same Wi-Fi (LAN) | None (local only) | On-site ANPR |
| Auto / Dahua P2P | Dahua Easy4IP | Often blocked on home networks |
| **CarTrack Cloud Relay** | **You** (VPS) | Remote viewing + your CarTrack server |

## Security

- Use strong VPS firewall (allow only your IPs to RTSP if possible).
- Use TLS/VPN in production; RTSP is not encrypted by default.
- Do not expose admin camera password in public URLs without a reverse proxy.
