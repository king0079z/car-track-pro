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

    # ── Live camera 24/7 operation ───────────────────────────────────────────
    LIVE_24_7_ENABLED: bool = True
    LIVE_AUTO_RECONNECT: bool = True
    LIVE_RECONNECT_BASE_SEC: float = 1.5
    LIVE_RECONNECT_MAX_SEC: float = 45.0
    LIVE_READ_FAIL_MAX: int = 20  # consecutive bad reads before reconnect attempt
    LIVE_SEGMENT_MINUTES: int = 60  # rotate annotated MP4 every N minutes
    LIVE_SEGMENT_RETENTION_DAYS: int = 7  # delete old segment files automatically
    LIVE_MEMORY_MAX_TRACKS: int = 1200  # prune exited track state beyond this count
    LIVE_MEMORY_PRUNE_EVERY_FRAMES: int = 500  # run prune during live every N processed frames
    LIVE_SUPERVISOR_INTERVAL_SEC: float = 20.0
    LIVE_STALE_FRAME_SEC: float = 90.0  # watchdog restarts session if no frames this long
    LIVE_RESUME_ON_STARTUP: bool = False  # only open cameras after explicit Start (not on server boot)
    LIVE_PROBE_CAMERAS_ON_STARTUP: bool = False  # avoid opening USB webcams during init
    LIVE_STARTUP_DELAY_SEC: float = 8.0
    LIVE_MAX_CAMERAS: int = 4  # multi-camera grid slots (0 .. N-1)
    LIVE_GRID_RESUME_STAGGER_SEC: float = 12.0  # delay between auto-resume jobs (avoids USB fights)

    # CarTrack Cloud Relay (your VPS + MediaMTX) — optional env defaults for cameras.json
    CARTRACK_RELAY_PUBLISH_URL: str = ""  # edge PC pushes LAN stream here (rtsp://vps:8554/site/cam)
    CARTRACK_RELAY_VIEW_URL: str = ""  # cloud CarTrack pulls ANPR from here

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
