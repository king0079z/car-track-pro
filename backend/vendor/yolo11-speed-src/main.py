import argparse
import math
import os
import re
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

import cv2
import easyocr
import mysql.connector
import numpy as np
from ultralytics.solutions.solutions import BaseSolution
from ultralytics.utils.plotting import Annotator, colors

# Matches tutorial: XAMPP MySQL usually uses root with empty password.
MYSQL_HOST = os.environ.get("MYSQL_HOST", "localhost")
MYSQL_USER = os.environ.get("MYSQL_USER", "root")
MYSQL_PASSWORD = os.environ.get("MYSQL_PASSWORD", "")
DB_NAME = "numberplates_speed"

_REPO_DIR = Path(__file__).resolve().parent
SQLITE_PATH = _REPO_DIR / "plates_local.db"


def _point_xy(pt) -> tuple[float, float]:
    """Normalize track-history point (may be tensors or floats) to x, y."""
    x, y = pt[0], pt[1]
    fx = float(x.item()) if hasattr(x, "item") else float(x)
    fy = float(y.item()) if hasattr(y, "item") else float(y)
    return fx, fy


class SpeedEstimator(BaseSolution):
    def __init__(self, **kwargs):
        kwargs.setdefault("verbose", False)
        super().__init__(**kwargs)
        self.initialize_region()  # counting line / ROI geometry (still useful for analytics)

        # Speed state (km/h), smoothed — filled by physics-based estimate using FPS + meter-per-pixel
        self.spd = {}
        self._spd_ema = {}  # track_id -> float km/h (EMA)
        self.logged_ids = set()
        self._last_ocr_text = {}

        # Calibration (set from main() using video FPS / stride / scene scale)
        self._vid_fps = 30.0
        self._proc_stride = 1
        self._meter_per_pixel = 0.05
        self._max_speed_kmh = 130.0
        self._speed_smooth = 0.35

        # EasyOCR is reliable on Windows with PyTorch; PaddleOCR 3.x can hit OneDNN/PIR errors on some setups.
        self.reader = easyocr.Reader(["en"], gpu=False, verbose=False)

        self._db_backend = None
        self.db_connection = self.connect_to_db()

    def connect_to_db(self):
        """Prefer MySQL (XAMPP); if the server is down, use SQLite so the demo still runs."""
        try:
            connection = mysql.connector.connect(
                host=MYSQL_HOST,
                user=MYSQL_USER,
                password=MYSQL_PASSWORD,
            )
            cursor = connection.cursor()

            cursor.execute(f"CREATE DATABASE IF NOT EXISTS `{DB_NAME}`")
            print(f"Database '{DB_NAME}' checked/created (MySQL).")

            cursor.execute(f"USE `{DB_NAME}`")

            create_table_query = """
            CREATE TABLE IF NOT EXISTS my_data (
                id INT AUTO_INCREMENT PRIMARY KEY,
                date DATE,
                time TIME,
                track_id INT,
                class_name VARCHAR(255),
                speed FLOAT,
                numberplate TEXT
            )
            """
            cursor.execute(create_table_query)
            print("Table 'my_data' checked/created (MySQL).")

            self._db_backend = "mysql"
            return connection
        except mysql.connector.Error as err:
            print(
                f"MySQL unavailable ({err}). Start MySQL in XAMPP for phpMyAdmin export.\n"
                f"Using SQLite fallback: {SQLITE_PATH}"
            )
            conn = sqlite3.connect(str(SQLITE_PATH))
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS my_data (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    date TEXT,
                    time TEXT,
                    track_id INTEGER,
                    class_name TEXT,
                    speed REAL,
                    numberplate TEXT
                )
                """
            )
            conn.commit()
            self._db_backend = "sqlite"
            print("Table 'my_data' checked/created (SQLite).")
            return conn

    def perform_ocr(self, image_array):
        """Performs OCR on the given image and returns the extracted text."""
        if image_array is None or not isinstance(image_array, np.ndarray):
            return ""
        if image_array.size == 0 or image_array.ndim < 2:
            return ""
        h, w = image_array.shape[:2]
        if h < 10 or w < 10:
            return ""
        # Upscale tiny plate crops — phone video plates are often too small for OCR.
        crop = image_array
        if h < 48 or w < 140:
            scale = max(48 / h, 140 / w, 2.0)
            nh, nw = max(1, int(h * scale)), max(1, int(w * scale))
            crop = cv2.resize(crop, (nw, nh), interpolation=cv2.INTER_CUBIC)
        try:
            results = self.reader.readtext(crop)
        except Exception as err:
            print(f"OCR error: {err}")
            return ""

        texts = []
        for item in results:
            if len(item) >= 2:
                texts.append(str(item[1]))
        raw = " ".join(texts).strip()
        # Keep plate-like characters (letters, digits, common separators)
        cleaned = re.sub(r"[^A-Za-z0-9\s\-]", "", raw)
        cleaned = re.sub(r"\s+", " ", cleaned).strip()
        return cleaned or raw

    def save_to_database(self, date, time_str, track_id, class_name, speed, numberplate):
        """Save plate / speed row (MySQL or SQLite)."""
        try:
            cursor = self.db_connection.cursor()
            if self._db_backend == "mysql":
                query = """
                    INSERT INTO my_data (date, time, track_id, class_name, speed, numberplate)
                    VALUES (%s, %s, %s, %s, %s, %s)
                """
                cursor.execute(query, (date, time_str, track_id, class_name, speed, numberplate))
            else:
                cursor.execute(
                    """
                    INSERT INTO my_data (date, time, track_id, class_name, speed, numberplate)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (date, time_str, track_id, class_name, speed, numberplate),
                )
            self.db_connection.commit()
            print(f"Data saved to database: {date}, {time_str}, {track_id}, {class_name}, {speed}, {numberplate}")
        except Exception as err:
            print(f"Error saving to database: {err}")
            raise

    def estimate_speed(self, im0):
        """Estimate speed of objects and track them."""
        self.annotator = Annotator(im0, line_width=self.line_width)  # Initialize annotator
        self.extract_tracks(im0)  # Extract tracks

        # Get current date and time
        current_time = datetime.now()

        for box, track_id, cls in zip(self.boxes, self.track_ids, self.clss):
            self.store_tracking_history(track_id, box)

            hist = self.track_history[track_id]
            if len(hist) >= 2:
                x0, y0 = _point_xy(hist[-2])
                x1, y1 = _point_xy(hist[-1])
                pix_dist = math.hypot(x1 - x0, y1 - y0)
                dt = max(self._proc_stride / max(self._vid_fps, 1e-3), 1e-6)
                v_px_s = pix_dist / dt
                kmh_inst = min(v_px_s * self._meter_per_pixel * 3.6, self._max_speed_kmh)
                prev = self._spd_ema.get(track_id)
                alpha = self._speed_smooth
                if prev is None:
                    self._spd_ema[track_id] = kmh_inst
                else:
                    self._spd_ema[track_id] = alpha * kmh_inst + (1.0 - alpha) * prev
                self.spd[track_id] = int(round(self._spd_ema[track_id]))

            x1, y1, x2, y2 = map(int, box)  # Convert box coordinates to integers
            cropped_image = np.array(im0)[y1:y2, x1:x2]
            ocr_text = self.perform_ocr(cropped_image)
            if ocr_text.strip():
                self._last_ocr_text[track_id] = ocr_text.strip()

            plate_show = self._last_ocr_text.get(track_id, "")
            if not plate_show:
                plate_show = "…"

            spd_show = (
                f"{int(self.spd[track_id])} km/h"
                if track_id in self.spd
                else "— km/h"
            )
            label = f"ID:{track_id} {plate_show} | {spd_show}"
            self.annotator.box_label(box, label=label, color=colors(track_id, True))

            # Get the class name and speed
            class_name = self.names[int(cls)]
            speed = self.spd.get(track_id)

            save_no_speed = getattr(self, "_save_without_speed", False)
            should_save = (
                track_id not in self.logged_ids
                and ocr_text.strip()
                and (speed is not None or save_no_speed)
            )
            if should_save:
                self.save_to_database(
                    current_time.strftime("%Y-%m-%d"),
                    current_time.strftime("%H:%M:%S"),
                    track_id,
                    class_name,
                    float(speed) if speed is not None else 0.0,
                    ocr_text,
                )
                self.logged_ids.add(track_id)

        self.display_output(im0)  # Display output with base class function
        return im0


