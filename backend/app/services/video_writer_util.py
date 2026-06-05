"""OpenCV VideoWriter helpers — robust codec fallbacks for Windows/Linux."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import cv2
import numpy as np

_log = logging.getLogger(__name__)


def even_size(size: tuple[int, int]) -> tuple[int, int]:
    w, h = int(size[0]), int(size[1])
    w = max(2, w - (w % 2))
    h = max(2, h - (h % 2))
    return w, h


def _fourcc(code: str) -> int:
    c = (code + "    ")[:4]
    return cv2.VideoWriter_fourcc(*c)


def open_video_writer(
    path: Path,
    *,
    fps: float,
    size: tuple[int, int],
    prefer_fast_encoder: bool = False,
) -> tuple[cv2.VideoWriter | None, Path]:
    """
    Try several codecs/containers until one accepts frames on this host.
    Returns (writer, actual_path) or (None, path).
    """
    w, h = even_size(size)
    fps = max(1.0, min(60.0, float(fps)))
    base = path.with_suffix("")
    attempts: list[tuple[Path, str]] = []
    if prefer_fast_encoder:
        attempts.extend([
            (base.with_suffix(".avi"), "MJPG"),
            (base.with_suffix(".mp4"), "mp4v"),
            (base.with_suffix(".avi"), "XVID"),
        ])
    else:
        attempts.extend([
            (base.with_suffix(".mp4"), "mp4v"),
            (base.with_suffix(".mp4"), "MP4V"),
            (base.with_suffix(".avi"), "MJPG"),
            (base.with_suffix(".avi"), "XVID"),
            (base.with_suffix(".mp4"), "avc1"),
        ])

    probe = np.zeros((h, w, 3), dtype=np.uint8)
    for out_path, codec in attempts:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        writer = cv2.VideoWriter(str(out_path), _fourcc(codec), fps, (w, h))
        if not writer.isOpened():
            writer.release()
            continue
        try:
            writer.write(probe)
        except Exception:
            writer.release()
            try:
                out_path.unlink(missing_ok=True)
            except Exception:
                pass
            continue
        _log.info("VideoWriter opened: %s (%s, %dx%d @ %.1f fps)", out_path.name, codec, w, h, fps)
        return writer, out_path

    _log.warning("No VideoWriter codec worked for %s (%dx%d)", path, w, h)
    return None, path


class NullVideoWriter:
    """No-op writer when disk recording is unavailable."""

    def write(self, frame: Any) -> None:
        pass

    def release(self) -> None:
        pass

    def isOpened(self) -> bool:
        return False
