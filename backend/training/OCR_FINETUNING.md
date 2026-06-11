# Qatar plate accuracy — measure & improve

The live system reads plates with a **detector** (YOLO, `models/*.pt`) plus an
**OCR engine** (`fast-plate-ocr`, global model) and Qatar-specific post-processing
in `app/utils/plates.py`. The global OCR model is the accuracy ceiling for Qatar
plates; this folder gives you a repeatable loop to **measure** accuracy on your own
footage and **improve** it.

## The loop

```
footage ──► harvest_plate_dataset.py ──► ocr_dataset/ (crops + labels.csv)
                                              │ (you correct ground_truth)
                                              ▼
                                      evaluate_ocr.py ──► accuracy %, CER, worst misses
                                              │
                         ┌────────────────────┼─────────────────────┐
                         ▼                    ▼                     ▼
             tune thresholds         re-label & retrain        train a custom
             (no training)           the DETECTOR               OCR model
```

### 1. Harvest a real dataset

```bash
cd backend
python training/harvest_plate_dataset.py --video samples/gate.mp4 --out training/ocr_dataset --max 400
```

This detects plates, saves crops to `training/ocr_dataset/crops/`, and writes
`labels.csv` with a `predicted` column (the current model's guess) and an empty
`ground_truth` column.

### 2. Correct the labels

Open `training/ocr_dataset/labels.csv` and fill `ground_truth` with the true plate
(use the same shape the app shows, e.g. `12345 ABC`). Leave a row blank to drop a
bad/unclear crop. Aim for **300+ correct rows** spanning day/night, angles, dirty
and reflective plates.

### 3. Measure (the objective gate)

```bash
python training/evaluate_ocr.py --dataset training/ocr_dataset
```

Reports exact-match accuracy, character error rate (CER), and the worst misses
using the **exact production OCR path**. World-class target: **≥ 97% exact match,
≤ 2% CER**.

## Improving accuracy (in order of effort)

1. **Tune thresholds — no training.** If misses are mostly empty/low-confidence,
   adjust in `.env`:
   - `PLATE_OCR_ENGINE` (`fast_plate` vs `easyocr`)
   - `FAST_PLATE_MODEL` (`cct-s-v2-global-model` accuracy vs `cct-xs-v2-global-model` speed)
   - `PLATE_STRICT_JURISDICTION`, `PLATE_JURISDICTION`
   Re-run `evaluate_ocr.py` after each change.

2. **Improve the detector** (fixes crops that are cut off / missed). Re-label your
   harvested frames in a tool like Roboflow/Label Studio (boxes around plates),
   export YOLO format, point `training/plates.yaml` at it, then:
   ```bash
   python training/train_plate_detector.py --data training/plates.yaml --base yolo26s.pt --epochs 100 --install
   ```
   Better, tighter plate boxes = better OCR input.

3. **Train a Qatar-specific OCR model** (highest ceiling). `fast-plate-ocr` supports
   training custom models; follow its docs with your corrected `labels.csv`
   (crop image → plate string). Install the resulting model name into
   `FAST_PLATE_MODEL`. Keep a held-out split and confirm gains with `evaluate_ocr.py`.

## Notes

- `training/ocr_dataset/` is git-ignored (it holds footage-derived images).
- Re-run the harvester on new sites/cameras; accuracy is per-deployment.
- Speed accuracy is separate — set each camera's **metres-per-pixel** in
  Settings → Cameras (per-camera calibration), not here.