def _pick_video_file() -> Path:
    import tkinter as tk
    from tkinter import filedialog

    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    path = filedialog.askopenfilename(
        title="Choose a video to test",
        filetypes=[
            ("Video files", "*.mp4 *.avi *.mov *.mkv *.webm"),
            ("All files", "*.*"),
        ],
    )
    root.destroy()
    if not path:
        print("No video selected.")
        sys.exit(1)
    return Path(path)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="License plate detection, speed estimate, and save to MySQL (XAMPP) or SQLite."
    )
    p.add_argument(
        "--video",
        "-v",
        type=str,
        default=None,
        help="Path to your test video (e.g. C:\\Videos\\cars.mp4). Default: tc.mp4 in this folder.",
    )
    p.add_argument(
        "--pick",
        action="store_true",
        help="Open a file dialog to choose the video.",
    )
    p.add_argument(
        "--conf",
        type=float,
        default=0.2,
        help="Detection confidence for tracking (lower helps difficult / mobile video). Default: 0.2",
    )
    p.add_argument(
        "--stride",
        type=int,
        default=1,
        help="Process every Nth frame (1 = all frames, better tracking). Default: 1",
    )
    p.add_argument(
        "--width",
        type=int,
        default=1020,
        help="Resize width; height follows aspect ratio (avoids warping plates). Default: 1020",
    )
    p.add_argument(
        "--roi-y-at-500h",
        type=int,
        default=145,
        help="ROI line Y taken from tutorial at frame height 500; scaled for your video height.",
    )
    p.add_argument(
        "--save-without-speed",
        action="store_true",
        help="Save OCR rows even if speed line was not crossed (speed stored as 0). For testing.",
    )
    p.add_argument(
        "--meter-per-pixel",
        type=float,
        default=0.05,
        help="Scene calibration: real-world meters represented by one pixel "
        "(tune with a known distance in the frame). Typical highway scenes: 0.03–0.08. Default: 0.05",
    )
    p.add_argument(
        "--max-speed",
        type=float,
        default=130.0,
        help="Cap displayed / stored speed (km/h). Default: 130",
    )
    p.add_argument(
        "--speed-smooth",
        type=float,
        default=0.35,
        help="EMA factor 0–1 for speed smoothing (higher = react faster). Default: 0.35",
    )
    p.add_argument(
        "--fps",
        type=float,
        default=0.0,
        help="Override video FPS for speed math (0 = read from file). Default: 0",
    )
    return p.parse_args()


