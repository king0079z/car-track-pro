"""License plate normalization, Qatar OCR correction, and fuzzy matching."""

from __future__ import annotations

import logging
import os
import re
from difflib import SequenceMatcher

_log = logging.getLogger("visionflow.plates")
# Same switch as the engine: PLATE_DEBUG=1 turns on merge-decision tracing so we
# can see exactly which tracks consolidate_vehicle_rows folds together and why.
_PLATE_DEBUG = os.getenv("PLATE_DEBUG", "0").strip().lower() in ("1", "true", "yes", "on")

# Fuzzy-merge guard for consolidation. Two tracks are folded into one vehicle on
# *approximate* plate similarity only above this threshold — above the 0.72 used
# for general matching, because consolidation permanently destroys a row. Distinct
# Qatar plates (same 4-digit + 3-letter shape) must NOT collapse into one car
# (that was reporting ~24 detections as ~9 vehicles). This fuzzy path only ever
# fires on a short non-overlapping continuation gap (a track-ID switch on the same
# car), so it tolerates a single-character OCR drift (≈0.857 on a 7-char plate)
# while still rejecting genuinely different plates.
_MERGE_FUZZY_THRESHOLD = 0.82

# Max off-camera gap (seconds) over which a non-overlapping near-identical read is
# still treated as the same car continuing (a track-ID switch on the same lane).
_MERGE_CONTINUATION_GAP_SEC = 6.0

# Qatar private: 3–5 digits + 2–3 letters (e.g. 3574 BNW)
# Qatar commercial/taxi black plates: 4–6 digits only (e.g. 259559)
# Qatar "new" special series: 3–6 digits + a single trailing Q (e.g. 66474 Q)
_QA_SPLIT = re.compile(r"^(\d{3,5})([A-Z]{2,4})$")
_QA_COMMERCIAL = re.compile(r"^\d{4,6}$")
_QA_SPECIAL_Q = re.compile(r"^(\d{3,6})Q$")

# Legacy patterns kept for strict jurisdiction checks.
_QA = re.compile(r"^[A-Z]?\d{4,6}$")
_UK = re.compile(r"^[A-Z]{2}\d{2}[A-Z]{3}$")
_INTL = re.compile(r"^[A-Z0-9]{3,10}$")

# Letter-zone confusions (digits misread as letters and vice versa).
_LETTER_FIX = str.maketrans({
    "0": "O",
    "1": "I",
    "2": "Z",
    "4": "A",
    "5": "S",
    "6": "G",
    "8": "B",
})


def normalize_plate(text: str) -> str:
    """Uppercase alnum only — strips spaces and punctuation."""
    return re.sub(r"[^A-Z0-9]", "", (text or "").upper())


def _split_digits_letters(key: str) -> tuple[str, str]:
    """
    Split a noisy OCR blob into a Qatar-style digit prefix + letter suffix.

    Qatar plates are digits-then-letters, so we take the trailing run of
    letters as the suffix and the digits that precede it as the number.
    Stray characters wedged between the two blocks (a common OCR artifact,
    e.g. ``817LHGL`` → ``817`` + ``HGL``) are discarded rather than corrupting
    the result.
    """
    if not key:
        return "", ""
    m = re.search(r"[A-Z]+$", key)
    if m:
        letters = m.group(0)
        head = key[: m.start()]
    else:
        letters = "".join(c for c in key if c.isalpha())
        head = key
    digits = "".join(c for c in head if c.isdigit())
    if not digits:
        digits = "".join(c for c in key if c.isdigit())
    return digits, letters


def _clean_digit_block(digits: str) -> str:
    d = re.sub(r"\D", "", digits or "")
    if not d:
        return ""
    # Drop spurious leading 0/1 when OCR yields 5+ digits on private plates (13574 → 3574).
    while len(d) > 4 and d[0] in "01":
        trimmed = d[1:]
        if len(trimmed) == 4 and trimmed[0] == "0":
            break
        if len(trimmed) < 3:
            break
        d = trimmed
    if len(d) > 5:
        d = d[-4:]
    return d


def _clean_letter_block(letters: str) -> str:
    s = (letters or "").upper().translate(_LETTER_FIX)
    s = re.sub(r"[^A-Z]", "", s)
    # Qatar suffix is 2–3 letters; when OCR yields 4+, the leading char is
    # almost always noise from the digit zone — keep the trailing letters.
    if len(s) > 3:
        return s[-3:]
    return s


