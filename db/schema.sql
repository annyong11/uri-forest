-- db/schema.sql  (Cloudflare D1 / SQLite)
-- One row per source record. Run BEFORE db/data.sql.
--
-- SOURCE: data/recommend_master_db.csv (single file — replaces the old two-file
-- master+preference layout and its positional join). content_id is now UNIQUE
-- (57,359 distinct / 57,359 rows), so the old surrogate-key hazard is gone — but
-- we KEEP a sequential row_id PK to minimize blast radius (dedup/share/comment-seed
-- in src/index.js all key off row_id). Booleans are INTEGER 0/1; missing values NULL.

DROP TABLE IF EXISTS solutions;

CREATE TABLE solutions (
  -- ---- identity / type ----
  row_id                INTEGER PRIMARY KEY,   -- surrogate key (stable across loads)
  content_id            TEXT,                  -- e.g. 'PLACE_00001' (UNIQUE in this dataset)
  is_program            INTEGER NOT NULL,      -- 1 = program, 0 = place

  -- ---- display ----
  facility_name         TEXT,
  program_name          TEXT,                  -- NULL for places (filled iff is_program=1)

  -- ---- classification (raw taxonomy) ----
  source                TEXT,                  -- provenance, 20 values (e.g. 도시공원)
  large_category        TEXT,                  -- 9 values (자연 / 문화시설 / 문화유적 / ...)
  mid_category          TEXT,                  -- 20 values; nests under large_category

  -- ---- location ----
  sido                  TEXT,
  sigungu               TEXT,
  address               TEXT,
  latitude              REAL,                  -- from CSV `lat` (NULL for the ~19 coord-less rows)
  longitude             REAL,                  -- from CSV `lon`

  -- ---- cost (price known for only ~3.4% of rows!) ----
  price                 INTEGER,               -- won; NULL = UNKNOWN (NOT 0). 0 = explicitly free.
  is_free               INTEGER NOT NULL DEFAULT 0,  -- 1 only when source says free
  price_known           INTEGER NOT NULL DEFAULT 0,  -- 1 if price/is_free is real data
  price_raw             TEXT,                  -- original price text (e.g. '무료', '유료')

  -- ---- time (open/close known for only ~8% of rows) ----
  open_time             TEXT,                  -- 'HH:MM' or NULL
  close_time            TEXT,
  is_time_fixed         INTEGER NOT NULL DEFAULT 0,  -- 0 -> UI shows "운영시간 확인" warning
  operating_hours_remark TEXT,
  closed_day            TEXT,

  -- ---- contact / link / copy ----
  tel                   TEXT,
  homepage_url          TEXT,                  -- from CSV `homepage`
  description           TEXT,                  -- free-text (53.8% filled)

  -- ---- recommendation attributes (raw) ----
  indoor_outdoor        TEXT,                  -- mapped from space_type: 실외->'야외', else 실내/혼합/온라인
  social_mode           TEXT,                  -- 1인가능 / 1인전용 / 소그룹 / 그룹
  social_intensity_score INTEGER NOT NULL DEFAULT 1,  -- 0..3 group-intensity ladder
  content_mode          TEXT,                  -- 감각형 / 사고형 / 혼합
  last_updated          TEXT,

  -- ---- lifecycle ----
  is_active             INTEGER NOT NULL DEFAULT 1,  -- synthesized (no source col); junk row -> 0

  -- ================= DERIVED (computed by scripts/csv_to_sql.py) =================
  -- A/P energy axis. NOTE: the new file has no 정적/동적 column; content_mode
  -- (감각형/사고형) is used as a PROXY: 감각형->'A', 사고형->'P', 혼합->NULL.
  axis_ap               TEXT,
  -- T/S social axis from social_mode: 1인가능,1인전용 -> 'S' ; 소그룹,그룹 -> 'T'
  axis_ts               TEXT,
  -- 1 if visiting alone is fine (social_mode in 1인가능 / 1인전용) — for isol/cli/mix groups
  solo_ok               INTEGER NOT NULL DEFAULT 0,

  -- park-flood control. 1 iff mid_category in (도시공원, 국공립공원).
  is_outdoor_park       INTEGER NOT NULL DEFAULT 0,
  -- diversity-cap bucket: 'outdoor_park' for parks, else mid_category (else '기타').
  category_key          TEXT,

  -- ranking prior. No preference scores exist in the new file -> constant 0
  -- (W.pop term in src/index.js becomes inert; ranking = personality fit + RANDOM tie-break).
  -- Column kept for forward-compat if a prior is reintroduced later.
  base_score            REAL NOT NULL DEFAULT 0
);

-- ============================ INDEXES ============================
-- All recommendation queries filter is_active=1, so the hot indexes are PARTIAL.

-- (A) Geographic distance branch: lat/lon now populated for 99.97% of rows.
CREATE INDEX idx_geo_active
  ON solutions (latitude, longitude)
  WHERE is_active = 1 AND latitude IS NOT NULL;

-- (B) 전국 / 거리상관없음 branch: sido equality (base_score is constant now).
CREATE INDEX idx_sido_score
  ON solutions (sido, base_score DESC)
  WHERE is_active = 1;

-- (C) Group/personality + place/program split selectivity.
CREATE INDEX idx_filter
  ON solutions (is_program, axis_ap, axis_ts, solo_ok)
  WHERE is_active = 1;

-- (D) Category-cap backfill queries.
CREATE INDEX idx_category
  ON solutions (category_key)
  WHERE is_active = 1;

-- (E) content_id lookups (UI links / debugging). UNIQUE in this dataset.
CREATE UNIQUE INDEX idx_content ON solutions (content_id);

-- ============================ RESULTS (참여자 분포 트래킹) ============================
-- Anonymous record per completed test, for the 전국 회복동물 분포 map.
CREATE TABLE IF NOT EXISTS results (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  animal      TEXT NOT NULL,
  group_key   TEXT,
  sido        TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_results_sido ON results(sido);
