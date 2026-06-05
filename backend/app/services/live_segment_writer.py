"""Time-based segment rotation for indefinite live recording."""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import cv2

from .video_writer_util import NullVideoWriter, even_size, open_video_writer

_log = logging.getLogger(__name__)


class SegmentedVideoWriter:
    """Writes annotated frames into hourly (configurable) segments."""

    def __init__(
        self,
        output_dir: Path,
        *,
        fps: float,
        size: tuple[int, int],
        segment_seconds: float = 3600.0,
        prefer_fast_encoder: bool = False,
    ) -> None:
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.fps = max(8.0, min(60.0, float(fps)))
        self.size = even_size(size)
        self.segment_seconds = max(60.0, float(segment_seconds))
        self.prefer_fast_encoder = prefer_fast_encoder
        self._writer: cv2.VideoWriter | Any | None = None
        self._segment_started = 0.0
        self.segment_names: list[str] = []
        self.recording_enabled = True
        self.last_error: str | None = None

    def _open_next(self) -> bool:
        self._close_current()
        ts = datetime.now(UTC).strftime("%Y%m%d_%H%M%S")
        path = self.output_dir / f"segment_{ts}.mp4"
        writer, actual = open_video_writer(
            path,
            fps=self.fps,
            size=self.size,
            prefer_fast_encoder=self.prefer_fast_encoder,
        )
        if writer is None:
            self.recording_enabled = False
            self.last_error = f"Recording unavailable (no codec) — live analysis continues without video."
            _log.warning(self.last_error)
            return False
        self._writer = writer
        self._segment_started = datetime.now(UTC).timestamp()
        self.segment_names.append(actual.name)
        _log.info("Live segment opened: %s", actual.name)
        return True

    def _close_current(self) -> None:
        if self._writer is not None:
            try:
                self._writer.release()
            except Exception:
                pass
            self._writer = None

    def write(self, frame: Any) -> None:
        if not self.recording_enabled:
            return
        now = datetime.now(UTC).timestamp()
        if self._writer is None or (now - self._segment_started) >= self.segment_seconds:
            if not self._open_next():
                return
        if self._writer is None:
            return
        try:
            self._writer.write(frame)
        except Exception as exc:
            self.recording_enabled = False
            self.last_error = f"Recording stopped: {exc}"
            _log.warning(self.last_error)
            self._close_current()

    def close(self) -> None:
        self._close_current()

    @property
    def latest_segment(self) -> str | None:
        return self.segment_names[-1] if self.segment_names else None
