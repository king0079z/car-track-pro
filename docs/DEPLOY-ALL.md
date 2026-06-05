# Deploy everything — Vercel + HTTPS API + cameras

Project: [Vercel dashboard](https://vercel.com/mohammed0089-9773s-projects)

## One script (Windows)

```powershell
cd "C:\Users\Mohamed\Desktop\Car Tracking system"
.\scripts\deploy-all.ps1
```

Pick:

| Option | Best for |
|--------|----------|
| **1 — Cloudflare Tunnel** | Backend on your PC + Dahua on LAN (recommended) |
| **2 — Render** | API always online in cloud (cameras need relay from home) |
| **3 — Your URL** | You already host the API |

## A. Recommended: Vercel UI + PC backend + Cloudflare HTTPS

1. **Start CarTrack locally:** `deploy.cmd` (API `:8001`, UI `:5173`).
2. **Run:** `.\scripts\deploy-all.ps1` → choose **1**.
3. Copy tunnel URL → set **Vercel** env `VITE_API_URL=https://….trycloudflare.com`.
4. **Redeploy** Vercel (Deployments → Redeploy).
5. **Camera:** Settings → **Auto** or **LAN** — backend on your PC reaches `192.168.1.178`.

Keep `deploy.cmd` and cloudflared running while using the public Vercel link.

## B. Vercel frontend only

| Step | Action |
|------|--------|
| 1 | Vercel → Import repo → **Root Directory:** `frontend` (or use root `vercel.json`) |
| 2 | Env: `VITE_API_URL=https://YOUR-HTTPS-API` |
| 3 | Deploy |

Files: `frontend/vercel.json`, `frontend/.env.vercel.example`

## C. Render backend (optional)

1. Push repo to GitHub.
2. [Render](https://render.com) → **New Blueprint** → select repo (`render.yaml`).
3. Service URL: `https://cartrack-api.onrender.com` (name may vary).
4. Render → **Environment** → `ALLOWED_ORIGINS` = your `https://….vercel.app` URL.
5. Vercel → `VITE_API_URL` = Render URL.

**Note:** Render cannot reach a private camera IP. Use **CarTrack Cloud Relay** from a home PC (see [cartrack-cloud-video.md](./cartrack-cloud-video.md)).

## D. Checklist

- [ ] `VITE_API_URL` is **HTTPS** (not `http://localhost:8001`)
- [ ] Backend `ALLOWED_ORIGINS` includes your Vercel URL (or `*.vercel.app` regex is enabled)
- [ ] `https://YOUR-API/api/health` works in browser
- [ ] Vercel app has no orange “set VITE_API_URL” banner
- [ ] Camera: LAN IP on PC backend, or relay for remote cloud API

## Files added

| File | Purpose |
|------|---------|
| `vercel.json` | Build frontend from repo root |
| `frontend/vercel.json` | Build when root = `frontend` |
| `render.yaml` | Hosted API blueprint |
| `scripts/deploy-all.ps1` | Interactive wiring |
| `scripts/cloudflare-tunnel.ps1` | Free HTTPS to local API |
| `docs/VERCEL.md` | Vercel details |
