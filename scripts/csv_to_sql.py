#!/usr/bin/env python3
"""
CSV -> Cloudflare D1 bulk-import builder (stdlib only).

Reads the single source CSV (data/recommend_master_db.csv) and emits db/data.sql
(batched multi-row INSERTs). Run AFTER creating the table with db/schema.sql.

    python3 scripts/csv_to_sql.py
    wrangler d1 execute uri-forest-db --local  --file=./db/schema.sql
    wrangler d1 execute uri-forest-db --local  --file=./db/data.sql

This replaces the OLD two-file layout (master + culture_preference_scoring_table,
joined positionally). The new file is self-contained:

  - content_id is UNIQUE here (no surrogate-key collision hazard), but we still emit
    a sequential row_id PK to keep src/index.js (dedup / share links / comment seed)
    unchanged.
  - No preference scores exist -> base_score is constant 0 (the W.pop ranking term
    is inert; ranking = personality fit + RANDOM tie-break).
  - price is UNKNOWN for ~96.6% of rows -> stored NULL (NOT 0); is_free/price_known
    carry the real signal.
  - No time_preference column -> no tp_* flags (the time-of-day filter is dropped).

Derived axes (see db/schema.sql for column docs):
  axis_ap  <- content_mode  (감각형->'A', 사고형->'P', 혼합->NULL)   # PROXY for old 정적/동적
  axis_ts  <- social_mode   (1인가능,1인전용->'S' ; 소그룹,그룹->'T')
  solo_ok  <- social_mode in {1인가능, 1인전용}
  indoor_outdoor <- space_type  (실외->'야외' ; else passthrough 실내/혼합/온라인)
  is_outdoor_park / category_key <- mid_category
"""
import csv
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "data", "recommend_master_db.csv")
OUT = os.path.join(ROOT, "db", "data.sql")
TABLE = "solutions"
# D1 rejects any single SQL statement over 100,000 bytes ("Statement too long").
# Korean text is 3 bytes/char in UTF-8, so we batch by BYTE budget (not row count).
MAX_VALUES_BYTES = 85000

# Column order of the emitted INSERTs (must match db/schema.sql).
COLS = [
    "row_id", "content_id", "is_program", "facility_name", "program_name",
    "source", "large_category", "mid_category",
    "sido", "sigungu", "address", "latitude", "longitude",
    "price", "is_free", "price_known", "price_raw",
    "open_time", "close_time", "is_time_fixed", "operating_hours_remark", "closed_day",
    "tel", "homepage_url", "description",
    "indoor_outdoor", "social_mode", "social_intensity_score", "content_mode", "last_updated",
    "is_active",
    "axis_ap", "axis_ts", "solo_ok", "is_outdoor_park", "category_key", "base_score",
]

SOLO_MODES = {"1인가능", "1인전용"}             # axis_ts='S', solo_ok=1 ; else 'T'
PARK_MIDS = {"도시공원", "국공립공원"}           # is_outdoor_park / category_key='outdoor_park'
AP_FROM_CONTENT = {"감각형": "A", "사고형": "P"}  # 혼합 / unknown -> NULL


# ---- coercion helpers ----
def b(v):  # bool string -> 1/0 (case-insensitive; handles True/False/true/false)
    return 1 if str(v).strip().lower() == "true" else 0


def i(v, default=0):  # -> INTEGER (tolerate "0.0"); blank -> default
    v = str(v).strip()
    return default if v == "" else int(float(v))


def price_int(v):  # -> INTEGER or None (blank price means UNKNOWN, not free)
    v = str(v).strip()
    return None if v == "" else int(float(v))


def real(v):  # -> REAL or None
    v = str(v).strip()
    return None if v == "" else float(v)


def s(v):  # -> trimmed TEXT or None
    v = "" if v is None else str(v).strip()
    return None if v == "" else v


def lit(v):  # python value -> SQL literal
    if v is None:
        return "NULL"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"  # SQLite escapes ' as ''


