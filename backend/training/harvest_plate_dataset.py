#!/usr/bin/env python3
"""
Harvest a Qatar plate OCR dataset from real footage.

Runs the plate DETECTOR over a video, crops every detected plate, and writes the
crops plus the current model's OCR guess into a folder with a ``labels.csv`` you
then correct by hand. The corrected set feeds:
  * OCR accuracy measurement       -> training/evaluate_ocr.py
  * detector fine-tuning (re-label) -> training/train_plate_detector.py

Usage (from backend/):
  python training/harvest_plate_dataset.py --video samples/gate.mp4 --out training/ocr_dataset
  python training/harvest_plate_dataset.py --video rtsp://... --max 400 --stride 5

Then open training/ocr_dataset/labels.csv and fill the ``ground_truth`` column
(leave a row blank to discard that crop), and run evaluate_ocr.py.

Requires: ultralytics, opencv-python(-headless); fast-plate-ocr/easyocr optional (for prefill).
"""

from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import cv2  # noqa: E402


def _resolve_weights(explicit: str | None) -> str:
    if explicit:
        return explicit
    from app.services.visionflow_model import resolve_yolo_weights

    w = resolve_yolo_weights()
    if not w:
        raise SystemExit(
            "No plate detector weights found. Put best.pt/yolo26_best.pt in backend/models/ "
            "or pass --weights."
        )
    return str(w)


def _pad_crop(frame, box, pad: float = 0.12):
    h, w = frame.shape[:2]
    x1, y1, x2, y2 = box
    bw, bh = x2 - x1, y2 - y1
    x1 = max(0, int(x1 - bw * pad))
    y1 = max(0, int(y1 - bh * pad))
    x2 = min(w, int(x2 + bw * pad))
    y2 = min(h, int(y2 + bh * pad))
    if x2 <= x1 or y2 <= y1:
        return None
    return frame[y1:y2, x1:x2]


def main() -> None:
    ap = argparse.ArgumentParser(description="Harvest plate crops for OCR labeling")
    ap.add_argument("--video", required=True, help="Video file or RTSP URL")
    ap.add_argument("--out", default=str(BACKEND_DIR / "training" / "ocr_dataset"))
    ap.add_argument("--weights", default="", help="Detector weights (default: auto-resolve)")
    ap.add_argument("--stride", type=int, default=5, help="Process every Nth frame")
    ap.add_argument("--conf", type=float, default=0.20)
    ap.add_argument("--imgsz", type=int, default=1280)
    ap.add_argument("--max", type=int, default=500, help="Max crops to save")
    ap.add_argument("--min-side", type=int, default=20, help="Skip crops smaller than this (px)")
    args = ap.parse_args()

    from ultralytics import YOLO

    weights = _resolve_weights(args.weights or None)
    model = YOLO(weights)

    # Optional OCR prefill (best effort; labeling is still manual).
    prefill = None
    try:
        from fast_plate_ocr import LicensePlateRecognizer

        from app.config import settings
        from app.utils.plates import format_qatar_plate

        reader = LicensePlateRecognizer(settings.FAST_PLATE_MODEL)

        def prefill(crop):  # noqa: ANN001
            rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
            try:
                res = reader.run(rgb)
            except Exception:
                return ""
            item = res[0] if isinstance(res, (list, tuple)) and res else res
            raw = getattr(item, "plate", None) or (item if isinstance(item, str) else str(item))
            return format_qatar_plate("".join(c for c in str(raw).upper() if c.isalnum()))
    except Exception:
        prefill = None

    out_dir = Path(args.out)
    crops_dir = out_dir / "crops"
    crops_dir.mkdir(parents=True, exist_ok=True)
    labels_path = out_dir / "labels.csv"

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        raise SystemExit(f"Could not open video: {args.video}")

    rows: list[tuple[str, str, str]] = []
    frame_no = 0
    saved = 0
    while saved < args.max:
        ok, frame = cap.read()
        if not ok:
            break
        frame_no += 1
        if frame_no % max(1, args.stride) != 0:
            continue
        results = model.predict(frame, conf=args.conf, imgsz=args.imgsz, verbose=False)
        for r in results:
            for b in (r.boxes or []):
                xyxy = [float(v) for v in b.xyxy[0].tolist()]
                crop = _pad_crop(frame, xyxy)
                if crop is None:
                    continue
                ch, cw = crop.shape[:2]
                if min(ch, cw) < args.min_side:
                    continue
                fname = f"plate_{frame_no:06d}_{saved:04d}.png"
                cv2.imwrite(str(crops_dir / fname), crop)
                guess = prefill(crop) if prefill else ""
                rows.append((fname, guess, ""))
                saved += 1
                if saved >= args.max:
                    break
            if saved >= args.max:
                break
    cap.release()

    with open(labels_path, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["crop", "predicted", "ground_truth"])
        w.writerows(rows)

    print(f"Saved {saved} crops -> {crops_dir}")
    print(f"Labels CSV -> {labels_path}")
    print("Next: fill the 'ground_truth' column, then run training/evaluate_ocr.py")


if __name__ == "__main__":
    main()
