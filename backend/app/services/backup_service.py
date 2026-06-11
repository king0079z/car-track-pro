"""
Automatic database backups with rotation.

Every BACKUP_INTERVAL_HOURS a timestamped folder is written under BACKUP_DIR
(default ``{CARTRACK_DATA_DIR or backend}/backups``) containing:

  * cartrack.db            — main app DB (WAL-safe via the sqlite3 backup API)
  * analysis_history.db    — VisionFlow job history
  * live_sessions.db       — live ANPR session persistence
  * settings.json          — organization settings
  * cameras.json           — camera configuration (when present)

Folders older than BACKUP_RETENTION_DAYS are pruned. Admins can also trigger
an immediate backup from Settings → ``POST /api/settings/backup-now``.
Non-SQLite DATABASE_URLs (MySQL/Postgres) are skipped for the main DB — use
the engine's native dump tooling there.
"""

from __future__ import annotations

import logging
import os
import shutil
import sqlite3
import threading
import time
from datetime import datetime
from typing import Any

from ..config import settings

_log = logging.getLogger(__name__)

_backup_lock = threading.Lock()
_last_result: dict[str, Any] = {}


def _backend_dir() -> str:
    return os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def _data_dir() -> str:
    return os.environ.get("CARTRACK_DATA_DIR") or _backend_dir()


def backup_root() -> str:
    configured = str(getattr(settings, "BACKUP_DIR", "") or "").strip()
    return configured or os.path.join(_data_dir(), "backups")


def _sqlite_path_from_url(url: str) -> str | None:
    if not url.startswith("sqlite"):
        return None
    # sqlite:///./cartrack.db or sqlite:////app/data/cartrack.db
    path = url.split("///", 1)[-1]
    if path.startswith("./"):
        path = os.path.join(_backend_dir(), path[2:])
    return os.path.abspath(path)


def _backup_sqlite(src: str, dst: str) -> None:
    """Consistent point-in-time copy even with WAL writers active."""
    with sqlite3.connect(src, timeout=30.0) as conn, sqlite3.connect(dst) as out:
        conn.backup(out)


def _candidate_files() -> list[tuple[str, str, bool]]:
    """(source_path, archive_name, is_sqlite) for everything worth backing up."""
    items: list[tuple[str, str, bool]] = []
    main_db = _sqlite_path_from_url(settings.DATABASE_URL)
    if main_db:
        items.append((main_db, "cartrack.db", True))
    data = _data_dir()
    for name in ("analysis_history.db", "live_sessions.db"):
        items.append((os.path.join(data, name), name, True))
    items.append((os.path.join(_backend_dir(), "settings.json"), "settings.json", False))
    for cams in (os.path.join(data, "cameras.json"), os.path.join(_backend_dir(), "cameras.json")):
        if os.path.exists(cams):
            items.append((cams, "cameras.json", False))
            break
    return items


def run_backup() -> dict[str, Any]:
    """Create one timestamped backup set; returns a summary dict."""
    with _backup_lock:
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        dest_dir = os.path.join(backup_root(), stamp)
        os.makedirs(dest_dir, exist_ok=True)
        copied: list[str] = []
        errors: list[str] = []
        for src, name, is_sqlite in _candidate_files():
            if not os.path.exists(src):
                continue
            dst = os.path.join(dest_dir, name)
            try:
                if is_sqlite:
                    _backup_sqlite(src, dst)
                else:
                    shutil.copy2(src, dst)
                copied.append(name)
            except Exception as exc:
                errors.append(f"{name}: {exc}")
                _log.warning("Backup of %s failed: %s", src, exc)
        if not copied:
            # Nothing was written — don't leave an empty folder behind.
            shutil.rmtree(dest_dir, ignore_errors=True)
        pruned = _prune_old_backups()
        size = 0
        if copied:
            size = sum(
                os.path.getsize(os.path.join(dest_dir, f))
                for f in os.listdir(dest_dir)
            )
        result = {
            "at": datetime.now().isoformat(timespec="seconds"),
            "folder": stamp if copied else None,
            "files": copied,
            "errors": errors,
            "size_bytes": size,
            "pruned": pruned,
        }
        _last_result.clear()
        _last_result.update(result)
        if copied:
            _log.info(
                "Backup %s written (%d files, %.1f MB, pruned %d old sets)",
                stamp, len(copied), size / 1e6, pruned,
            )
        return result


def _prune_old_backups() -> int:
    root = backup_root()
    retention_sec = max(1, int(getattr(settings, "BACKUP_RETENTION_DAYS", 14))) * 86400
    cutoff = time.time() - retention_sec
    pruned = 0
    try:
        for entry in os.listdir(root):
            path = os.path.join(root, entry)
            if not os.path.isdir(path):
                continue
            try:
                if os.path.getmtime(path) < cutoff:
                    shutil.rmtree(path, ignore_errors=True)
                    pruned += 1
            except OSError:
                continue
    except FileNotFoundError:
        pass
    return pruned


def list_backups() -> list[dict[str, Any]]:
    root = backup_root()
    out: list[dict[str, Any]] = []
    try:
        for entry in sorted(os.listdir(root), reverse=True):
            path = os.path.join(root, entry)
            if not os.path.isdir(path):
                continue
            files = os.listdir(path)
            size = sum(os.path.getsize(os.path.join(path, f)) for f in files)
            out.append({
                "folder": entry,
                "files": sorted(files),
                "size_bytes": size,
                "created_at": datetime.fromtimestamp(os.path.getmtime(path)).isoformat(timespec="seconds"),
            })
    except FileNotFoundError:
        pass
    return out[:60]


def last_backup_status() -> dict[str, Any]:
    return dict(_last_result)


async def periodic_backup_loop() -> None:
    """Asyncio task started from the app lifespan."""
    import asyncio

    if not bool(getattr(settings, "BACKUP_ENABLED", True)):
        _log.info("Automatic backups disabled (BACKUP_ENABLED=false)")
        return
    interval = max(0.25, float(getattr(settings, "BACKUP_INTERVAL_HOURS", 6.0))) * 3600.0
    await asyncio.sleep(90.0)  # let startup finish first
    while True:
        try:
            await asyncio.to_thread(run_backup)
        except Exception:
            _log.exception("Periodic backup failed")
        await asyncio.sleep(interval)