def format_qatar_plate(text: str) -> str:
    """
    Normalize OCR to Qatar-style #### XXX when possible.
    Example: 03574BN → 3574 BNW (best effort on letters).
    """
    raw = (text or "").strip()
    if not raw:
        return ""

    parts = re.split(r"\s+", raw.upper())
    if len(parts) >= 2:
        digits = _clean_digit_block(re.sub(r"\D", "", parts[0]))
        letters = _clean_letter_block("".join(parts[1:]))
        if len(digits) >= 3 and len(letters) >= 2:
            return f"{digits} {letters}"

    key = normalize_plate(raw)

    # Qatar "new" special series — digits + a single trailing Q (e.g. 66474 Q).
    # The trailing Q is part of the plate and must always be preserved.
    m_q = _QA_SPECIAL_Q.fullmatch(key)
    if m_q:
        return f"{m_q.group(1)} Q"

    # Black commercial / taxi plates — digits only (e.g. 259559).
    if _QA_COMMERCIAL.fullmatch(key):
        return key

    m = _QA_SPLIT.match(key)
    if m:
        digits = _clean_digit_block(m.group(1))
        letters = _clean_letter_block(m.group(2))
    else:
        digits, letters = _split_digits_letters(key)
        digits = _clean_digit_block(digits)
        letters = _clean_letter_block(letters)

    if len(digits) >= 3 and len(letters) >= 2:
        return f"{digits} {letters}"
    return re.sub(r"\s+", " ", raw)


