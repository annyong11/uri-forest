// src/constants.js
// Lookup tables and tunable knobs. No logic here — just data the engine reads.

// Frontend uses short 시·도 names; DB stores full names (plus a small dirty tail).
// Map each short name to every DB sido string that should match it.
export const SIDO_MAP = {
  "서울": ["서울특별시"],
  "부산": ["부산광역시"],
  "대구": ["대구광역시"],
  "인천": ["인천광역시"],
  "광주": ["광주광역시"],
  "대전": ["대전광역시"],
  "울산": ["울산광역시"],
  "세종": ["세종특별자치시", "세종특별시", "세종"],
  "경기": ["경기도", "경개도"],
  "강원": ["강원특별자치도", "강원도"],
  "충북": ["충청북도"],
  "충남": ["충청남도"],
  "전북": ["전북특별자치도", "전라북도"],
  "전남": ["전라남도", "전나남도"],
  "경북": ["경상북도"],
  "경남": ["경상남도"],
  "제주": ["제주특별자치도", "제주도"],
};

// 세종 stores sigungu as 읍/면 units (not "세종시"), so always filter at sido level there.
export const SIDO_ONLY_REGIONS = new Set(["세종"]);

// Frontend space pref -> DB indoor_outdoor token. "" never matches -> +0 score, no filter.
export const SPACE_MAP = { indoor: "실내", outdoor: "야외" };

// Valid 군(group) keys; anything else is normalized to "norm".
export const GROUPS = new Set(["cli", "burn", "isol", "mix", "norm"]);

// Tunable ranking weights. Personality matches dominate. base_score is constant 0 in
// the current dataset (no preference scores exist), so the W.pop term contributes
// nothing — ranking is personality fit + RANDOM() tie-break. The term/weight are kept
// so a popularity prior can be reintroduced later without touching the formula.
export const W = { ap: 2.0, ts: 2.0, space: 1.0, pop: 0.9 };

// Diversity cap: at most this many results may share one category_key (park-flood control).
export const PER_CAT = 2;

// How many top-scored candidates each relaxation step pulls from D1. Large enough that
// lower-scored but more DIVERSE rows still enter the pool in park-heavy regions.
export const POOL_LIMIT = 300;
