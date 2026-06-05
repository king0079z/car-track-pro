#!/usr/bin/env python3
"""
Fine-tune Ultralytics YOLO26 on a license-plate dataset.

Usage (from backend/):
  python training/train_plate_detector.py --data training/plates.yaml.example
  python training/train_plate_detector.py --base yolo26s.pt --epochs 100 --imgsz 1280

After training, copy the best checkpoint:
  copy runs/detect/plates_yolo26/weights/best.pt models/yolo26_best.pt

Requires: pip install ultralytics>=8.4.0
"""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
MODELS_DIR = BACKEND_DIR / "models"


def main() -> None:
    parser = argparse.ArgumentParser(description="Train YOLO26 plate detector")
    parser.add_argument(
        "--data",
        default=str(BACKEND_DIR / "training" / "plates.yaml.example"),
        help="Dataset YAML (see plates.yaml.example)",
    )
    parser.add_argument(
        "--base",
        default="yolo26s.pt",
        help="Base weights: yolo26n.pt (CPU/fast), yolo26s.pt (balanced), yolo26m.pt (accuracy)",
    )
    parser.add_argument("--epochs", type=int, default=100)
    parser.add_argument("--imgsz", type=int, default=1280)
    parser.add_argument("--batch", type=int, default=16)
    parser.add_argument("--device", default="", help="cuda:0, cpu, or empty for auto")
    parser.add_argument("--name", default="plates_yolo26")
    parser.add_argument(
        "--install",
        action="store_true",
        help="Copy best.pt to backend/models/yolo26_best.pt when done",
    )
    args = parser.parse_args()

    from ultralytics import YOLO

    model = YOLO(args.base)
    results = model.train(
        data=args.data,
        epochs=args.epochs,
        imgsz=args.imgsz,
        batch=args.batch,
        device=args.device or None,
        name=args.name,
        project=str(BACKEND_DIR / "runs" / "detect"),
        exist_ok=True,
    )

    best = Path(results.save_dir) / "weights" / "best.pt"
    print(f"\nTraining complete. Best weights: {best}")

    if args.install and best.is_file():
        MODELS_DIR.mkdir(parents=True, exist_ok=True)
        dest = MODELS_DIR / "yolo26_best.pt"
        shutil.copy2(best, dest)
        print(f"Installed to {dest}")


if __name__ == "__main__":
    main()
