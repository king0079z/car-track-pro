# Deploy CarTrack UI on [Vercel](https://vercel.com)

Your project: [mohammed0089-9773s-projects](https://vercel.com/mohammed0089-9773s-projects)

## What Vercel can and cannot do

| Runs on Vercel | Does **not** run on Vercel |
|----------------|----------------------------|
| React dashboard (HTTPS) | FastAPI backend |
| Static files | YOLO / OpenCV / live RTSP |
| | Dahua P2P tunnel |
| | USB webcams |
| | CarTrack Cloud Relay (ffmpeg ingest) |

The **Vercel URL is only the web app**. Camera video and cloud relay still need a **backend server** (VPS, Render, Railway, Fly.io, or your home PC with a tunnel like ngrok/Cloudflare).

## 1. Deploy the frontend on Vercel

1. In Vercel: **Add Project** → import your Git repo.
2. Set **Root Directory** to `frontend`.
3. Framework: **Vite** (or use `frontend/vercel.json`).
4. Build: `npm run build` — Output: `dist`.

## 2. Point the UI to your HTTPS backend

Vercel → **Settings → Environment Variables**:

| Name | Value |
|------|--------|
| `VITE_API_URL` | `https://YOUR-BACKEND.example.com` (no trailing slash) |

Redeploy after saving.

Copy from `frontend/.env.vercel.example`.

## 3. Backend CORS (required)

On the machine running FastAPI, set in `.env`:

```env
ALLOWED_ORIGINS=https://your-app.vercel.app,https://your-app-git-main-mohammed0089-9773s-projects.vercel.app
```

Use the exact hostnames from Vercel → **Deployments → Visit** (copy the `https://…vercel.app` URL).

Restart the backend after changing CORS.

## 4. Backend must use HTTPS

The Vercel site is **HTTPS**. The browser will block `http://` API calls (mixed content).

- Put the API behind HTTPS (nginx + Let’s Encrypt, Render/Railway default URL, Cloudflare Tunnel, etc.).
- WebSocket will use **wss://** automatically when `VITE_API_URL` is `https://`.

## 5. Cloud / camera on Vercel deployment

| Feature | With Vercel UI only |
|---------|---------------------|
| **Same Wi‑Fi (LAN)** | Works only if the **backend** is on the same network as the camera (site PC or LAN server). |
| **Dahua Easy4IP P2P** | Runs on **backend host**, not Vercel. |
| **CarTrack Cloud Relay** | Publish from **site PC** → MediaMTX on **VPS**; View URL is your **media server**, not `*.vercel.app`. |

Do **not** set CarTrack relay Publish/View URL to your Vercel link — Vercel cannot receive RTSP streams.

Recommended remote setup:

1. **Vercel** — dashboard for users.
2. **VPS** — FastAPI + PostgreSQL (or SQLite for tests) + optional MediaMTX for relay.
3. **Site PC** — CarTrack relay pushes camera LAN RTSP → VPS MediaMTX.

See [cartrack-cloud-video.md](./cartrack-cloud-video.md).

## 6. Quick backend options (HTTPS)

- **Render** / **Railway** — deploy `backend/` Docker image; use provided `https://…` URL as `VITE_API_URL`.
- **Same PC + Cloudflare Tunnel** — `cloudflared tunnel` to local `:8001` for dev/demo.
- **docker-compose** on a VPS — see `.env.production.example`.

## 7. Verify

1. Open your Vercel URL → login page loads.
2. Browser DevTools → Network: requests go to `https://YOUR-BACKEND/api/…` (not `localhost:8001`).
3. `GET https://YOUR-BACKEND/api/health` returns OK.
4. WebSocket connects to `wss://YOUR-BACKEND/ws` (no errors in console).

## Vercel project settings checklist

- [ ] Root directory: `frontend`
- [ ] `VITE_API_URL` = HTTPS backend
- [ ] Backend `ALLOWED_ORIGINS` includes your `*.vercel.app` URL
- [ ] Backend deployed and reachable from the internet
- [ ] Camera settings still use LAN IP / relay on the **backend** side, not Vercel URL
