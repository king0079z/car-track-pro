import sqlite3

c = sqlite3.connect("cartrack.db")
cur = c.cursor()


def norm(p):
    return (p or "").upper().replace(" ", "")


cur.execute("SELECT plate, track_id, job_id, speed_kmh, duration_sec, detected_at FROM anpr_detections ORDER BY id DESC LIMIT 400")
rows = cur.fetchall()
hgl = [r for r in rows if "HGL" in norm(r[0]) or "HGN" in norm(r[0])]
print("Total recent detections scanned:", len(rows))
print("HGL/HGN rows:", len(hgl))
for r in hgl:
    print("  plate=%-10s track=%s job=%s spd=%s dwell=%s at=%s" % (r[0], r[1], (r[2] or "")[:8], r[3], r[4], r[5]))

print("\nDistinct recent plates (last 60):")
seen = []
for r in rows:
    if r[0] not in seen:
        seen.append(r[0])
for p in seen[:60]:
    print("  ", p)
c.close()
