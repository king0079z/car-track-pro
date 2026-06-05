"""SQLite persistence for always-on live camera sessions."""

from __future__ import annotations

import json
import sqlite3
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

_db_lock = threading.Lock()


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def init_db(db_path: Path) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with _db_lock:
        conn = sqlite3.connect(str(db_path))
        try:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS live_sessions (
                    session_id TEXT PRIMARY KEY,
                    source TEXT NOT NULL,
                    label TEXT NOT NULL,
                    enabled INTEGER NOT NULL DEFAULT 1,
                    always_on INTEGER NOT NULL DEFAULT 1,
                    record INTEGER NOT NULL DEFAULT 1,
                    job_id TEXT,
                    slot_index INTEGER,
                    opts_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            cols = {row[1] for row in conn.execute("PRAGMA table_info(live_sessions)").fetchall()}
            if "slot_index" not in cols:
                conn.execute("ALTER TABLE live_sessions ADD COLUMN slot_index INTEGER")
            conn.commit()
        finally:
            conn.close()


def upsert_session(
    db_path: Path,
    session_id: str,
    *,
    source: str,
    label: str,
    opts: dict[str, Any],
    enabled: bool = True,
    always_on: bool = True,
    record: bool = True,
    job_id: str | None = None,
    slot_index: int | None = None,
) -> None:
    now = _now_iso()
    with _db_lock:
        conn = sqlite3.connect(str(db_path))
        try:
            row = conn.execute(
                "SELECT created_at FROM live_sessions WHERE session_id = ?",
                (session_id,),
            ).fetchone()
            created = row[0] if row else now
            conn.execute(
                """
                INSERT INTO live_sessions (
                    session_id, source, label, enabled, always_on, record, job_id,
                    slot_index, opts_json, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(session_id) DO UPDATE SET
                    source = excluded.source,
                    label = excluded.label,
                    enabled = excluded.enabled,
                    always_on = excluded.always_on,
                    record = excluded.record,
                    job_id = excluded.job_id,
                    slot_index = excluded.slot_index,
                    opts_json = excluded.opts_json,
                    updated_at = excluded.updated_at
                """,
                (
                    session_id,
                    source,
                    label,
                    1 if enabled else 0,
                    1 if always_on else 0,
                    1 if record else 0,
                    job_id,
                    slot_index,
                    json.dumps(opts),
                    created,
                    now,
                ),
            )
            conn.commit()
        finally:
            conn.close()


def set_session_job(db_path: Path, session_id: str, job_id: str | None) -> None:
    with _db_lock:
        conn = sqlite3.connect(str(db_path))
        try:
            conn.execute(
                "UPDATE live_sessions SET job_id = ?, updated_at = ? WHERE session_id = ?",
                (job_id, _now_iso(), session_id),
            )
            conn.commit()
        finally:
            conn.close()


def disable_all_enabled(db_path: Path) -> int:
    """Disable every enabled always-on session (returns count disabled)."""
    with _db_lock:
        conn = sqlite3.connect(str(db_path))
        try:
            cur = conn.execute(
                """
                UPDATE live_sessions
                SET enabled = 0, always_on = 0, updated_at = ?
                WHERE enabled = 1
                """,
                (_now_iso(),),
            )
            conn.commit()
            return int(cur.rowcount or 0)
        finally:
            conn.close()


def disable_all_except(db_path: Path, keep_session_id: str) -> int:
    """Disable all enabled sessions except ``keep_session_id``."""
    with _db_lock:
        conn = sqlite3.connect(str(db_path))
        try:
            cur = conn.execute(
                """
                UPDATE live_sessions
                SET enabled = 0, always_on = 0, updated_at = ?
                WHERE enabled = 1 AND session_id != ?
                """,
                (_now_iso(), keep_session_id),
            )
            conn.commit()
            return int(cur.rowcount or 0)
        finally:
            conn.close()


def dedupe_by_source(db_path: Path) -> int:
    """
    Keep only the newest enabled session per camera/source; disable older duplicates.
    Prevents multiple 24/7 jobs fighting over the same USB webcam on Windows.
    """
    from .live_camera import normalize_live_source

    with _db_lock:
        conn = sqlite3.connect(str(db_path))
        try:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                """
                SELECT session_id, source, updated_at
                FROM live_sessions
                WHERE enabled = 1 AND always_on = 1
                ORDER BY updated_at DESC
                """
            ).fetchall()
            keep: set[str] = set()
            disabled = 0
            for row in rows:
                key = normalize_live_source(row["source"])
                if key in keep:
                    conn.execute(
                        """
                        UPDATE live_sessions
                        SET enabled = 0, always_on = 0, updated_at = ?
                        WHERE session_id = ?
                        """,
                        (_now_iso(), row["session_id"]),
                    )
                    disabled += 1
                else:
                    keep.add(key)
            conn.commit()
            return disabled
        finally:
            conn.close()


