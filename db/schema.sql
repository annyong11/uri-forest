-- db/schema.sql  (Cloudflare D1 / SQLite)
-- One row per source record. Run BEFORE db/data.sql.
--
-- IMPORTANT: content_id is NOT unique in the source (58,906 rows / 42,079 distinct
-- ids; 16,827 collisions are genuinely DIFFERENT places that reused an id across
-- data batches). So the primary key is a surrogate row_id, and content_id is a
-- plain indexed column. Booleans are INTEGER 0/1; missing values are NULL.

DROP TABLE IF EXISTS solutions;

CREATE TABLE solutions (
  -- ---- identity / type ----
  row_id                INTEGER PRIMARY KEY,   -- surrogate key (content_id is non-unique)
  content_id            TEXT,                  -- e.g. 'PLACE_00001' (non-unique!)
  is_program            INTEGER NOT NULL,      -- 1 = program, 0 = place

  -- ---- display ----
  facility_name         TEXT,
  program_name          TEXT,                  -- NULL for places

  -- ---- location ----
  sido                  TEXT,                  -- used for the 전국/거리상관없음 branch
  sigungu               TEXT,
  address               TEXT,
  latitude              REAL,                  -- NULL for the 180 coord-less rows
  longitude             REAL,

  -- ---- cost ----
  price                 INTEGER,               -- won; 0 = free
  parking_fee           INTEGER,               -- 0 = free/none, else amount

  -- ---- time ----
  time_preference       TEXT,                  -- raw: 상관없음 / 낮 / 낮,밤 / 아침
  operating_hours       TEXT,
  open_time             TEXT,                  -- 'HH:MM' or NULL
  close_time            TEXT,
  is_time_fixed         INTEGER NOT NULL,      -- 0 -> UI shows "운영시간 확인" warning
  operating_hours_remark TEXT,

  -- ---- classification (raw) ----
  user_type_tag         TEXT,                  -- comma-separated; UI splits into chips
  primary_tag           TEXT,                  -- first tag of user_type_tag
  activity_nature       TEXT,                  -- 정적 / 동적
  indoor_outdoor        TEXT,                  -- 실내 / 야외
  interaction_level     TEXT,                  -- 나홀로 / 조용한동행 / 가벼운대화 / 활발한소통

  -- ---- curation text ----
  comment_default       TEXT,
  comment_type_A        TEXT,                  -- 위로/내면치유형 (currently all NULL)
  comment_type_B        TEXT,                  -- 도전/사회복귀형 (currently all NULL)

  -- ---- lifecycle / link ----
  is_active             INTEGER NOT NULL,      -- 1 active; queries always filter is_active=1
  homepage_url          TEXT,

  -- ================= DERIVED (computed by scripts/csv_to_sql.py) =================
  -- A/P energy axis from activity_nature: 동적->'A', 정적->'P'
  axis_ap               TEXT,
  -- T/S social axis from interaction_level:
  --   활발한소통,가벼운대화 -> 'T' ; 나홀로,조용한동행 -> 'S'
  axis_ts               TEXT,
  -- 1 if interaction does not force socializing (나홀로 OR 조용한동행) — for isol/cli groups
  solo_ok               INTEGER NOT NULL DEFAULT 0,

  -- time OR-matching flags. 상관없음 -> tp_any=1 (acts as wildcard).
  tp_morning            INTEGER NOT NULL DEFAULT 0,  -- 아침
  tp_day                INTEGER NOT NULL DEFAULT 0,  -- 낮 OR 낮,밤
  tp_night              INTEGER NOT NULL DEFAULT 0,  -- 낮,밤
  tp_any                INTEGER NOT NULL DEFAULT 0,  -- 상관없음

  -- park-flood control. 1 iff indoor_outdoor='야외' AND '자연치유형' tag present.
  is_outdoor_park       INTEGER NOT NULL DEFAULT 0,
  -- stable category bucket for the exposure cap: 'outdoor_park' if is_outdoor_park
  -- else primary_tag (else '기타').
  category_key          TEXT,

  -- ================= PREFERENCE BRIDGE (positional join, default 0) =================
  trend_search_score        REAL NOT NULL DEFAULT 0,
  youth_preference_score    REAL NOT NULL DEFAULT 0,
  total_preference_weight   REAL NOT NULL DEFAULT 0,

  -- ranking seed so ORDER BY is index-friendly. = total_preference_weight today.
  base_score            REAL NOT NULL DEFAULT 0
);

-- ============================ INDEXES ============================
-- All recommendation queries filter is_active=1, so the hot indexes are PARTIAL.

-- (A) Geographic branch: bounding-box distance filter (800m / 5km / 15km).
--     latitude leads the range seek; longitude refines. Excludes inactive + coord-less rows.
CREATE INDEX idx_geo_active
  ON solutions (latitude, longitude)
  WHERE is_active = 1 AND latitude IS NOT NULL;

-- (B) 전국 / 거리상관없음 branch: sido equality + pre-sorted by score (no sort step).
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

-- (E) content_id lookups (UI links / debugging). Non-unique on purpose.
CREATE INDEX idx_content ON solutions (content_id);

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
