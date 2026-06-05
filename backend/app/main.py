from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager
import asyncio
import json
import logging
import os
from pathlib import Path
from typing import List

from .config import settings
from .services.opencv_headless import ensure_headless_opencv
from .services.visionflow_model import model_status

ensure_headless_opencv()


async def _periodic_audit_loop():
    """Writes operational snapshots to audit_logs on a timer (manager Audit page + CSV export)."""
    from .database import SessionLocal
    from .services.audit_service import run_periodic_system_audit

    await asyncio.sleep(max(5, int(settings.AUDIT_STARTUP_DELAY_SECONDS)))
    if settings.AUDIT_RUN_ON_STARTUP:
        db = SessionLocal()
        try:
            run_periodic_system_audit(db)
            logger.info("Initial operational audit snapshot written ✓")
        except Exception:
            logger.exception("Initial audit snapshot failed")
        finally:
            db.close()
    interval = max(300, int(settings.AUDIT_PERIODIC_INTERVAL_SECONDS))
    while True:
        await asyncio.sleep(interval)
        db = SessionLocal()
        try:
            run_periodic_system_audit(db)
            logger.info("Periodic operational audit snapshot written ✓")
        except Exception:
            logger.exception("Periodic audit snapshot failed")
        finally:
            db.close()
from .database import init_db
from .routers import auth, users, vehicles, visits, services, analytics, audit, errors, cameras
from .routers import settings as settings_router
from .routers.visionflow import router as visionflow_router, init_visionflow
from .routers.anpr import router as anpr_router

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s – %(message)s")
logger = logging.getLogger(__name__)


class _HighFrequencyAccessFilter(logging.Filter):
    """
    Drop per-frame preview/poll access logs (snapshot.jpg, job status).

    The VisionFlow UI polls the live preview ~10×/sec; logging every request
    floods stdout and, when the pipe backs up, a synchronous log write can
    block the analyzer thread and freeze frame processing. These requests carry
    no diagnostic value, so we filter them out of the access log.
    """

    _NOISE = ("/snapshot.jpg", "/vf/api/jobs/", "/api/anpr/recent")

    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        # These are high-frequency UI polls with no diagnostic value. Suppress
        # them regardless of status code (the access record ends with the bare
        # status number, e.g. `... HTTP/1.1" 200`, so we don't gate on it).
        if any(tok in msg for tok in self._NOISE):
            return False
        return True


logging.getLogger("uvicorn.access").addFilter(_HighFrequencyAccessFilter())

_BACKEND_DIR = Path(__file__).resolve().parents[1]
_STATIC_VF = _BACKEND_DIR / "static" / "visionflow"


# ── WebSocket Manager ─────────────────────────────────────────────────────────

