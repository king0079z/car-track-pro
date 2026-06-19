from pydantic_settings import BaseSettings, SettingsConfigDict
from typing import List


class Settings(BaseSettings):
    # App
    APP_NAME: str = "CarTrack Pro"
    APP_VERSION: str = "1.0.0"
    DEBUG: bool = False  # Always False by default; set DEBUG=true in .env for local dev
    ALLOWED_ORIGINS: str = "http://localhost:3000,http://localhost:5173,http://localhost:5174"
    # Add your Vercel URL(s): https://your-app.vercel.app (comma-separated, no spaces)

    # Database — SQLite (dev), postgresql://..., or XAMPP MySQL:
    #   mysql+pymysql://root:@127.0.0.1:3306/cartrack?charset=utf8mb4
    DATABASE_URL: str = "sqlite:///./cartrack.db"

    # Security
    SECRET_KEY: str = "change-me-in-production-must-be-32-chars-minimum"
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 480

    # AI
    AI_CONFIDENCE_THRESHOLD: float = 0.7
    PLATE_RECOGNITION_API_KEY: str = ""
    USE_GPU: bool = False
    YOLO_MODEL_PATH: str = "./ai/models/yolov8n.pt"
    # Bundled reference stack (License-Plate-Detection-with-YoloV8-and-EasyOCR): leave empty to use backend/models/*.pt
    YOLO_PLATE_WEIGHTS: str = ""
    YOLO_COCO_WEIGHTS: str = ""
    # Full-frame plate YOLO + grayscale EasyOCR (area filter) — matches uploaded reference app
    LP_REFERENCE_PIPELINE: bool = True
    # Plates: qa_uk = Qatar + UK shapes; uk | qa | intl (accept any plausible plate)
    # When PLATE_STRICT_JURISDICTION=true, OCR hits that do not match the selected
    # region shapes are discarded (higher precision, fewer false positives).
    PLATE_JURISDICTION: str = "qa_uk"
    PLATE_STRICT_JURISDICTION: bool = False
    # Multi-variant OCR on uploaded video (ocr_fast=false path). False = faster scans; True = heavier reads.
    PLATE_UPLOAD_DEEP_OCR: bool = False
    # Max long edge (pixels) for reference-pipeline EasyOCR crop before grayscale — lower is faster, higher keeps detail.
    PLATE_REF_OCR_MAX_SIDE: int = 320

    # ── YOLO11 plate + speed pipeline (vendor: yolo11-nubberplate-speed-xampp-main / main.py)
    # When True and backend/models/best.pt or yolo11_best.pt exists (or YOLO11_WEIGHTS path), live cameras use this instead of legacy ANPR.
    YOLO11_SPEED_PIPELINE: bool = True
    YOLO11_WEIGHTS: str = ""  # empty → backend/models/best.pt then yolo11_best.pt
    YOLO11_RESIZE_WIDTH: int = 1020
    # Live cloud SD sub-streams (640p/480p): upscale for YOLO/OCR to match uploaded-video quality.
    VF_LIVE_SD_MAX_EDGE: int = 960       # native max(w,h) below this → SD path
    VF_LIVE_SD_INFERENCE_WIDTH: int = 1280  # inference canvas width for SD (LANCZOS upscale)
    YOLO11_ROI_Y_AT_500H: int = 145
    YOLO11_CONF: float = 0.2
    YOLO11_METER_PER_PIXEL: float = 0.05
    YOLO11_MAX_SPEED_KMH: float = 130.0
    YOLO11_SPEED_SMOOTH: float = 0.35
    YOLO11_SAVE_WITHOUT_SPEED: bool = False

    # ── YOLO26 plate + speed pipeline (Ultralytics YOLO26, Jan 2026+)
    # Set YOLO26_WEIGHTS or place yolo26_best.pt in backend/models/ after fine-tuning.
    YOLO26_WEIGHTS: str = ""
    YOLO_TRACKER: str = "botsort.yaml"  # botsort.yaml (default) | bytetrack.yaml
    PLATE_OCR_PREPROCESS: bool = True  # grayscale + CLAHE on crops before EasyOCR
    # Plate OCR engine: fast_plate (purpose-built, ~96%+) | easyocr (fallback, ~91%)
    PLATE_OCR_ENGINE: str = "fast_plate"
    FAST_PLATE_MODEL: str = "cct-s-v2-global-model"  # cct-xs-v2-global-model = faster
    # Frames a track may be missing before it's marked "exited" (anti-flicker)
    PLATE_EXIT_GRACE_SEC: float = 0.8
    # Same plate re-entering camera within this window resumes Live status and adds in-frame dwell (bay moves, errands).
    PLATE_RESUME_GAP_SEC: float = 7200.0  # 2 hours

    # Storage
    UPLOAD_DIR: str = "./uploads"
    MAX_UPLOAD_SIZE_MB: int = 50

    # Redis (optional — only needed if background tasks are added)
    REDIS_URL: str = "redis://localhost:6379/0"

    # Audit — periodic system snapshots written to audit_logs (manager Audit page + CSV export)
    AUDIT_PERIODIC_INTERVAL_SECONDS: int = 21600  # 6 hours
    AUDIT_RUN_ON_STARTUP: bool = True  # first snapshot ~45s after boot so UI is not empty
    AUDIT_STARTUP_DELAY_SECONDS: int = 45

    # ── Env-driven cloud camera (cloud/Hugging Face deploy, no on-site PC edits) ─
    # Point a hosted deploy at ONE internet-reachable stream (a cloud relay's view
    # URL, a public RTSP-over-TCP camera, or an HLS URL). When set, it surfaces as
    # an always-enabled camera "cloud-rtsp" that the 24/7 supervisor auto-starts on
    # boot — the turnkey way to run live ANPR on a server that can't reach a LAN
    # camera or the Easy4IP P2P tunnel (e.g. Hugging Face Spaces).
    LIVE_RTSP_URL: str = ""
    LIVE_RTSP_NAME: str = "Cloud Camera"
    LIVE_RTSP_SLOT: int = 0
    LIVE_RTSP_METER_PER_PIXEL: float = 0.0

    # ── Live camera 24/7 operation ───────────────────────────────────────────
    LIVE_24_7_ENABLED: bool = True
    LIVE_AUTO_RECONNECT: bool = True
    LIVE_RECONNECT_BASE_SEC: float = 1.5
    LIVE_RECONNECT_MAX_SEC: float = 45.0
    LIVE_READ_FAIL_MAX: int = 20  # consecutive bad reads before reconnect attempt
    LIVE_STALL_RECONNECT_SEC: float = 25.0  # seconds with no NEW decoded frame before forcing a reconnect (higher = more tolerant of slow Wi-Fi / CPU)
    LIVE_SEGMENT_MINUTES: int = 60  # rotate annotated MP4 every N minutes
    LIVE_SEGMENT_RETENTION_DAYS: int = 7  # delete old segment files automatically
    LIVE_SEGMENT_MAX_GB: float = 10.0  # hard disk cap for ALL recorded media (segments + uploads + annotated); 0 = disabled, oldest purged first
    # Uploaded source clips and annotated result videos are heavy and disposable:
    # the extracted data (plates/speeds/times) is persisted in the databases, so
    # these MP4s are auto-deleted once older than this window. Set 0 to disable.
    ANALYSIS_MEDIA_RETENTION_HOURS: float = 12.0
    LIVE_JOB_RETENTION: int = 64  # max finished/terminal in-memory job records kept before eviction
    LIVE_MEMORY_MAX_TRACKS: int = 1200  # prune exited track state beyond this count
    LIVE_MEMORY_PRUNE_EVERY_FRAMES: int = 500  # run prune during live every N processed frames
    LIVE_SUPERVISOR_INTERVAL_SEC: float = 20.0
    LIVE_STALE_FRAME_SEC: float = 90.0  # watchdog restarts session if no frames this long
    LIVE_RESUME_ON_STARTUP: bool = False  # only open cameras after explicit Start (not on server boot)
    LIVE_PROBE_CAMERAS_ON_STARTUP: bool = False  # avoid opening USB webcams during init
    LIVE_STARTUP_DELAY_SEC: float = 8.0
    LIVE_MAX_CAMERAS: int = 16  # multi-camera grid slots (0 .. N-1)
    LIVE_GRID_RESUME_STAGGER_SEC: float = 12.0  # delay between auto-resume jobs (avoids USB fights)

    # ── Multi-camera scale: shared inference + concurrency governor ──────────
    # Share ONE OCR reader across all live cameras (OCR is the largest standalone
    # memory consumer and is stateless). Massively cuts RAM/VRAM at 8-16 cameras.
    LIVE_SHARED_OCR: bool = True
    # Max concurrent heavy model inferences across ALL live feeds. Prevents 16
    # camera threads thrashing one GPU/CPU. 0 = unlimited (legacy). Tune to GPU count.
    INFERENCE_MAX_CONCURRENCY: int = 2

    # ── Speed estimation accuracy (per-camera calibration + smoothing) ───────
    # Median window (samples) for instantaneous speed; >1 removes single-frame spikes.
    SPEED_WINDOW_SAMPLES: int = 5

    # CarTrack Cloud Relay (your VPS + MediaMTX) — optional env defaults for cameras.json
    CARTRACK_RELAY_PUBLISH_URL: str = ""  # edge PC pushes LAN stream here (rtsp://vps:8554/site/cam)
    CARTRACK_RELAY_VIEW_URL: str = ""  # cloud CarTrack pulls ANPR from here

    # Dahua Hero / Easy4IP cloud (DMSS-style P2P, no on-site PC) — overrides cameras.json when set
    DAHUA_ENABLED: bool = False
    DAHUA_DEVICE_SERIAL: str = ""  # SN from device QR, e.g. BF0E4C7GAGB833C
    DAHUA_PASSWORD: str = ""  # device password from DMSS (not DMSS email login)
    DAHUA_USERNAME: str = "admin"
    DAHUA_CONNECTION_MODE: str = "cartrack_cloud"  # cartrack_cloud | p2p | auto | lan | cartrack_relay | cloud_hls
    DAHUA_DEVICE_TYPE: str = ""  # optional, e.g. DH-H3A
    DAHUA_HOST: str = ""  # optional LAN IP for auto mode fallback
    DAHUA_STREAM: str = "sub"  # sub | main
    DAHUA_P2P_LOCAL_PORT: int = 18554
    # When serial+password env vars are set, auto-start Easy4IP tunnel on API boot
    DAHUA_P2P_PREWARM_ON_STARTUP: bool = True

    # Imou / Easy4IP Open Platform — cloud HLS path (DMSS-grade, pure cloud, no
    # on-site PC). Register a free app at open.imoulife.com; data center decides
    # the base URL (sg=East Asia, fk=Central Europe, or=Western America).
    IMOU_APP_ID: str = ""
    IMOU_APP_SECRET: str = ""
    IMOU_BASE_URL: str = "https://openapi-sg.easy4ip.com"
    IMOU_CHANNEL: str = "0"
    IMOU_PREFER_HD: bool = False  # SD sub-stream default (saves Imou media-flow quota)

    # ── Adaptive cloud streaming (Imou quota saver) ──────────────────────────
    # Master switch for all cloud-quota protections below. The Imou Open
    # Platform bills interface requests + media flow (GB); these settings keep
    # 24/7 ANPR inside the free tier without sacrificing plate reads.
    STREAM_SAVER_ENABLED: bool = True
    # Cache resolved HLS URLs so stream reconnects do NOT re-hit the cloud API
    # (bindDeviceLive + getLiveStreamInfo) every time. Invalidated automatically
    # when a cached URL fails to open.
    IMOU_HLS_CACHE_TTL_SEC: float = 600.0
    # When the cloud cannot resolve a stream (camera offline / unplugged), back
    # off exponentially instead of hammering the API on every reconnect.
    IMOU_FAIL_BACKOFF_BASE_SEC: float = 30.0
    IMOU_FAIL_BACKOFF_MAX_SEC: float = 600.0
    # Hybrid SD/HD: idle on the SD sub-stream (~4-8x less media flow), escalate
    # to the HD main stream while a plate is in frame, drop back after the hold.
    STREAM_HYBRID_ENABLED: bool = True
    # Plate box width (fraction of frame width) needed to request HD. 0.0 =
    # any plate detection escalates; raise (e.g. 0.05) to escalate only when
    # the vehicle is close.
    STREAM_HD_ESCALATE_WIDTH_FRAC: float = 0.0
    STREAM_HD_HOLD_SEC: float = 90.0  # stay on HD this long after the last detection
    STREAM_ANPR_WARMUP_HD_SEC: float = 180.0  # HD for this long after live ANPR starts (bootstrap detections)
    STREAM_TIER_MIN_DWELL_SEC: float = 45.0  # min seconds between SD<->HD switches (anti-flap)
    # Idle / wake (power save): with no detections and no viewer, release the
    # cloud stream and sample one frame on an adaptive interval. A detection in
    # a sample (or someone opening the camera wall) wakes the stream instantly.
    LIVE_IDLE_ENABLED: bool = True
    LIVE_IDLE_ON_SD: bool = False  # keep SD sub-stream running full ANPR (no 152s power-save gaps)
    LIVE_IDLE_AFTER_SEC: float = 240.0  # no plates this long → enter power save (HD only when LIVE_IDLE_ON_SD=false)
    LIVE_IDLE_SAMPLE_BASE_SEC: float = 30.0  # first sampling interval while idle
    LIVE_IDLE_SAMPLE_MAX_SEC: float = 300.0  # sampling interval ceiling (deep idle)
    LIVE_VIEWER_HOLD_SEC: float = 45.0  # recent preview fetch keeps the stream awake this long

    # ── WhatsApp customer notifications (Meta WhatsApp Business Cloud API) ───
    # Free Meta developer setup: developers.facebook.com → WhatsApp → API setup.
    # When configured, customers get a WhatsApp message the moment their work
    # order is completed / checked out (runtime toggle in app Settings).
    WHATSAPP_ENABLED: bool = False
    WHATSAPP_ACCESS_TOKEN: str = ""
    WHATSAPP_PHONE_NUMBER_ID: str = ""
    WHATSAPP_API_VERSION: str = "v22.0"
    # Optional approved template name for business-initiated messages
    # (required by WhatsApp outside the 24h customer-service window).
    WHATSAPP_TEMPLATE_NAME: str = ""
    WHATSAPP_FULL_REPORT: bool = True  # send full receipt text even when a template name is set
    WHATSAPP_DEFAULT_COUNTRY_CODE: str = "974"  # Qatar — prefix for local numbers
    # Local dev: log the receipt instead of calling Meta (no credentials needed)
    WHATSAPP_DRY_RUN: bool = False

    # ── Automatic database backups ────────────────────────────────────────────
    BACKUP_ENABLED: bool = True
    BACKUP_INTERVAL_HOURS: float = 6.0
    BACKUP_RETENTION_DAYS: int = 14
    BACKUP_DIR: str = ""  # empty → {CARTRACK_DATA_DIR or backend}/backups

    # ── Login protection ──────────────────────────────────────────────────────
    LOGIN_LOCKOUT_MINUTES: float = 15.0  # lockout after max_login_attempts failures

    @property
    def cors_origins(self) -> List[str]:
        return [o.strip() for o in self.ALLOWED_ORIGINS.split(",")]

    # pydantic-settings v2 style (replaces deprecated inner class Config)
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=True,
        extra="ignore",  # silently ignore unknown env vars injected by Docker
    )


settings = Settings()