def plate_similarity(a: str, b: str) -> float:
    """0–1 similarity on normalized plate strings."""
    na, nb = normalize_plate(a), normalize_plate(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    return SequenceMatcher(None, na, nb).ratio()


def plates_match(a: str, b: str, *, threshold: float = 0.72) -> bool:
    return plate_similarity(a, b) >= threshold


def _plates_same_vehicle(a: str, b: str) -> bool:
    """
    True when two reads almost certainly belong to the *same* physical plate —
    used to fold duplicate/overlapping tracks of one car (track-ID splits, OCR
    drift, or a truncated read) into a single vehicle row.

    Deliberately conservative so two genuinely different plates never collapse:
    distinct plates have different number blocks AND letters, so they score far
    below the fuzzy threshold and neither contains the other.
    """
    na, nb = normalize_plate(a), normalize_plate(b)
    if len(na) < 3 or len(nb) < 3:
        return False
    if na == nb:
        return True
    # One read is a truncation of the other (e.g. "8174HG" ⊂ "8174HGL",
    # "916GHS" ⊂ "9916GHS", "0526H" ⊂ "0526HGN") — a very strong same-car signal.
    if min(len(na), len(nb)) >= 4 and (na in nb or nb in na):
        return True
    # High overall similarity (single-character OCR drift on a 6-7 char plate).
    return plate_similarity(a, b) >= _MERGE_FUZZY_THRESHOLD


def matches_jurisdiction(text: str, jurisdiction: str) -> bool:
    """Return True if normalized plate matches the configured region shape."""
    formatted = format_qatar_plate(text)
    key = normalize_plate(formatted)
    if len(key) < 3:
        return False
    j = (jurisdiction or "intl").strip().lower()
    if j == "intl":
        return bool(_INTL.match(key))
    if j == "qa":
        return bool(_QA_SPLIT.match(key) or _QA.match(key) or _QA_COMMERCIAL.match(key) or _QA_SPECIAL_Q.match(key))
    if j == "uk":
        return bool(_UK.match(key))
    if j in ("qa_uk", "qa-uk", "qatar_uk"):
        return bool(_QA_SPLIT.match(key) or _QA.match(key) or _QA_COMMERCIAL.match(key) or _QA_SPECIAL_Q.match(key) or _UK.match(key))
    return bool(_INTL.match(key))


def accept_plate_read(text: str, *, jurisdiction: str, strict: bool) -> bool:
    """When strict is off, accept plausible OCR strings; reject obvious garbage."""
    cleaned = format_qatar_plate(text)
    key = normalize_plate(cleaned)
    if len(key) < 3:
        return False
    if not strict:
        j = (jurisdiction or "intl").strip().lower()
        if j in ("qa", "qa_uk", "qa-uk", "qatar_uk"):
            if _QA_COMMERCIAL.match(key) or _QA_SPECIAL_Q.match(key):
                return True
            digits, letters = _split_digits_letters(key)
            if len(digits) >= 3 and len(letters) >= 2:
                return True
            # Reject letter-heavy noise from phone screens / UI (e.g. 7YTC, 1STE).
            if len(digits) < 2 and len(letters) >= 2:
                return False
            if key.isalpha() and len(key) <= 5:
                return False
            # Reject letter-first / short-digit noise (e.g. DHH34, 7YTC) — Qatar private is 3–5 digits + 2–3 letters.
            if len(digits) >= 3 and len(letters) >= 2:
                return True
            if len(digits) >= 4 and len(letters) == 0:
                return True
            return False
        return bool(_INTL.match(key)) and len(key) >= 5
    return matches_jurisdiction(cleaned, jurisdiction)


def sync_eligible_plate(text: str, *, jurisdiction: str) -> bool:
    """Plates worth writing to CarTrack — stricter than on-screen OCR preview."""
    cleaned = format_qatar_plate(text)
    key = normalize_plate(cleaned)
    if len(key) < 4:
        return False
    j = (jurisdiction or "intl").strip().lower()
    if j in ("qa", "qa_uk", "qa-uk", "qatar_uk"):
        if _QA_COMMERCIAL.match(key):
            return len(key) >= 4
        if _QA_SPECIAL_Q.match(key):
            return True
        if _QA_SPLIT.match(key):
            return True
        digits, letters = _split_digits_letters(key)
        if len(digits) >= 3 and len(letters) >= 2:
            return True
        return False
    if j == "uk":
        return bool(_UK.match(key))
    return bool(_INTL.match(key)) and len(key) >= 5


def manifest_sync_quality_ok(
    row: dict,
    *,
    min_votes: int = 2,
    min_dwell_sec: float = 0.8,
    high_conf: float = 0.88,
) -> bool:
    """Whether a live manifest row has enough evidence to write into CarTrack."""
    plate = str(row.get("plate") or "").strip()
    if not plate or plate in ("—", "…", "UNKNOWN"):
        return False
    votes = int(row.get("ocr_vote_count") or 0)
    conf = float(row.get("ocr_confidence") or 0.0)
    dwell = float(row.get("duration_sec") or 0.0)
    key = normalize_plate(format_qatar_plate(plate))
    commercial = bool(_QA_COMMERCIAL.match(key))
    if votes >= min_votes and dwell >= min_dwell_sec:
        return True
    # Stationary commercial plates (e.g. 652190): one strong read + a few seconds visible.
    if commercial and votes >= 1 and conf >= high_conf and dwell >= 1.2:
        return True
    if votes >= 1 and conf >= high_conf and dwell >= 1.5:
        return True
    # Fragmented tracks merged by plate — multiple weak reads on the same car.
    if votes >= 3 and dwell >= 0.5:
        return True
    return False


def aggregate_manifest_rows_by_plate(rows: list[dict]) -> list[dict]:
    """Merge track fragments that read the same plate (BoT-SORT re-ID on stationary cars)."""
    merged: dict[str, dict] = {}
    for v in rows or []:
        plate = str(v.get("plate") or "").strip()
        if not plate or plate in ("—", "…", "UNKNOWN"):
            continue
        key = normalize_plate(format_qatar_plate(plate))
        if len(key) < 4:
            continue
        if key not in merged:
            merged[key] = dict(v)
            merged[key]["plate"] = format_qatar_plate(plate) or plate
            merged[key]["ocr_vote_count"] = int(v.get("ocr_vote_count") or 0)
            merged[key]["duration_sec"] = float(v.get("duration_sec") or 0.0)
            merged[key]["ocr_confidence"] = float(v.get("ocr_confidence") or 0.0)
            merged[key]["segment_count"] = int(v.get("segment_count") or 1)
            continue
        agg = merged[key]
        agg["ocr_vote_count"] = int(agg.get("ocr_vote_count") or 0) + int(v.get("ocr_vote_count") or 0)
        agg["duration_sec"] = max(float(agg.get("duration_sec") or 0.0), float(v.get("duration_sec") or 0.0))
        agg["ocr_confidence"] = max(float(agg.get("ocr_confidence") or 0.0), float(v.get("ocr_confidence") or 0.0))
        agg["segment_count"] = int(agg.get("segment_count") or 1) + int(v.get("segment_count") or 1)
        if str(v.get("status") or "").lower() == "active":
            agg["status"] = "active"
    return list(merged.values())


def _weighted_mode(counter: dict[Any, float]) -> Any:
    return max(counter.items(), key=lambda kv: kv[1])[0] if counter else None


def _positional_consensus(members: list[tuple[str, float]]) -> str:
    """
    Vote each character independently across reads, after splitting into
    digit-block + letter-block. Recovers correct chars when frames disagree
    (e.g. BNW vs BNI vs BNW → BNW).
    """
    digit_blocks: list[tuple[str, float]] = []
    letter_blocks: list[tuple[str, float]] = []
    commercial_digits: list[tuple[str, float]] = []  # digits-only (black/taxi) reads
    for text, conf in members:
        parts = format_qatar_plate(text).split()
        if len(parts) == 2:
            d, ltr = parts
            if d:
                digit_blocks.append((d, conf))
            if ltr:
                letter_blocks.append((ltr, conf))
        elif len(parts) == 1 and parts[0].isdigit():
            commercial_digits.append((parts[0], conf))

    def consensus(blocks: list[tuple[str, float]]) -> str:
        len_votes: dict[int, float] = {}
        for s, c in blocks:
            len_votes[len(s)] = len_votes.get(len(s), 0.0) + c + 0.05
        target_len = _weighted_mode(len_votes)
        sized = [(s, c) for s, c in blocks if len(s) == target_len]
        if not sized:
            sized = blocks
            target_len = len(max(blocks, key=lambda b: b[1])[0])
        out_chars: list[str] = []
        for i in range(target_len):
            col: dict[str, float] = {}
            for s, c in sized:
                if i < len(s):
                    col[s[i]] = col.get(s[i], 0.0) + c
            ch = _weighted_mode(col)
            if ch:
                out_chars.append(ch)
        return "".join(out_chars)

    # Private plate: digit block + letter block (e.g. 3574 BNW).
    if digit_blocks and letter_blocks:
        digits = consensus(digit_blocks)
        letters = consensus(letter_blocks)
        if len(digits) >= 3 and len(letters) >= 2:
            return f"{digits} {letters}"
        return ""

    # Commercial / taxi plate: digits only (e.g. 856764). Vote the plate length
    # first, then each digit position — this rejects a stray extra digit that a
    # single noisy frame may add (856764 ×36 must beat 8567644 ×1), instead of
    # the old "longest read wins" behaviour that let one misread dominate.
    if commercial_digits and not letter_blocks:
        sized = [(d, c) for d, c in commercial_digits if 4 <= len(d) <= 6]
        digits = consensus(sized or commercial_digits)
        if 4 <= len(digits) <= 6:
            return digits
        if len(digits) > 6:
            return digits[:6]
    return ""


def vote_best_plate(votes: list[tuple[str, float]]) -> str:
    """
    Fuzzy cluster voting + per-character consensus.
    1. Cluster reads of the same plate (handles 13574BNL vs 3574BNW).
    2. Within the winning cluster, vote each character position by confidence.
    """
    if not votes:
        return ""

    clusters: list[dict] = []
    for text, conf in votes:
        t = format_qatar_plate(text.strip())
        if len(normalize_plate(t)) < 3:
            continue
        placed = False
        for cl in clusters:
            if plates_match(t, cl["plate"], threshold=0.68):
                cl["score"] += float(conf) + 0.05
                cl["count"] += 1
                cl["members"].append((t, float(conf)))
                if len(normalize_plate(t)) >= len(normalize_plate(cl["plate"])):
                    cl["plate"] = t
                placed = True
                break
        if not placed:
            clusters.append({
                "plate": t,
                "score": float(conf),
                "count": 1,
                "members": [(t, float(conf))],
            })

    if not clusters:
        raw = [format_qatar_plate(v[0]) for v in votes if v[0].strip()]
        return max(raw, key=lambda s: len(normalize_plate(s))) if raw else ""

    best = max(clusters, key=lambda c: (c["score"], c["count"], len(normalize_plate(c["plate"]))))
    consensus = _positional_consensus(best["members"])
    return consensus or best["plate"]


_UNKNOWN_PLATES = ("", "—", "…", "UNKNOWN")


def _is_unknown_plate(plate: object) -> bool:
    return (not plate) or str(plate).strip().upper() in _UNKNOWN_PLATES


def _row_dwell_sec(row: dict) -> float:
    t0 = float(row.get("t_enter_sec") or 0)
    t1 = float(row.get("t_exit_sec") or t0)
    return float(row.get("duration_sec") or max(0.0, t1 - t0))


def _apply_presence_durations(rows: list[dict], *, now_sec: float | None) -> None:
    """Shop/service presence timer — counts while Live, pauses when Paused, locks on Done."""
    for r in rows:
        in_frame = _row_dwell_sec(r)
        status = str(r.get("status") or "").lower()
        if status == "active" and now_sec is not None:
            t_exit = float(r.get("t_exit_sec") or 0.0)
            presence = in_frame + max(0.0, now_sec - t_exit)
        else:
            presence = in_frame
        r["presence_duration_sec"] = round(presence, 3)
        r["shop_first_seen_sec"] = round(float(r.get("t_enter_sec") or 0.0), 3)


def consolidate_vehicle_rows(
    rows: list[dict],
    *,
    gap_sec: float = 2.5,
    resume_gap_sec: float = 7200.0,
    min_unknown_sec: float = 0.3,
    now_sec: float | None = None,
    jurisdiction: str = "qa_uk",
) -> list[dict]:
    """
    Merge duplicate manifest rows caused by track ID switches, OCR drift, or
    the same car leaving and re-entering frame (e.g. a bay change within the
    configured re-entry waiting period).

    In-frame dwell is summed across segments; gaps off-camera are excluded.
    When any segment is active, the consolidated row is Live (active).

    ``now_sec`` is the current source-time (seconds) of an ongoing session. When
    provided, any exited vehicle whose last sighting is within ``resume_gap_sec``
    is marked ``resume_eligible`` (shown as Paused — still waiting to resume);
    once the wait elapses it is finalized (Done). ``None`` (session finalized)
    reports every exited track as Done.
    """
    known = [r for r in rows if not _is_unknown_plate(r.get("plate"))]
    unknown = [r for r in rows if _is_unknown_plate(r.get("plate"))]

    known.sort(key=lambda r: float(r.get("t_enter_sec") or 0))
    merged: list[dict] = []
    # PLATE_DEBUG trace: (source track, target track, plates, reason, similarity).
    merge_trace: list[tuple] = []

    for row in known:
        plate = format_qatar_plate(str(row["plate"]))
        t0 = float(row.get("t_enter_sec") or 0)
        t1 = float(row.get("t_exit_sec") or t0)
        tid = row.get("track_id")
        row_active = str(row.get("status") or "").lower() == "active"

        match_idx: int | None = None
        match_reason: str = ""
        match_sim: float = 0.0
        for i, m in enumerate(merged):
            m_plate = format_qatar_plate(str(m.get("plate", "")))
            norm_plate = normalize_plate(plate)
            norm_m = normalize_plate(m_plate)
            same_track = tid is not None and tid == m.get("track_id")
            same_plate = norm_plate == norm_m and len(norm_plate) >= 3
            # Containment of 5+ char reads (OCR drift / a truncated digit such as
            # 856764 ⊂ 8567644) is just as strong a same-car signal as an exact
            # match, and is what lets a Paused car RESUME when it re-enters with a
            # slightly different read after a long off-camera gap.
            contained = (
                min(len(norm_plate), len(norm_m)) >= 5
                and (norm_plate in norm_m or norm_m in norm_plate)
            )
            strong_same = same_plate or contained
            mt0 = float(m.get("t_enter_sec") or 0)
            mt1 = float(m.get("t_exit_sec") or mt0)
            gap_since_exit = t0 - mt1
            overlaps = t0 <= mt1 and t1 >= mt0
            # Same physical track ID — always the same vehicle.
            if same_track:
                match_idx = i
                match_reason = "same_track"
                match_sim = plate_similarity(plate, m_plate)
                break
            # Exact (or contained) plate — merge across overlap, a small gap, or a
            # long off-camera re-entry window (same car leaving and returning, e.g.
            # moving to another bay and coming back within the waiting period).
            if strong_same and (
                overlaps
                or abs(t0 - mt1) <= gap_sec
                or (0 <= gap_since_exit <= resume_gap_sec)
            ):
                match_idx = i
                match_reason = "same_plate" if same_plate else "same_vehicle_strong"
                match_sim = 1.0 if same_plate else plate_similarity(plate, m_plate)
                break
            # Same physical plate read with OCR drift or a truncated read. The
            # relaxed detector legitimately produces several short-lived track IDs
            # for one car (BoT-SORT splits), and these OVERLAP in time, so unlike a
            # generic fuzzy match we DO fold overlapping tracks here — but only when
            # the plates are near-identical / one contains the other, which two
            # genuinely different vehicles never satisfy. A non-overlapping match is
            # also merged within a short continuation window (lane-level ID switch).
            same_vehicle = _plates_same_vehicle(plate, m_plate)
            # Two concurrently-active tracks with distinct IDs are two real cars on
            # the floor at once — a single vehicle cannot be live twice. Never fold
            # them on a merely fuzzy (non-exact, non-contained) plate match, or
            # similar plates such as "817 HGL" / "8174 HGL" would collapse.
            both_active_distinct = (
                row_active
                and tid is not None
                and tid != m.get("track_id")
                and str(m.get("status") or "").lower() == "active"
            )
            if same_vehicle and not both_active_distinct and (
                overlaps or (0 <= gap_since_exit <= _MERGE_CONTINUATION_GAP_SEC)
            ):
                match_idx = i
                match_reason = "same_vehicle"
                match_sim = plate_similarity(plate, m_plate)
                break

        if _PLATE_DEBUG and match_idx is not None:
            merge_trace.append((
                tid,
                merged[match_idx].get("track_id"),
                plate,
                format_qatar_plate(str(merged[match_idx].get("plate", ""))),
                match_reason,
                round(match_sim, 3),
            ))

        if match_idx is None:
            out_row = {**row, "plate": plate}
            out_row["duration_sec"] = round(_row_dwell_sec(out_row), 3)
            out_row["segment_count"] = 1
            out_row["ocr_vote_count"] = int(row.get("ocr_vote_count") or 0)
            if row.get("ocr_confidence") is not None:
                out_row["ocr_confidence"] = round(float(row["ocr_confidence"]), 3)
            merged.append(out_row)
            continue

        m = merged[match_idx]
        prev_exit = float(m.get("t_exit_sec") or 0)
        gap_since_exit = t0 - prev_exit
        best = vote_best_plate([(str(m.get("plate", "")), 1.0), (plate, 1.0)])
        if best:
            m["plate"] = best
        if row_active and tid is not None:
            m["track_id"] = tid
        d1 = _row_dwell_sec(m)
        d2 = _row_dwell_sec(row)
        m["t_enter_sec"] = round(min(float(m.get("t_enter_sec") or t0), t0), 3)
        m["t_exit_sec"] = round(max(float(m.get("t_exit_sec") or t1), t1), 3)
        m["duration_sec"] = round(d1 + d2, 3)
        m["segment_count"] = int(m.get("segment_count") or 1) + 1
        m["ocr_vote_count"] = int(m.get("ocr_vote_count") or 0) + int(row.get("ocr_vote_count") or 0)
        mc, rc = m.get("ocr_confidence"), row.get("ocr_confidence")
        if mc is not None and rc is not None:
            m["ocr_confidence"] = round(max(float(mc), float(rc)), 3)
        elif rc is not None:
            m["ocr_confidence"] = round(float(rc), 3)
        elif mc is not None:
            m["ocr_confidence"] = round(float(mc), 3)
        m["first_frame"] = min(int(m.get("first_frame") or 0), int(row.get("first_frame") or 0))
        m["last_frame"] = max(int(m.get("last_frame") or 0), int(row.get("last_frame") or 0))
        sm = m.get("speed_kmh_max") or 0
        sr = row.get("speed_kmh_max") or 0
        peak = max(int(sm or 0), int(sr or 0))
        m["speed_kmh_max"] = peak if peak else None
        sl = row.get("speed_kmh_last")
        if sl is not None:
            m["speed_kmh_last"] = sl
        a1, a2 = m.get("speed_kmh_avg"), row.get("speed_kmh_avg")
        if a1 is not None and a2 is not None and (d1 + d2) > 0:
            m["speed_kmh_avg"] = int(round((float(a1) * d1 + float(a2) * d2) / (d1 + d2)))
        elif a2 is not None:
            m["speed_kmh_avg"] = a2
        elif a1 is not None:
            m["speed_kmh_avg"] = a1
        if row_active or str(m.get("status") or "").lower() == "active":
            m["status"] = "active"
            m.pop("resume_eligible", None)
        else:
            m["status"] = "exited"
            if 0 <= gap_since_exit <= resume_gap_sec:
                m["resume_eligible"] = True

    # Track IDs that eventually produced a confident plate — don't double-report
    # them as "Unknown".
    known_tids = {m.get("track_id") for m in merged if m.get("track_id") is not None}

    # Keep every vehicle whose plate could not be read: one row per track so the
    # count of captured cars is complete. Ultra-short blips are treated as noise.
    seen_unknown: dict[object, dict] = {}
    none_seq = 0
    for row in unknown:
        tid = row.get("track_id")
        if tid is not None and tid in known_tids:
            continue
        # Ghost OCR on empty pavement — never surface as "Unknown" with fake votes.
        if int(row.get("ocr_vote_count") or 0) > 0 and _is_unknown_plate(row.get("plate")):
            continue
        t0 = float(row.get("t_enter_sec") or 0)
        t1 = float(row.get("t_exit_sec") or t0)
        if (t1 - t0) < min_unknown_sec:
            continue
        key: object = tid
        if key is None:
            key = f"__none_{none_seq}"
            none_seq += 1
        if key in seen_unknown:
            ex = seen_unknown[key]
            ex["t_enter_sec"] = round(min(float(ex.get("t_enter_sec") or t0), t0), 3)
            ex["t_exit_sec"] = round(max(float(ex.get("t_exit_sec") or t1), t1), 3)
            ex["duration_sec"] = round(max(0.0, ex["t_exit_sec"] - ex["t_enter_sec"]), 3)
            ex["first_frame"] = min(int(ex.get("first_frame") or 0), int(row.get("first_frame") or 0))
            ex["last_frame"] = max(int(ex.get("last_frame") or 0), int(row.get("last_frame") or 0))
            if str(row.get("status")) == "active":
                ex["status"] = "active"
            continue
        label = "…" if str(row.get("status")) == "active" else "Unknown"
        seen_unknown[key] = {**row, "plate": label}

    live_session = now_sec is not None
    if live_session:
        j = (jurisdiction or "qa_uk").strip().lower()
        merged = [
            m
            for m in merged
            if not _is_unknown_plate(m.get("plate"))
            and sync_eligible_plate(str(m.get("plate") or ""), jurisdiction=j)
        ]
        result = merged
    else:
        result = merged + list(seen_unknown.values())

    # Authoritative Paused/Done flag: an exited vehicle is "Paused" (waiting to
    # resume) only while time-since-last-seen is within the waiting period. This
    # makes a car that just left for another bay show Paused immediately, and flip
    # to Done once the window elapses with no return. When the session is finalized
    # (now_sec is None) every exited track is Done.
    for r in result:
        status = str(r.get("status") or "").lower()
        if status == "active":
            r.pop("resume_eligible", None)
            continue
        if now_sec is None or resume_gap_sec <= 0:
            r.pop("resume_eligible", None)
            continue
        waited = now_sec - float(r.get("t_exit_sec") or 0)
        if 0 <= waited <= resume_gap_sec:
            r["resume_eligible"] = True
        else:
            r.pop("resume_eligible", None)

    _apply_presence_durations(result, now_sec=now_sec)

    result.sort(key=lambda r: float(r.get("t_enter_sec") or 0))

    if _PLATE_DEBUG:
        _log.info(
            "CONSOLIDATE in=%d (known=%d unknown=%d) -> out=%d | merges=%d",
            len(rows), len(known), len(unknown), len(result), len(merge_trace),
        )
        for src_tid, dst_tid, src_plate, dst_plate, reason, sim in merge_trace:
            _log.info(
                "  MERGE track #%s '%s'  ->  track #%s '%s'  (%s, sim=%.3f)",
                src_tid, src_plate, dst_tid, dst_plate, reason, sim,
            )

    return result