def disable_sessions_for_slot(
    db_path: Path,
    slot_index: int,
    *,
    keep_session_id: str | None = None,
) -> int:
    """Disable enabled sessions bound to a grid slot (except ``keep_session_id``)."""
    with _db_lock:
        conn = sqlite3.connect(str(db_path))
        try:
            if keep_session_id:
                cur = conn.execute(
                    """
                    UPDATE live_sessions
                    SET enabled = 0, always_on = 0, updated_at = ?
                    WHERE enabled = 1 AND slot_index = ? AND session_id != ?
                    """,
                    (_now_iso(), int(slot_index), keep_session_id),
                )
            else:
                cur = conn.execute(
                    """
                    UPDATE live_sessions
                    SET enabled = 0, always_on = 0, updated_at = ?
                    WHERE enabled = 1 AND slot_index = ?
                    """,
                    (_now_iso(), int(slot_index)),
                )
            conn.commit()
            return int(cur.rowcount or 0)
        finally:
            conn.close()


def disable_sessions_for_source(
    db_path: Path,
    source: str,
    *,
    keep_session_id: str | None = None,
) -> int:
    """Disable enabled sessions for the same normalized camera source."""
    from .live_camera import normalize_live_source

    norm = normalize_live_source(source)
    with _db_lock:
        conn = sqlite3.connect(str(db_path))
        try:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                "SELECT session_id, source FROM live_sessions WHERE enabled = 1"
            ).fetchall()
            disabled = 0
            for row in rows:
                if keep_session_id and row["session_id"] == keep_session_id:
                    continue
                if normalize_live_source(row["source"]) != norm:
                    continue
                conn.execute(
                    """
                    UPDATE live_sessions
                    SET enabled = 0, always_on = 0, updated_at = ?
                    WHERE session_id = ?
                    """,
                    (_now_iso(), row["session_id"]),
                )
                disabled += 1
            conn.commit()
            return disabled
        finally:
            conn.close()


def get_session_by_slot(db_path: Path, slot_index: int) -> dict[str, Any] | None:
    """Newest enabled session for a grid slot, if any."""
    with _db_lock:
        conn = sqlite3.connect(str(db_path))
        try:
            conn.row_factory = sqlite3.Row
            row = conn.execute(
                """
                SELECT * FROM live_sessions
                WHERE slot_index = ? AND enabled = 1 AND always_on = 1
                ORDER BY updated_at DESC
                LIMIT 1
                """,
                (int(slot_index),),
            ).fetchone()
            if row is not None:
                return _row_to_dict(row)
            row = conn.execute(
                """
                SELECT * FROM live_sessions
                WHERE slot_index = ?
                ORDER BY updated_at DESC
                LIMIT 1
                """,
                (int(slot_index),),
            ).fetchone()
            return _row_to_dict(row) if row else None
        finally:
            conn.close()


def list_grid_slot_sessions(db_path: Path, max_slots: int) -> list[dict[str, Any] | None]:
    """Return session dict (or None) for each slot 0 .. max_slots-1."""
    out: list[dict[str, Any] | None] = []
    for slot in range(max(1, int(max_slots))):
        out.append(get_session_by_slot(db_path, slot))
    return out


def prune_sessions_for_missing_usb_cameras(db_path: Path, max_index: int = 4) -> int:
    """
    Disable always-on sessions bound to USB indices that are not present on the server.
    Call only while no live job holds a camera (e.g. at server startup).
    """
    from .live_camera import normalize_live_source, probe_local_cameras

    found = {c["index"] for c in probe_local_cameras(max_index=max(1, int(max_index)))}
    disabled = 0
    for sess in list_sessions(db_path, enabled_only=True):
        src = normalize_live_source(sess["source"])
        if not src.isdigit():
            continue
        if int(src) in found:
            continue
        disable_session(db_path, sess["session_id"])
        disabled += 1
    return disabled


def disable_session(db_path: Path, session_id: str) -> None:
    with _db_lock:
        conn = sqlite3.connect(str(db_path))
        try:
            conn.execute(
                """
                UPDATE live_sessions
                SET enabled = 0, always_on = 0, updated_at = ?
                WHERE session_id = ?
                """,
                (_now_iso(), session_id),
            )
            conn.commit()
        finally:
            conn.close()


def get_session(db_path: Path, session_id: str) -> dict[str, Any] | None:
    with _db_lock:
        conn = sqlite3.connect(str(db_path))
        try:
            conn.row_factory = sqlite3.Row
            row = conn.execute(
                "SELECT * FROM live_sessions WHERE session_id = ?",
                (session_id,),
            ).fetchone()
            return _row_to_dict(row) if row else None
        finally:
            conn.close()


def list_sessions(db_path: Path, *, enabled_only: bool = False) -> list[dict[str, Any]]:
    with _db_lock:
        conn = sqlite3.connect(str(db_path))
        try:
            conn.row_factory = sqlite3.Row
            q = "SELECT * FROM live_sessions"
            if enabled_only:
                q += " WHERE enabled = 1 AND always_on = 1"
            q += " ORDER BY updated_at DESC"
            rows = conn.execute(q).fetchall()
            return [_row_to_dict(r) for r in rows]
        finally:
            conn.close()


def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    opts = {}
    try:
        opts = json.loads(row["opts_json"] or "{}")
    except Exception:
        pass
    slot_index = row["slot_index"] if "slot_index" in row.keys() else None
    return {
        "session_id": row["session_id"],
        "source": row["source"],
        "label": row["label"],
        "enabled": bool(row["enabled"]),
        "always_on": bool(row["always_on"]),
        "record": bool(row["record"]),
        "job_id": row["job_id"],
        "slot_index": slot_index,
        "opts": opts,
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }
