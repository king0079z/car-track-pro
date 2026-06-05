"""
Reproduce the live plate pipeline on the tc.mp4 traffic clip and trace every
track through OCR + consolidation. Highlights the HGL car specifically.

Run:  python -m tools.repro_plate_trace
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

os.environ.setdefault("PLATE_DEBUG", "0")  # we capture the manifest directly instead

from app.services.visionflow_engine import analyze_video_path, default_analyze_args
from app.utils.plates import normalize_plate

UPLOADS = Path(__file__).resolve().parents[1] / "uploads"


def _pick_source() -> Path:
    candidates = sorted(UPLOADS.glob("*_tc.mp4"))
    raw = [p for p in candidates if "annotated" not in p.name]
    if not raw:
        raise SystemExit("No tc.mp4 source found in uploads/")
    # Largest = original source clip.
    return max(raw, key=lambda p: p.stat().st_size)


def main() -> None:
    src = _pick_source()
    print(f"[repro] source = {src.name} ({src.stat().st_size/1e6:.1f} MB)", flush=True)

    # Mirror the /vf/api/analyze defaults the UI uses.
    args = default_analyze_args(
        conf=0.16, iou=0.55, stride=2, width=1120,
        meter_per_pixel=0.05, max_speed=130.0, speed_smooth=0.38,
        fps=0.0, ocr_interval=1, min_ocr_conf=0.20,
    )
    os.environ["TRACK_IMGSZ"] = "1088"

    snapshots: list[list[dict]] = []

    def on_manifest(rows: list[dict]) -> None:
        snapshots.append([dict(r) for r in rows])

    def on_phase(msg: str) -> None:
        print(f"[phase] {msg}", flush=True)

    def on_progress(done: int, total: int) -> None:
        if done % 50 == 0:
            print(f"[progress] {done}/{total}", flush=True)

    result = analyze_video_path(
        src,
        args,
        output_video_path=None,
        progress_callback=on_progress,
        phase_callback=on_phase,
        manifest_callback=on_manifest,
        show_window=False,
        max_frames=0,
    )

    final = result.get("vehicles") or []
    print("\n================ FINAL MANIFEST ================", flush=True)
    for r in sorted(final, key=lambda x: float(x.get("t_enter_sec") or 0)):
        print(
            f"  #{r.get('track_id'):>4}  plate={str(r.get('plate')):<10}  "
            f"status={str(r.get('status')):<7}  conf={r.get('ocr_confidence')}  "
            f"votes={r.get('ocr_vote_count')}  seg={r.get('segment_count', 1)}  "
            f"dwell={r.get('duration_sec')}s",
            flush=True,
        )

    # HGL focus: did any track ever read an HGL-like plate during the run?
    print("\n================ HGL TRACE (per-snapshot) ================", flush=True)
    seen_hgl: dict[object, list[str]] = {}
    for snap in snapshots:
        for r in snap:
            plate = normalize_plate(str(r.get("plate") or ""))
            if "HGL" in plate or "HGN" in plate or "HG" in plate[-3:]:
                seen_hgl.setdefault(r.get("track_id"), [])
                if not seen_hgl[r.get("track_id")] or seen_hgl[r.get("track_id")][-1] != r.get("plate"):
                    seen_hgl[r.get("track_id")].append(str(r.get("plate")))
    if not seen_hgl:
        print("  No HGL-like plate ever appeared in any manifest snapshot.", flush=True)
    else:
        for tid, plates in seen_hgl.items():
            print(f"  track #{tid}: {' -> '.join(plates)}", flush=True)

    # Is HGL in the FINAL manifest?
    final_hgl = [r for r in final if "HGL" in normalize_plate(str(r.get("plate") or ""))]
    print(f"\n[result] HGL in final manifest: {len(final_hgl)} row(s)", flush=True)
    for r in final_hgl:
        print(f"   -> #{r.get('track_id')} {r.get('plate')} ({r.get('status')})", flush=True)

    out = Path(__file__).resolve().parent / "repro_last_manifest.json"
    out.write_text(json.dumps(final, indent=2, default=str), encoding="utf-8")
    print(f"\n[repro] final manifest written to {out}", flush=True)


if __name__ == "__main__":
    sys.exit(main())
