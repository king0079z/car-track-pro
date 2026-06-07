# CarTrack — Cloud Backend (DMSS-style, no on-site PC)

This package runs the CarTrack **backend + Dahua Easy4IP P2P client** on a cloud VM,
behind Caddy for automatic HTTPS. The camera streams to Dahua's cloud (exactly like
DMSS); this backend pulls that stream from Dahua's cloud and serves it to your Vercel
frontend.

```text
[DH-H3A] --Easy4IP P2P--> [Dahua cloud] --P2P pull--> [this VM: backend + ANPR]
                                                          | HTTPS / WSS (Caddy)
                                                          v
                                                  [Vercel frontend]
```

## Why a VM (and not Vercel/Render free)
- The P2P handshake needs **open outbound UDP** — datacenter VMs allow it, your home
  router did not (that was the PTCP timeout).
- Vercel is frontend-only; it cannot run P2P/RTSP/OpenCV/YOLO or long-lived WebSockets.

## Files
| File | Purpose |
|------|---------|
| `docker-compose.cloud.yml` | Backend + Caddy (auto-HTTPS) |
| `Caddyfile` | HTTPS reverse proxy → `backend:8000` (REST + WebSocket) |
| `.env.cloud.example` | Copy to `.env.cloud`, fill serial/password/Vercel URL |
| `setup-cloud-vm.sh` | One-shot installer (Docker, firewall, DuckDNS, compose up) |

## Deploy steps (Azure — B2s for ANPR)

> The full copy-paste version is in **`QUICKSTART.txt`** next to this file.

1. **Create the VM** — Azure Portal → Create → Virtual Machine
   - Image: **Ubuntu Server 24.04 LTS**, Size: **B2s (2 vCPU / 4 GB)** for live ANPR
   - Allow inbound ports: **SSH (22), HTTP (80), HTTPS (443)**
2. **Free domain** — at https://www.duckdns.org create a subdomain (e.g. `mycam`) and copy the token.
3. **SSH in** and get the code:
   ```bash
   sudo apt-get update && sudo apt-get install -y git
   git clone <YOUR_REPO_URL> && cd "Car Tracking system/deploy/cloud"
   ```
4. **Run the installer** (it auto-creates `.env.cloud`, generates `SECRET_KEY`,
   and asks once for the camera password):
   ```bash
   sudo bash setup-cloud-vm.sh mycam.duckdns.org <DUCKDNS_TOKEN>
   ```
   No manual editing needed — serial, device type, and your Vercel URL are
   already baked into `.env.cloud.example`.
5. **Verify**: open `https://mycam.duckdns.org/api/health` → should return OK.
   Watch the Easy4IP tunnel reach `Ready to connect`:
   ```bash
   docker compose -f docker-compose.cloud.yml logs -f backend
   ```
6. **Point the frontend at it** — on Vercel → Project → Settings → Environment Variables:
   - `VITE_API_URL = https://mycam.duckdns.org`
   - Redeploy. Open the live feed page; the camera now streams via the cloud from anywhere.

## Multiple cameras (Dahua cloud + RTSP/NVR)
Add many cameras from the app: Settings -> **Cameras** -> Add camera.
- **Dahua cloud**: serial + device password (one Easy4IP tunnel per camera, each on
  its own localhost port 18554, 18555, ...). Works from the VM because outbound UDP
  is open in the datacenter.
- **RTSP / NVR**: paste an `rtsp://` URL (or LAN IP + credentials).

Each camera auto-joins the live ANPR camera wall and is restarted by the 24/7
supervisor. Cameras persist in `deploy/cloud/data/cameras.json` (bind-mounted), so
they survive container redeploys. Raise the slot cap with `LIVE_MAX_CAMERAS`
(default 16).

## Sizing
- **B2s (2 vCPU/4 GB)** handles a couple of live ANPR feeds. The free **B1s
  (1 vCPU/1 GB)** can only *view* a feed.
- Real-time ANPR on **many cameras (toward 16) is GPU-class work**. For that, use an
  Azure **GPU VM (NC-series)** and set `USE_GPU=true` in `.env.cloud`, or keep CPU and
  run fewer/staggered feeds at reduced FPS (the camera wall already uses a lighter
  pipeline). Resize the VM anytime in the Azure portal.
- AWS EC2 (Bahrain) works the same — use Ubuntu, open 22/80/443 in the Security Group.
- Keep `.env.cloud` private; it is git-ignored.
