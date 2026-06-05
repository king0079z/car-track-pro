# CarTrack Pro

AI car tracking, ANPR, and Dahua camera integration.

## Quick start (local)

```cmd
deploy.cmd
```

- Backend: http://localhost:8001  
- Frontend: http://localhost:5173  

Copy `backend/cameras.json.example` → `backend/cameras.json` and add your camera settings.

## Cloud deploy (Vercel + API)

1. **GitHub** — this repo  
2. **Vercel** — frontend (`frontend/` or root `vercel.json`)  
3. **API HTTPS** — [Render Blueprint](render.yaml) or `scripts/deploy-all.ps1` (Cloudflare tunnel to local PC)

See [docs/DEPLOY-ALL.md](docs/DEPLOY-ALL.md) and [docs/VERCEL.md](docs/VERCEL.md).

### Vercel env (required)

```
VITE_API_URL=https://YOUR-HTTPS-API-HOST
```

### Render (optional API host)

Dashboard → **New Blueprint** → select this repo → `render.yaml`.