class ConnectionManager:
    def __init__(self):
        self.active: List[WebSocket] = []

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self.active.append(ws)
        logger.info(f"WS client connected. Total: {len(self.active)}")

    def disconnect(self, ws: WebSocket):
        if ws in self.active:
            self.active.remove(ws)
        logger.info(f"WS client disconnected. Total: {len(self.active)}")

    async def broadcast(self, message: dict):
        dead = []
        payload = json.dumps(message)
        for ws in self.active:
            try:
                await ws.send_text(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            if ws in self.active:
                self.active.remove(ws)


manager = ConnectionManager()


# ── Lifespan ──────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("CarTrack Pro starting up…")
    init_db()
    _seed_default_data()
    os.makedirs(settings.UPLOAD_DIR, exist_ok=True)
    os.makedirs("./uploads", exist_ok=True)

    # VisionFlow: create uploads/outputs dirs + init SQLite history DB
    init_visionflow()
    from .services.live_supervisor import get_live_supervisor
    get_live_supervisor().start()
    logger.info("VisionFlow analyzer ready (models load lazily on first job) ✓")
    logger.info(
        "Live 24/7 supervisor enabled ✓"
        if settings.LIVE_24_7_ENABLED
        else "Live 24/7 supervisor disabled"
    )
    if settings.LIVE_24_7_ENABLED and not settings.LIVE_RESUME_ON_STARTUP:
        logger.info("Live camera auto-resume on startup is OFF — webcam opens only when you Start from ANPR/Camera wall")
    audit_task = asyncio.create_task(_periodic_audit_loop())
    logger.info(
        "Operational audit scheduler started "
        f"(first snapshot ~{settings.AUDIT_STARTUP_DELAY_SECONDS}s, then every {settings.AUDIT_PERIODIC_INTERVAL_SECONDS}s) ✓"
    )
    try:
        from .services.dahua_p2p_tunnel import check_p2p_dependencies, prewarm_cloud_tunnel_async

        dep_err = check_p2p_dependencies()
        if dep_err:
            logger.warning("Dahua cloud P2P: %s", dep_err)
        else:
            prewarm_cloud_tunnel_async()
            logger.info("Dahua cloud P2P prewarm started (if camera enabled in cloud mode) ✓")
    except Exception:
        logger.exception("Dahua cloud P2P startup hook failed")

    logger.info("CarTrack Pro ready ✓")

    yield

    from .services.live_supervisor import get_live_supervisor
    get_live_supervisor().stop()
    audit_task.cancel()
    try:
        await audit_task
    except asyncio.CancelledError:
        pass
    logger.info("CarTrack Pro shutting down…")


# ── Default data seeding ──────────────────────────────────────────────────────

def _seed_default_data():
    from .database import SessionLocal
    from .models.user import User
    from .models.service import Service, ServiceCategory
    from .utils.auth import hash_password

    db = SessionLocal()
    try:
        if not db.query(User).first():
            admin = User(
                full_name="Ahmed Al-Rashidi",
                email="admin@cartrack.qa",
                username="admin",
                hashed_password=hash_password("demo1234"),
                role="admin",
                is_active=True,
            )
            db.add(admin)
            logger.info("Default admin created: username=admin password=demo1234")

        if not db.query(Service).first():
            default_services = [
                Service(name="Basic Wash", category=ServiceCategory.WASH, base_price=30, estimated_duration_minutes=20),
                Service(name="Full Wash & Vacuum", category=ServiceCategory.WASH, base_price=60, estimated_duration_minutes=40),
                Service(name="Full Detailing", category=ServiceCategory.DETAILING, base_price=300, estimated_duration_minutes=240),
                Service(name="Interior Detailing", category=ServiceCategory.DETAILING, base_price=180, estimated_duration_minutes=120),
                Service(name="Machine Polish", category=ServiceCategory.POLISH, base_price=400, estimated_duration_minutes=180),
                Service(name="Hand Polish", category=ServiceCategory.POLISH, base_price=150, estimated_duration_minutes=90),
                Service(name="Paint Protection Film", category=ServiceCategory.REPAIR, base_price=1200, estimated_duration_minutes=360),
                Service(name="Ceramic Coating", category=ServiceCategory.DETAILING, base_price=800, estimated_duration_minutes=480),
                Service(name="Oil Change", category=ServiceCategory.MAINTENANCE, base_price=120, estimated_duration_minutes=30),
                Service(name="Safety Inspection", category=ServiceCategory.INSPECTION, base_price=80, estimated_duration_minutes=45),
            ]
            db.add_all(default_services)
            logger.info("Default services seeded")

        db.commit()
    finally:
        db.close()


# ── FastAPI app ───────────────────────────────────────────────────────────────

app = FastAPI(
    title=settings.APP_NAME,
    version=settings.APP_VERSION,
    description="AI-Powered Car Care Monitoring & Analytics System",
    lifespan=lifespan,
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    redirect_slashes=False,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_origin_regex=r"https://.*\.vercel\.app",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def record_unhandled_api_errors(request: Request, call_next):
    """Persist server-side failures for Settings › Error log."""
    path = request.url.path or ""
    skip = (
        path.startswith("/uploads")
        or path.startswith("/static")
        or path.startswith("/analyzer")
        or path in ("/api/health", "/api/ready", "/api/settings/public")
    )
    try:
        response = await call_next(request)
        if not skip and response.status_code >= 500 and path.startswith("/api"):
            from .database import SessionLocal
            from .services.error_recorder import record_application_error

            db = SessionLocal()
            try:
                record_application_error(
                    db,
                    severity="error",
                    category="api",
                    source=f"{request.method} {path}",
                    message=f"HTTP {response.status_code}",
                    detail=f"Unhandled API response {response.status_code}",
                    ip_address=request.client.host if request.client else None,
                    context={"status_code": response.status_code, "path": path},
                )
            finally:
                db.close()
        return response
    except Exception as exc:
        if not skip and path.startswith("/api"):
            from .database import SessionLocal
            from .services.error_recorder import record_exception

            db = SessionLocal()
            try:
                record_exception(
                    exc,
                    db=db,
                    category="api",
                    source=f"{request.method} {path}",
                    ip_address=request.client.host if request.client else None,
                    context={"path": path},
                )
            finally:
                db.close()
        raise

os.makedirs("./uploads", exist_ok=True)
app.mount("/uploads", StaticFiles(directory="./uploads"), name="uploads")

# VisionFlow static assets (app.css etc.) served at /static/
if _STATIC_VF.is_dir():
    app.mount("/static", StaticFiles(directory=str(_STATIC_VF)), name="visionflow_static")

# ── Routers ───────────────────────────────────────────────────────────────────
app.include_router(auth.router)
app.include_router(users.router)
app.include_router(vehicles.router)
app.include_router(visits.router)
app.include_router(services.router)
app.include_router(analytics.router)
app.include_router(audit.router)
app.include_router(settings_router.router)
app.include_router(errors.router)
app.include_router(cameras.router)
app.include_router(anpr_router)                # /api/anpr/*
app.include_router(visionflow_router)          # /vf/api/*


# ── VisionFlow UI pages ───────────────────────────────────────────────────────
NO_CACHE = {"Cache-Control": "no-store, no-cache, must-revalidate", "Pragma": "no-cache"}

@app.get("/analyzer", include_in_schema=False)
async def analyzer_redirect():
    return RedirectResponse(url="/analyzer/", status_code=302)


@app.get("/analyzer/", include_in_schema=False)
async def analyzer_page():
    p = _STATIC_VF / "index.html"
    if not p.is_file():
        return JSONResponse({"error": "VisionFlow UI not found. Check backend/static/visionflow/"}, status_code=404)
    return FileResponse(str(p), headers=NO_CACHE)


@app.get("/analyzer/history", include_in_schema=False)
async def analyzer_history_page():
    p = _STATIC_VF / "history.html"
    if not p.is_file():
        return JSONResponse({"error": "VisionFlow history UI not found."}, status_code=404)
    return FileResponse(str(p), headers=NO_CACHE)


# ── Health ────────────────────────────────────────────────────────────────────

@app.get("/api/health")
def health_check():
    vf = model_status()
    return {
        "status": "ok",
        "app": settings.APP_NAME,
        "version": settings.APP_VERSION,
        "visionflow_model_ready": vf["ready"],
        "visionflow_model": vf["path"],
        "visionflow_model_family": vf["family"],
        "cameras_api": _cameras_api_ready(),
    }


def _cameras_api_ready() -> bool:
    return any(getattr(r, "path", None) == "/api/cameras/profiles" for r in app.routes)


@app.get("/api/ready")
def readiness_check():
    cameras = _cameras_api_ready()
    return {
        "ready": True,
        "cameras_api": cameras,
    }


# ── WebSocket endpoint ────────────────────────────────────────────────────────

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await manager.connect(ws)
    await ws.send_text(json.dumps({"type": "connected", "message": "CarTrack Pro connected"}))
    try:
        while True:
            data = await ws.receive_text()
            try:
                msg = json.loads(data)
                msg_type = msg.get("type")
                if msg_type == "ping":
                    await ws.send_text(json.dumps({"type": "pong"}))
                elif msg_type == "subscribe":
                    await ws.send_text(json.dumps({"type": "subscribed", "channel": msg.get("channel")}))
            except json.JSONDecodeError:
                pass
    except WebSocketDisconnect:
        manager.disconnect(ws)


app.state.ws_manager = manager


async def broadcast_event(event_type: str, data: dict):
    await manager.broadcast({"type": event_type, **data})
