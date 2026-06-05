"""License plate normalization, Qatar OCR correction, and fuzzy matching."""

from __future__ import annotations

import re
from difflib import SequenceMatcher

# Qatar private: 3–5 digits + 2–3 letters (e.g. 3574 BNW)
# Qatar commercial/taxi black plates: 4–6 digits only (e.g. 259559)
_QA_SPLIT = re.compile(r"^(\d{3,5})([A-Z]{2,4})$")
_QA_COMMERCIAL = re.compile(r"^\d{4,6}$")

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
        return bool(_QA_SPLIT.match(key) or _QA.match(key) or _QA_COMMERCIAL.match(key))
    if j == "uk":
        return bool(_UK.match(key))
    if j in ("qa_uk", "qa-uk", "qatar_uk"):
        return bool(_QA_SPLIT.match(key) or _QA.match(key) or _QA_COMMERCIAL.match(key) or _UK.match(key))
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
            if _QA_COMMERCIAL.match(key):
                return True
            digits, letters = _split_digits_letters(key)
            if len(digits) >= 3 and len(letters) >= 2:
                return True
            # Reject letter-heavy noise from phone screens / UI (e.g. 7YTC, 1STE).
            if len(digits) < 2 and len(letters) >= 2:
                return False
            if key.isalpha() and len(key) <= 5:
                return False
        return True
    return matches_jurisdiction(cleaned, jurisdiction)


def sync_eligible_plate(text: str, *, jurisdiction: str) -> bool:
    """Plates worth writing to CarTrack — stricter than raw OCR, looser than fleet test IDs."""
    if accept_plate_read(text, jurisdiction=jurisdiction, strict=False):
        return True
    key = normalize_plate(format_qatar_plate(text))
    if len(key) < 5:
        return False
    digits = sum(1 for c in key if c.isdigit())
    letters = sum(1 for c in key if c.isalpha())
    if digits >= 2 and letters >= 2:
        return True
    if digits >= 1 and letters >= 4 and len(key) >= 6:
        return True
    return False


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
    for text, conf in members:
        parts = format_qatar_plate(text).split()
        if len(parts) != 2:
            continue
        d, ltr = parts
        if d:
            digit_blocks.append((d, conf))
        if ltr:
            letter_blocks.append((ltr, conf))

    if not digit_blocks or not letter_blocks:
        return ""

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

    digits = consensus(digit_blocks)
    letters = consensus(letter_blocks)
    if len(digits) >= 3 and len(letters) >= 2:
        return f"{digits} {letters}"
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


def consolidate_vehicle_rows(
    rows: list[dict],
    *,
    gap_sec: float = 2.5,
    resume_gap_sec: float = 7200.0,
    min_unknown_sec: float = 0.3,
) -> list[dict]:
    """
    Merge duplicate manifest rows caused by track ID switches, OCR drift, or
    the same car leaving and re-entering frame (e.g. bay change within 2 hours).

    In-frame dwell is summed across segments; gaps off-camera are excluded.
    When any segment is active, the consolidated row is Live (active).
    """
    known = [r for r in rows if not _is_unknown_plate(r.get("plate"))]
    unknown = [r for r in rows if _is_unknown_plate(r.get("plate"))]

    known.sort(key=lambda r: float(r.get("t_enter_sec") or 0))
    merged: list[dict] = []

    for row in known:
        plate = format_qatar_plate(str(row["plate"]))
        t0 = float(row.get("t_enter_sec") or 0)
        t1 = float(row.get("t_exit_sec") or t0)
        tid = row.get("track_id")

        match_idx: int | None = None
        for i, m in enumerate(merged):
            m_plate = format_qatar_plate(str(m.get("plate", "")))
            norm_plate = normalize_plate(plate)
            norm_m = normalize_plate(m_plate)
            same_track = tid is not None and tid == m.get("track_id")
            same_plate = norm_plate == norm_m and len(norm_plate) >= 3
            similar_plate = plates_match(plate, m_plate)
            mt0 = float(m.get("t_enter_sec") or 0)
            mt1 = float(m.get("t_exit_sec") or mt0)
            gap_since_exit = t0 - mt1
            overlaps = t0 <= mt1 and t1 >= mt0
            time_close = (
                abs(t0 - mt1) <= gap_sec
                or overlaps
                or (
                    gap_since_exit >= 0
                    and gap_since_exit <= resume_gap_sec
                    and (same_plate or similar_plate)
                )
            )
            m_active = str(m.get("status") or "").lower() == "active"
            row_active = str(row.get("status") or "").lower() == "active"
            if same_plate and time_close:
                match_idx = i
                break
            if same_track:
                match_idx = i
                break
            if similar_plate and time_close:
                if m_active and row_active and tid is not None and tid != m.get("track_id"):
                    continue
                match_idx = i
                break

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
        row_active = str(row.get("status") or "").lower() == "active"
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

    result = merged + list(seen_unknown.values())
    result.sort(key=lambda r: float(r.get("t_enter_sec") or 0))
    return result