def main():
    args = parse_args()
    repo = _REPO_DIR
    model_path = repo / "best.pt"

    if not model_path.is_file():
        print(
            f"Missing YOLO weights: {model_path}\n"
            "Place best.pt from the project / training output in this folder."
        )
        sys.exit(1)

    if args.pick:
        video_path = _pick_video_file()
    elif args.video:
        video_path = Path(args.video).expanduser().resolve()
        if not video_path.is_file():
            print(f"Video not found: {video_path}")
            sys.exit(1)
    else:
        video_path = repo / "tc.mp4"
        if not video_path.is_file():
            print(
                f"Missing video: {video_path}\n"
                "Options: copy your file as tc.mp4 here, or run:\n"
                "  python main.py --video \"C:\\path\\to\\your.mp4\"\n"
                "  python main.py --pick"
            )
            sys.exit(1)

    print(f"Using video: {video_path}")
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        print(f"Could not open video: {video_path}")
        sys.exit(1)

    w0 = max(1, int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)))
    h0 = max(1, int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)))
    target_w = max(320, args.width)
    new_h = max(1, int(round(h0 * target_w / w0)))
    roi_y = max(1, min(new_h - 2, int(round(args.roi_y_at_500h * new_h / 500))))
    region_points = [(0, roi_y), (target_w - 1, roi_y)]

    vfps = float(args.fps) if args.fps and args.fps > 0 else float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
    if vfps < 1.0 or vfps > 240.0:
        vfps = 30.0

    print(
        f"Resize (keep aspect): {w0}x{h0} → {target_w}x{new_h}; "
        f"ROI line y={roi_y}; video FPS≈{vfps:.2f}; "
        f"m/px={args.meter_per_pixel:g} (calibrate for accurate km/h)."
    )

    speed_obj = SpeedEstimator(
        region=region_points,
        model=str(model_path),
        line_width=2,
        show=False,
        conf=args.conf,
        verbose=False,
    )
    speed_obj._save_without_speed = args.save_without_speed
    speed_obj._vid_fps = vfps
    speed_obj._proc_stride = float(max(1, args.stride))
    speed_obj._meter_per_pixel = max(1e-6, float(args.meter_per_pixel))
    speed_obj._max_speed_kmh = max(1.0, float(args.max_speed))
    speed_obj._speed_smooth = min(1.0, max(0.05, float(args.speed_smooth)))

    headless = os.environ.get("HEADLESS", "").strip() in ("1", "true", "yes")
    max_frames = int(os.environ.get("MAX_FRAMES", "0"))

    count = 0
    processed = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break

        count += 1
        stride = max(1, args.stride)
        if count % stride != 0:
            continue

        frame = cv2.resize(frame, (target_w, new_h))
        result = speed_obj.estimate_speed(frame)
        processed += 1

        if not headless:
            cv2.imshow("RGB", result)
            if cv2.waitKey(1) & 0xFF == ord("q"):
                break
        elif processed % 20 == 0:
            print(f"Headless: processed {processed} inference frames…")

        if max_frames > 0 and processed >= max_frames:
            print(f"Stopping after MAX_FRAMES={max_frames} processed frames.")
            break

    cap.release()
    if not headless:
        cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
