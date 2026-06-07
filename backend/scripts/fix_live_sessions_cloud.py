"""Point active live sessions at Dahua cloud token (not LAN RTSP)."""
from __future__ import annotations

import sqlite3
from pathlib import Path

DB = Path(__file__).resolve().parents[1] / "live_sessions.db"


def main() -> None:
    if not DB.is_file():
        print("No live_sessions.db — nothing to update.")
        return
    con = sqlite3.connect(DB)
    cur = con.cursor()
    cur.execute(
        """
        UPDATE live_sessions
        SET source = 'dahua-hero-a1', label = 'DH-H3A cloud'
        WHERE enabled = 1 AND source NOT LIKE 'dahua%'
        """
    )
    print(f"Updated {cur.rowcount} enabled session(s) to dahua-hero-a1")
    cur.execute(
        "SELECT session_id, source, enabled, always_on FROM live_sessions WHERE enabled = 1"
    )
    for row in cur.fetchall():
        print(" ", row)
    con.commit()
    con.close()


if __name__ == "__main__":
    main()
