"""
Persist web analysis jobs to SQLite so history survives refresh and server restart.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_db_lock = threading.Lock()


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def init_db(db_path: Path) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with _db_lock:
        conn = sqlite3.connect(str(db_path))
        try:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS analyses (
                    job_id TEXT PRIMARY KEY,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    input_name TEXT NOT NULL,
                    status TEXT NOT NULL,
                    message TEXT,
                    progress REAL DEFAULT 0,
                    processed_frames INTEGER DEFAULT 0,
                    output_file TEXT,
                    vehicles_json TEXT,
                    error_detail TEXT,
                    video_fps REAL,
                    options_json TEXT,
                    total_frames_est INTEGER DEFAULT 0
                )
                """
            )
            cols = {row[1] for row in conn.execute("PRAGMA table_info(analyses)").fetchall()}
            if "options_json" not in cols:
                conn.execute("ALTER TABLE analyses ADD COLUMN options_json TEXT")
            if "total_frames_est" not in cols:
                conn.execute("ALTER TABLE analyses ADD COLUMN total_frames_est INTEGER DEFAULT 0")
            conn.commit()
        finally:
            conn.close()


def save_snapshot(db_path: Path, job_id: str, payload: dict[str, Any]) -> None:
    """Upsert job row from in-memory job dict."""
    now = _utc_now_iso()
    vehicles = payload.get("vehicles") or []
    vehicles_json = json.dumps(vehicles, ensure_ascii=False)
    with _db_lock:
        conn = sqlite3.connect(str(db_path))
        try:
            cur = conn.execute("SELECT created_at FROM analyses WHERE job_id = ?", (job_id,))
            row = cur.fetchone()
            created_at = row[0] if row else now
            err = payload.get("error_detail")
            if payload.get("status") == "error" and err:
                err = str(err)[:8000]
            opts = payload.get("analyze_options")
            opts_json = json.dumps(opts, ensure_ascii=False) if isinstance(opts, dict) else None
            conn.execute(
                """
                INSERT INTO analyses (
                    job_id, created_at, updated_at, input_name, status, message,
                    progress, processed_frames, output_file, vehicles_json, error_detail, video_fps,
                    options_json, total_frames_est
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(job_id) DO UPDATE SET
                    updated_at = excluded.updated_at,
                    input_name = excluded.input_name,
                    status = excluded.status,
                    message = excluded.message,
                    progress = excluded.progress,
                    processed_frames = excluded.processed_frames,
                    output_file = excluded.output_file,
                    vehicles_json = excluded.vehicles_json,
                    error_detail = excluded.error_detail,
                    video_fps = excluded.video_fps,
                    options_json = excluded.options_json,
                    total_frames_est = excluded.total_frames_est
                """,
                (
                    job_id,
                    created_at,
                    now,
                    payload.get("input_name", ""),
                    payload.get("status", "unknown"),
                    payload.get("message") or "",
                    float(payload.get("progress") or 0),
                    int(payload.get("processed_frames") or 0),
                    payload.get("output_file"),
                    vehicles_json,
                    err,
                    payload.get("video_fps"),
                    opts_json,
                    int(payload.get("total_frames_est") or 0),
                ),
            )
            conn.commit()
        finally:
            conn.close()


def get_job(db_path: Path, job_id: str) -> dict[str, Any] | None:
    with _db_lock:
        conn = sqlite3.connect(str(db_path))
        conn.row_factory = sqlite3.Row
        try:
            cur = conn.execute("SELECT * FROM analyses WHERE job_id = ?", (job_id,))
            row = cur.fetchone()
            if row is None:
                return None
            d = dict(row)
            try:
                d["vehicles"] = json.loads(d.pop("vehicles_json") or "[]")
            except json.JSONDecodeError:
                d["vehicles"] = []
            if d.get("error_detail"):
                d["error_detail"] = str(d["error_detail"])[:2000]
            raw_opts = d.pop("options_json", None)
            if raw_opts:
                try:
                    d["analyze_options"] = json.loads(raw_opts)
                except json.JSONDecodeError:
                    d["analyze_options"] = None
            else:
                d["analyze_options"] = None
            return d
        finally:
            conn.close()


def list_recent(db_path: Path, limit: int = 100) -> list[dict[str, Any]]:
    limit = max(1, min(500, int(limit)))
    with _db_lock:
        conn = sqlite3.connect(str(db_path))
        conn.row_factory = sqlite3.Row
        try:
            cur = conn.execute(
                """
                SELECT job_id, created_at, updated_at, input_name, status, message,
                       progress, processed_frames, output_file, vehicles_json, error_detail
                FROM analyses
                ORDER BY datetime(updated_at) DESC
                LIMIT ?
                """,
                (limit,),
            )
            out: list[dict[str, Any]] = []
            for row in cur.fetchall():
                d = dict(row)
                vraw = d.pop("vehicles_json", None) or "[]"
                try:
                    vehicles = json.loads(vraw)
                except json.JSONDecodeError:
                    vehicles = []
                d["vehicle_count"] = len(vehicles)
                # Full plate/track list for Analysis history UI (already parsed from DB)
                d["vehicles"] = vehicles
                d["plates_preview"] = ", ".join(
                    str(v.get("plate", "")) for v in vehicles[:6]
                    if v.get("plate") and str(v.get("plate")) not in ("…", "—")
                )[:220]
                d["has_video"] = bool(d.get("output_file"))
                d.pop("error_detail", None)
                out.append(d)
            return out
        finally:
            conn.close()