def build_row(rid, m):
    facility = s(m["facility_name"])
    space = (m["space_type"] or "").strip()
    social = (m["social_mode"] or "").strip()
    content = (m["content_mode"] or "").strip()
    mid = (m["mid_category"] or "").strip()

    indoor_outdoor = "야외" if space == "실외" else (space or None)
    axis_ap = AP_FROM_CONTENT.get(content)               # None for 혼합/unknown
    axis_ts = "S" if social in SOLO_MODES else "T"
    solo_ok = 1 if social in SOLO_MODES else 0
    is_park = 1 if mid in PARK_MIDS else 0
    category_key = "outdoor_park" if is_park else (mid or "기타")
    # Synthesize lifecycle: every row active, except the one junk row with no name.
    is_active = 1 if facility else 0

    values = {
        "row_id": rid,
        "content_id": s(m["content_id"]),
        "is_program": b(m["is_program"]),
        "facility_name": facility,
        "program_name": s(m["program_name"]),
        "source": s(m["source"]),
        "large_category": s(m["large_category"]),
        "mid_category": s(m["mid_category"]),
        "sido": s(m["sido"]),
        "sigungu": s(m["sigungu"]),
        "address": s(m["address"]),
        "latitude": real(m["lat"]),
        "longitude": real(m["lon"]),
        "price": price_int(m["price"]),
        "is_free": b(m["is_free"]),
        "price_known": b(m["price_known"]),
        "price_raw": s(m["price_raw"]),
        "open_time": s(m["open_time"]),
        "close_time": s(m["close_time"]),
        "is_time_fixed": b(m["is_time_fixed"]),
        "operating_hours_remark": s(m["operating_hours_remark"]),
        "closed_day": s(m["closed_day"]),
        "tel": s(m["tel"]),
        "homepage_url": s(m["homepage"]),
        "description": s(m["description"]),
        "indoor_outdoor": indoor_outdoor,
        "social_mode": s(m["social_mode"]),
        "social_intensity_score": i(m["social_intensity_score"], 1),
        "content_mode": s(m["content_mode"]),
        "last_updated": s(m["last_updated"]),
        "is_active": is_active,
        "axis_ap": axis_ap,
        "axis_ts": axis_ts,
        "solo_ok": solo_ok,
        "is_outdoor_park": is_park,
        "category_key": category_key,
        "base_score": 0.0,
    }
    return "(" + ",".join(lit(values[c]) for c in COLS) + ")"


def main():
    collist = "(" + ",".join(COLS) + ")"
    insert_head = f"INSERT INTO {TABLE} {collist} VALUES\n"
    rid = 0
    inactive = 0
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

    with open(SRC, encoding="utf-8-sig", newline="") as mf, \
         open(OUT, "w", encoding="utf-8") as out:
        mr = csv.DictReader(mf)
        # NOTE: no explicit BEGIN TRANSACTION / COMMIT — D1's remote import manages its
        # own transaction and REJECTS explicit transaction statements. Plain INSERTs are
        # correct for both --local and --remote.
        out.write("-- Generated by scripts/csv_to_sql.py from recommend_master_db.csv. Do not edit by hand.\n")
        for m in mr:
            rid += 1
            if not s(m["facility_name"]):
                inactive += 1
            row_sql = build_row(rid, m)
            row_bytes = len(row_sql.encode("utf-8")) + 2  # +2 for ",\n" separator
            if buf and buf_bytes + row_bytes > MAX_VALUES_BYTES:
                flush(out)
            buf.append(row_sql)
            buf_bytes += row_bytes
        flush(out)

    print(f"wrote {rid} rows -> {OUT}", file=sys.stderr)
    print(f"largest statement: {max_stmt} bytes (D1 limit 100000)", file=sys.stderr)
    print(f"is_active=0 (blank facility_name): {inactive}", file=sys.stderr)


if __name__ == "__main__":
    main()
