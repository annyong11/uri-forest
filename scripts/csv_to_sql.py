#!/usr/bin/env python3
"""
CSV -> Cloudflare D1 bulk-import builder (stdlib only).

Reads the two source CSVs and emits db/data.sql (batched multi-row INSERTs).
Run AFTER creating the table with db/schema.sql.

    python3 scripts/csv_to_sql.py
    wrangler d1 execute uri-forest-db --local  --file=./db/schema.sql
    wrangler d1 execute uri-forest-db --local  --file=./db/data.sql

Two non-obvious correctness rules baked in (both verified against the real data):

  1) SURROGATE KEY. content_id is NOT unique (58,906 rows / 42,079 distinct;
     16,827 collisions are different real places). We emit a sequential row_id
     and keep content_id as a plain column. A content_id PRIMARY KEY would
     silently drop 16,827 rows on import.

  2) POSITIONAL JOIN. The master and preference CSVs are aligned row-by-row
     (identical content_id sequence across all 58,906 rows — verified). Because
     content_id is non-unique, a dict lookup by content_id is AMBIGUOUS, so we
     join the preference scores by ROW POSITION (zip), which is exact.
"""
import csv
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MASTER = os.path.join(ROOT, "data", "final_solution_master_db_fixed_advanced.csv")
SCORES = os.path.join(ROOT, "data", "culture_preference_scoring_table.csv")
OUT = os.path.join(ROOT, "db", "data.sql")
TABLE = "solutions"
# D1 rejects any single SQL statement over 100,000 bytes ("Statement too long").
# Korean text is 3 bytes/char in UTF-8, so we batch by BYTE budget (not row count):
# flush an INSERT before its VALUES payload would exceed this, leaving margin for
# the statement header (~700 bytes) + the 100KB cap.
MAX_VALUES_BYTES = 85000

# Column order of the emitted INSERTs (must be a subset/match of db/schema.sql).
COLS = [
    "row_id", "content_id", "is_program", "facility_name", "program_name",
    "sido", "sigungu", "address", "latitude", "longitude", "price", "parking_fee",
    "time_preference", "operating_hours", "open_time", "close_time",
    "is_time_fixed", "operating_hours_remark",
    "user_type_tag", "primary_tag", "activity_nature", "indoor_outdoor", "interaction_level",
    "comment_default", "comment_type_A", "comment_type_B", "is_active", "homepage_url",
    "axis_ap", "axis_ts", "solo_ok",
    "tp_morning", "tp_day", "tp_night", "tp_any",
    "is_outdoor_park", "category_key",
    "trend_search_score", "youth_preference_score", "total_preference_weight", "base_score",
]

# time_preference -> (tp_morning, tp_day, tp_night, tp_any). Unknown -> wildcard (any=1).
TIME = {"상관없음": (0, 0, 0, 1), "아침": (1, 0, 0, 0), "낮": (0, 1, 0, 0), "낮,밤": (0, 1, 1, 0)}
SOLO = {"나홀로", "조용한동행"}        # axis_ts = 'S', solo_ok = 1
TOGETHER = {"가벼운대화", "활발한소통"}  # axis_ts = 'T'
NATURE_TAG = "자연치유형"              # is_outdoor_park trigger (with 야외)


# ---- coercion helpers ----
def b(v):  # bool string -> 1/0 (case-insensitive)
    return 1 if str(v).strip().lower() == "true" else 0


def i(v, default=0):  # -> INTEGER (tolerate "0.0")
    v = str(v).strip()
    return default if v == "" else int(float(v))


def real(v):  # -> REAL or None
    v = str(v).strip()
    return None if v == "" else float(v)


def s(v):  # -> trimmed TEXT or None
    v = "" if v is None else str(v).strip()
    return None if v == "" else v


def fscore(v):  # preference score cell -> float (blank -> 0.0)
    v = str(v).strip()
    return 0.0 if v == "" else float(v)


def lit(v):  # python value -> SQL literal
    if v is None:
        return "NULL"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"  # SQLite escapes ' as ''


