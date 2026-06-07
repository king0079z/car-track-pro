# Deploy CarTrack to Hugging Face (free)

One HTTPS URL, no card required. Two modes from the same image:

- **Upload-a-video → detect / track / read Qatar plates** — works immediately.
- **Live 24/7 ANPR** — the image runs the supervisor and auto-(re)starts cameras
  on boot. It works on free HF **if** you provide the three things in *Step 7*.

> ⚠️ **What free HF can and cannot do for live ANPR.** A Space cannot reach a LAN
> camera or the Dahua Easy4IP **P2P (UDP)** tunnel, and free Spaces **sleep** when
> idle and have **no persistent disk**. So "24/7 on free HF" means:
> 1. the camera is exposed to the internet via a **relay** (an on-site device
>    pushes it to a tiny VPS running MediaMTX — see `deploy/relay/`) or a public
>    RTSP-over-TCP URL → `LIVE_RTSP_URL`;
> 2. data is stored in an **external Postgres** → `DATABASE_URL`;
> 3. an **uptime pinger** hits `/api/ready` so the Space never sleeps.
>
> If you can't expose the camera (P2P-only, behind NAT), deploy `deploy/cloud/`
> on an Oracle A1 always-free VM instead — same code, no relay needed.

---

## Step 1 — Create a Hugging Face account
1. Go to <https://huggingface.co/join> and sign up (email only, no card).
2. Verify your email.

## Step 2 — Create a Docker Space
1. <https://huggingface.co/new-space>
2. **Owner**: you · **Space name**: `cartrack` (your full id becomes `you/cartrack`)
3. **License**: any (e.g. MIT) · **SDK**: choose **Docker** → **Blank**
4. **Hardware**: `CPU basic · 2 vCPU · 16 GB` (free) · **Visibility**: Private or Public
5. Click **Create Space**. (It starts empty — we push the app next.)

## Step 3 — Get a write token
1. <https://huggingface.co/settings/tokens> → **New token** → **Write** scope.
2. Copy it (looks like `hf_xxxxxxxx`). Keep it private.

## Step 4 — Install Git + Git LFS (one time, on this PC)
```powershell
winget install Git.Git
winget install GitHub.GitLFS    # or: git lfs install
git lfs install
```
(Restart the terminal after install so `git`/`git lfs` are on PATH.)

## Step 5 — Push the app (one command)
From the project root in PowerShell:
```powershell
cd "C:\Users\Mohamed\Desktop\Car Tracking system\deploy\huggingface"
./push-to-space.ps1 -SpaceId "yourname/cartrack" -HfToken "hf_xxxxxxxx"
```
The script packages `frontend/` + `backend/` + the YOLO weights, drops in the
HF `Dockerfile`/`README.md`, and pushes. Hugging Face then **builds the image
automatically** (first build ~5–10 min — Torch/OCR wheels are large).

## Step 6 — Open it
- **Build logs:** `https://huggingface.co/spaces/yourname/cartrack`
- **App:** `https://yourname-cartrack.hf.space`
- **Login:** `admin` / `demo1234`

Go to **VisionFlow / ANPR**, **upload a video**, and watch it detect and read
plates. (Qatar old + new `…Q` formats are supported.)

## Step 7 — Turn on live 24/7 ANPR (optional)
In the Space → **Settings → Variables and secrets**, add the secrets from
[`.env.huggingface.example`](.env.huggingface.example):

| Secret | Why |
|---|---|
| `LIVE_RTSP_URL` | The internet-reachable camera stream to run ANPR on (relay view URL / public RTSP-TCP / HLS). Surfaces as the auto-started camera `cloud-rtsp`. |
| `DATABASE_URL` | Free managed Postgres so detections survive restarts (no disk on free HF). |
| `SECRET_KEY` | ≥32-char string for stable login sessions. |

The Space rebuilds; on boot the log shows `Camera provisioner: started 1/1
enabled camera(s)` and ANPR runs continuously. To keep it awake, add a free
**UptimeRobot / cron-job.org** monitor pinging `https://<id>.hf.space/api/ready`
every 5 minutes.

> **Getting the stream onto the internet:** if your camera is a Dahua/home camera
> behind NAT, run a small relay — `deploy/relay/setup-vps.sh` stands up MediaMTX
> on a cheap/free VPS; an on-site device (or the edge PC) pushes the camera to it,
> and you point `LIVE_RTSP_URL` at the relay's view URL.

---

## Updating later
Re-run the same command — it re-pushes and HF rebuilds:
```powershell
./push-to-space.ps1 -SpaceId "yourname/cartrack" -HfToken "hf_xxxxxxxx"
```

## How it works (one port)
HF exposes only port **7860**. The image runs FastAPI on 7860 and also serves
the built React SPA from it, so the UI, REST (`/api`), VisionFlow (`/vf`) and the
WebSocket (`wss://…/ws`) are all **same-origin** — the frontend is built in
"gateway mode" (relative URLs) for exactly this.

## Troubleshooting
| Symptom | Fix |
|---|---|
| `git lfs not found` | `git lfs install`, reopen terminal |
| `Could not clone … check the token` | Create the Space first (SDK **Docker**); token needs **Write** |
| Build fails on `npm ci` | Ensure `frontend/package-lock.json` exists (it does in this repo) |
| App loads but ANPR says "weights not found" | Confirm `backend/models/*.pt` exists before pushing |
| Space shows "Sleeping" | Free tier sleeps when idle — open the URL to wake it (~20 s) |
| Data disappeared | Expected on free (no persistent disk). Needs a paid disk or a real VM |

## When you outgrow the demo
For the **live camera, 24/7, persistent data** product, deploy `deploy/cloud/`
on a real VM (Oracle A1 always-free, or Google Cloud $300/90-day). Same app,
same code — it just needs a server that doesn't sleep and allows the P2P tunnel.
