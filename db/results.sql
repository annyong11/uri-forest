-- db/results.sql — anonymous completed-test records for the 전국 distribution map.
-- Safe to run on remote without touching `solutions` (CREATE IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS results (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  animal      TEXT NOT NULL,            -- 3-char A/P·T/S·E/F
  group_key   TEXT,                     -- cli/burn/isol/mix/norm ("group" is reserved)
  sido        TEXT,                     -- short region name the user selected (서울/경기/…)
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_results_sido ON results(sido);