def build_row(rid, m, p):
    raw_tag = s(m["user_type_tag"])
    tags = [t.strip() for t in raw_tag.split(",")] if raw_tag else []
    primary = tags[0] if tags else None

    tp_m, tp_d, tp_n, tp_a = TIME.get(m["time_preference"].strip(), (0, 0, 0, 1))

    il = m["interaction_level"].strip()
    axis_ts = "S" if il in SOLO else ("T" if il in TOGETHER else None)
    solo_ok = 1 if il in SOLO else 0

    an = m["activity_nature"].strip()
    axis_ap = "A" if an == "동적" else ("P" if an == "정적" else None)

    is_park = 1 if (m["indoor_outdoor"].strip() == "야외" and NATURE_TAG in tags) else 0
    category_key = "outdoor_park" if is_park else (primary or "기타")

    trend = fscore(p["trend_search_score"])
    youth = fscore(p["youth_preference_score"])
    weight = fscore(p["total_preference_weight"])

    values = {
        "row_id": rid,
        "content_id": s(m["content_id"]),
        "is_program": b(m["is_program"]),
        "facility_name": s(m["facility_name"]),
        "program_name": s(m["program_name"]),
        "sido": s(m["sido"]),
        "sigungu": s(m["sigungu"]),
        "address": s(m["address"]),
        "latitude": real(m["latitude"]),
        "longitude": real(m["longitude"]),
        "price": i(m["price"]),
        "parking_fee": i(m["parking_fee"]),
        "time_preference": s(m["time_preference"]),
        "operating_hours": s(m["operating_hours"]),
        "open_time": s(m["open_time"]),
        "close_time": s(m["close_time"]),
        "is_time_fixed": b(m["is_time_fixed"]),
        "operating_hours_remark": s(m["operating_hours_remark"]),
        "user_type_tag": raw_tag,
        "primary_tag": primary,
        "activity_nature": s(m["activity_nature"]),
        "indoor_outdoor": s(m["indoor_outdoor"]),
        "interaction_level": s(m["interaction_level"]),
        "comment_default": s(m["comment_default"]),
        "comment_type_A": s(m["comment_type_A"]),
        "comment_type_B": s(m["comment_type_B"]),
        "is_active": b(m["is_active"]),
        "homepage_url": s(m["homepage_url"]),
        "axis_ap": axis_ap,
        "axis_ts": axis_ts,
        "solo_ok": solo_ok,
        "tp_morning": tp_m,
        "tp_day": tp_d,
        "tp_night": tp_n,
        "tp_any": tp_a,
        "is_outdoor_park": is_park,
        "category_key": category_key,
        "trend_search_score": trend,
        "youth_preference_score": youth,
        "total_preference_weight": weight,
        "base_score": weight,
    }
    return "(" + ",".join(lit(values[c]) for c in COLS) + ")"


def main():
    collist = "(" + ",".join(COLS) + ")"
    insert_head = f"INSERT INTO {TABLE} {collist} VALUES\n"
    rid = 0
    mismatches = 0
    max_stmt = 0
    buf = []
    buf_bytes = 0

    def flush(out):
        nonlocal buf, buf_bytes, max_stmt
        if not buf:
            return
        stmt = insert_head + ",\n".join(buf) + ";\n"
        out.write(stmt)
        max_stmt = max(max_stmt, len(stmt.encode("utf-8")))
        buf = []
        buf_bytes = 0

    with open(MASTER, encoding="utf-8-sig", newline="") as mf, \
         open(SCORES, encoding="utf-8-sig", newline="") as pf, \
         open(OUT, "w", encoding="utf-8") as out:
        mr = csv.DictReader(mf)
        pr = csv.DictReader(pf)
        # NOTE: no explicit BEGIN TRANSACTION / COMMIT here. D1's remote import
        # (`wrangler d1 execute --remote --file`) manages its own transaction and
        # REJECTS explicit BEGIN TRANSACTION/SAVEPOINT. wrangler batches the
        # statements itself, so plain INSERTs are correct for both local & remote.
        out.write("-- Generated by scripts/csv_to_sql.py. Do not edit by hand.\n")
        for m, p in zip(mr, pr):
            rid += 1
            if m["content_id"] != p["content_id"]:
                mismatches += 1  # positional alignment broken — should never happen
            row_sql = build_row(rid, m, p)
            row_bytes = len(row_sql.encode("utf-8")) + 2  # +2 for ",\n" separator
            if buf and buf_bytes + row_bytes > MAX_VALUES_BYTES:
                flush(out)
            buf.append(row_sql)
            buf_bytes += row_bytes
        flush(out)

    print(f"wrote {rid} rows -> {OUT}", file=sys.stderr)
    print(f"largest statement: {max_stmt} bytes (D1 limit 100000)", file=sys.stderr)
    if mismatches:
        print(f"WARNING: {mismatches} content_id positional mismatches "
              f"(preference scores may be misaligned)", file=sys.stderr)
    else:
        print("positional join OK (content_id aligned across both CSVs)", file=sys.stderr)


if __name__ == "__main__":
    main()
