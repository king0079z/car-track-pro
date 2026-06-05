"""Watchdog for 24/7 live camera sessions — auto-resume on crash and server reboot."""

from __future__ import annotations

import logging
import threading
import time
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Callable

from ..config import settings
from . import live_persistence as persist

_log = logging.getLogger(__name__)

StartLiveFn = Callable[..., None]


class LiveSupervisor:
    """Keeps always-on live sessions running and cleans old segment files."""

    def __init__(self) -> None:
        self._db_path: Path | None = None
        self._output_dir: Path | None = None
        self._start_fn: StartLiveFn | None = None
        self._jobs_lock: threading.Lock | None = None
        self._jobs: dict[str, dict] | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._started = False
        self._started_session_ids: set[str] = set()
        self._lock = threading.Lock()

    def bind(
        self,
        *,
        db_path: Path,
        output_dir: Path,
        start_fn: StartLiveFn,
        jobs_lock: threading.Lock,
        jobs: dict[str, dict],
    ) -> None:
        self._db_path = db_path
        self._output_dir = output_dir
        self._start_fn = start_fn
        self._jobs_lock = jobs_lock
        self._jobs = jobs
        persist.init_db(db_path)

    def start(self) -> None:
        if not settings.LIVE_24_7_ENABLED or self._started:
            return
        self._started = True
        self._thread = threading.Thread(target=self._loop, name="live-supervisor", daemon=True)
        self._thread.start()
        _log.info("Live 24/7 supervisor started")

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5.0)

    def register_and_start(
        self,
        session_id: str,
        source: str,
        label: str,
        opts: dict[str, Any],
        *,
        record: bool = True,
        slot_index: int | None = None,
        exclusive: bool = True,
    ) -> str:
        """Persist session and queue a live job. Returns new job_id."""
        assert self._db_path is not None
        if slot_index is not None:
            persist.disable_sessions_for_slot(
                self._db_path, int(slot_index), keep_session_id=session_id
            )
            persist.disable_sessions_for_source(
                self._db_path, source, keep_session_id=session_id
            )
        elif exclusive:
            persist.disable_all_except(self._db_path, session_id)
        job_id = uuid.uuid4().hex
        persist.upsert_session(
            self._db_path,
            session_id,
            source=source,
            label=label,
            opts=opts,
            enabled=True,
            always_on=True,
            record=record,
            job_id=job_id,
            slot_index=slot_index,
        )
        self._submit(session_id, job_id, source, label, opts, record=record)
        return job_id

    def disable(self, session_id: str) -> None:
        assert self._db_path is not None
        persist.disable_session(self._db_path, session_id)

    def list_sessions(self, *, enabled_only: bool = False) -> list[dict[str, Any]]:
        assert self._db_path is not None
        return persist.list_sessions(self._db_path, enabled_only=enabled_only)

    def _mark_started(self, session_id: str) -> None:
        with self._lock:
            self._started_session_ids.add(session_id)

    def _should_supervise(self, session_id: str) -> bool:
        """Only restart/monitor sessions started this boot unless resume-on-startup is enabled."""
        if settings.LIVE_RESUME_ON_STARTUP:
            return True
        with self._lock:
            return session_id in self._started_session_ids

    def _submit(
        self,
        session_id: str,
        job_id: str,
        source: str,
        label: str,
        opts: dict[str, Any],
        *,
        record: bool,
    ) -> None:
        if self._start_fn is None:
            return
        self._mark_started(session_id)
        out_dir = None
        if record and self._output_dir is not None:
            out_dir = self._output_dir / f"{session_id}_live"
        self._start_fn(
            job_id,
            source,
            out_dir,
            opts,
            always_on=True,
            session_id=session_id,
            input_label=label,
        )

    def _loop(self) -> None:
        if settings.LIVE_RESUME_ON_STARTUP:
            time.sleep(max(2.0, float(settings.LIVE_STARTUP_DELAY_SEC)))
            self._resume_all()

        interval = max(5.0, float(settings.LIVE_SUPERVISOR_INTERVAL_SEC))
        while not self._stop.wait(interval):
            try:
                self._watch_sessions()
                self._purge_old_segments()
            except Exception:
                _log.exception("Live supervisor tick failed")

    def _resume_all(self) -> None:
        assert self._db_path is not None
        from .live_camera import normalize_live_source

        removed = persist.dedupe_by_source(self._db_path)
        if removed:
            _log.info("Disabled %d duplicate always-on session(s) for the same camera/source", removed)

        max_cams = max(1, int(settings.LIVE_MAX_CAMERAS))
        resumed_sources: set[str] = set()
        resumed = 0
        stagger = max(0.0, float(settings.LIVE_GRID_RESUME_STAGGER_SEC))

        for sess in persist.list_sessions(self._db_path, enabled_only=True):
            if not sess.get("always_on"):
                continue
            sid = str(sess["session_id"])
            if not self._should_supervise(sid):
                continue
            src_key = normalize_live_source(sess["source"])
            if src_key in resumed_sources:
                continue
            if resumed >= max_cams:
                persist.disable_session(self._db_path, sess["session_id"])
                continue

            sid = sess["session_id"]
            job_id = sess.get("job_id")
            if job_id and self._is_job_running(job_id):
                resumed_sources.add(src_key)
                resumed += 1
                continue

            if resumed > 0 and stagger > 0:
                _log.info("Staggering live resume %.0fs before session %s", stagger, sid)
                time.sleep(stagger)

            new_job = uuid.uuid4().hex
            persist.set_session_job(self._db_path, sid, new_job)
            slot = sess.get("slot_index")
            _log.info(
                "Resuming always-on live session %s (slot=%s source=%s) as job %s",
                sid,
                slot,
                src_key,
                new_job,
            )
            self._submit(
                sid,
                new_job,
                sess["source"],
                sess.get("label") or f"Live: {sess['source'][:80]}",
                sess.get("opts") or {},
                record=bool(sess.get("record", True)),
            )
            self._mark_started(sid)
            resumed_sources.add(src_key)
            resumed += 1

    def _watch_sessions(self) -> None:
        assert self._db_path is not None
        stale_sec = max(30.0, float(settings.LIVE_STALE_FRAME_SEC))
        now = datetime.now(UTC)

        for sess in persist.list_sessions(self._db_path, enabled_only=True):
            if not sess.get("always_on"):
                continue
            sid = str(sess["session_id"])
            if not self._should_supervise(sid):
                continue
            job_id = sess.get("job_id")
            if not job_id:
                self._restart_session(sess)
                continue

            job = self._get_job(job_id)
            if job is None:
                self._restart_session(sess)
                continue

            status = str(job.get("status") or "")
            if status in ("error", "done"):
                _log.warning(
                    "Always-on session %s job %s ended (%s) — restarting",
                    sess["session_id"],
                    job_id,
                    status,
                )
                self._restart_session(sess)
                continue

            if status != "running":
                continue

            health = job.get("live_health") or {}
            last_at = health.get("last_frame_at")
            if not last_at:
                continue
            try:
                last_dt = datetime.fromisoformat(str(last_at).replace("Z", "+00:00"))
                if last_dt.tzinfo is None:
                    last_dt = last_dt.replace(tzinfo=UTC)
            except Exception:
                continue
            age = (now - last_dt).total_seconds()
            if age > stale_sec:
                _log.warning(
                    "Always-on session %s stale (%.0fs without frames) — restarting job %s",
                    sess["session_id"],
                    age,
                    job_id,
                )
                self._restart_session(sess, stop_job_id=job_id)

    def _restart_session(self, sess: dict[str, Any], *, stop_job_id: str | None = None) -> None:
        assert self._db_path is not None
        if stop_job_id:
            self._request_stop(stop_job_id)
            time.sleep(2.0)
        new_job = uuid.uuid4().hex
        sid = sess["session_id"]
        persist.set_session_job(self._db_path, sid, new_job)
        self._submit(
            sid,
            new_job,
            sess["source"],
            sess.get("label") or f"Live: {sess['source'][:80]}",
            sess.get("opts") or {},
            record=bool(sess.get("record", True)),
        )

    def _request_stop(self, job_id: str) -> None:
        from ..routers import visionflow as vf

        ev = vf._live_stop_events.get(job_id)
        if ev is not None:
            ev.set()

    def _is_job_running(self, job_id: str) -> bool:
        job = self._get_job(job_id)
        return job is not None and str(job.get("status")) in ("queued", "running")

    def _get_job(self, job_id: str) -> dict[str, Any] | None:
        if self._jobs_lock is None or self._jobs is None:
            return None
        with self._jobs_lock:
            j = self._jobs.get(job_id)
            return dict(j) if j else None

    def _purge_old_segments(self) -> None:
        if self._output_dir is None:
            return
        days = max(1, int(settings.LIVE_SEGMENT_RETENTION_DAYS))
        cutoff = datetime.now(UTC) - timedelta(days=days)
        for d in self._output_dir.glob("*_live"):
            if not d.is_dir():
                continue
            for seg in d.glob("segment_*.mp4"):
                try:
                    mtime = datetime.fromtimestamp(seg.stat().st_mtime, tz=UTC)
                    if mtime < cutoff:
                        seg.unlink(missing_ok=True)
                        _log.info("Purged old live segment: %s", seg.name)
                except Exception:
                    pass
            try:
                if d.is_dir() and not any(d.iterdir()):
                    d.rmdir()
            except Exception:
                pass


_supervisor = LiveSupervisor()


def get_live_supervisor() -> LiveSupervisor:
    return _supervisor
