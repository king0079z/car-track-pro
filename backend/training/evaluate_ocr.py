#!/usr/bin/env python3
"""
Measure plate-OCR accuracy against a labeled crop set — the objective gate for
"world-class" plate reading.

Uses the EXACT production OCR (SpeedEstimator.perform_ocr + Qatar formatting) so
the numbers reflect what the live system reads. Reports:
  * exact-match accuracy (after Qatar normalization)
  * character error rate (CER, Levenshtein / length)
  * a list of the worst misses for inspection

Usage (from backend/):
  python training/evaluate_ocr.py --dataset training/ocr_dataset
  python training/evaluate_ocr.py --dataset training/ocr_dataset --csv labels.csv

The dataset folder must contain labels.csv (crop, predicted, ground_truth) and a
crops/ subfolder, as produced by training/harvest_plate_dataset.py.
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


def _levenshtein(a: str, b: str) -> int:
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def main() -> None:
    ap = argparse.ArgumentParser(description="Evaluate plate OCR accuracy")
    ap.add_argument("--dataset", default=str(BACKEND_DIR / "training" / "ocr_dataset"))
    ap.add_argument("--csv", default="labels.csv")
    ap.add_argument("--weights", default="", help="Detector weights (needed only to build the OCR object)")
    ap.add_argument("--worst", type=int, default=15, help="How many worst misses to print")
    args = ap.parse_args()

    ds = Path(args.dataset)
    labels_path = ds / args.csv
    crops_dir = ds / "crops"
    if not labels_path.is_file():
        raise SystemExit(f"labels.csv not found: {labels_path}. Run harvest_plate_dataset.py first.")

    from app.services.visionflow_engine import SpeedEstimator
    from app.services.visionflow_model import resolve_yolo_weights
    from app.utils.plates import format_qatar_plate

    weights = args.weights or (str(resolve_yolo_weights()) if resolve_yolo_weights() else None)
    if not weights:
        raise SystemExit("No detector weights; pass --weights (any YOLO .pt) to build the OCR object.")

    est = SpeedEstimator(model=weights, show=False, verbose=False)

    total = 0
    exact = 0
    cer_num = 0
    cer_den = 0
    misses: list[tuple[str, str, str]] = []

    with open(labels_path, newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            gt = format_qatar_plate("".join(c for c in str(row.get("ground_truth") or "").upper() if c.isalnum()))
            if not gt:
                continue  # unlabeled / discarded row
            crop_path = crops_dir / str(row.get("crop") or "")
            if not crop_path.is_file():
                continue
            img = cv2.imread(str(crop_path))
            if img is None:
                continue
            pred_raw, _conf = est.perform_ocr(img)
            pred = format_qatar_plate("".join(c for c in str(pred_raw).upper() if c.isalnum()))
            total += 1
            if pred == gt:
                exact += 1
            else:
                misses.append((str(row.get("crop")), gt, pred))
            cer_num += _levenshtein(pred, gt)
            cer_den += max(1, len(gt))

    if total == 0:
        raise SystemExit("No labeled rows found. Fill the 'ground_truth' column in labels.csv.")

    acc = 100.0 * exact / total
    cer = 100.0 * cer_num / cer_den
    print("\n── Plate OCR accuracy ─────────────────────────────")
    print(f"  Labeled crops      : {total}")
    print(f"  Exact-match acc.   : {acc:.1f}%  ({exact}/{total})")
    print(f"  Char error rate    : {cer:.1f}%")
    print(f"  Engine             : {getattr(est, '_ocr_engine', '?')}")
    if misses:
        print(f"\n  Worst {min(args.worst, len(misses))} misses (crop | truth | predicted):")
        for crop, gt, pred in misses[: args.worst]:
            print(f"    {crop:32s} {gt:12s} -> {pred or '(empty)'}")
    print("\nTarget for world-class: exact-match >= 97%, CER <= 2%.")


if __name__ == "__main__":
    main()
