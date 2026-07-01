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

// 거리 선택 -> 직선 반경(km). GPS 좌표가 있을 때 haversine 원 필터의 기준이 된다.
// ⚠️ 직선거리 근사다(도로/교통 미반영) — "편도 1시간"을 정확히 매핑하려면 경로탐색 API가 필요.
// 그래도 기존 "도 전체" 방식보다 훨씬 정확하고, 값은 여기서 자유롭게 튜닝 가능.
export const RADIUS_KM = { walk: 2, "30min": 20, "1h": 50 };

// 한반도 좌표 박스 [latMin, latMax, lngMin, lngMax]. 이 밖의 lat/lng는 쓰레기로 보고 GPS 무시.
export const KR_BOUNDS = [33.0, 38.7, 124.5, 131.9];

// 시·도별 대략 경계 박스 [latMin, latMax, lngMin, lngMax] (본토 기준, 넉넉하게).
// 용도: GPS 좌표가 "선택한 시·도"와 크게 어긋나면(예: 실제 서울, 충남 선택) GPS를 버리고
// 드롭다운 시군구로 폴백하기 위한 sanity check. 정밀 측정용이 아니라 충돌 감지용.
export const SIDO_BBOX = {
  "서울": [37.42, 37.70, 126.76, 127.18],
  "부산": [34.95, 35.40, 128.75, 129.30],
  "대구": [35.78, 36.02, 128.40, 128.78],
  "인천": [37.32, 37.80, 126.35, 126.80],
  "광주": [35.05, 35.27, 126.70, 127.02],
  "대전": [36.18, 36.50, 127.30, 127.56],
  "울산": [35.45, 35.78, 129.05, 129.47],
  "세종": [36.42, 36.72, 127.18, 127.40],
  "경기": [36.90, 38.30, 126.50, 127.95],
  "강원": [37.00, 38.62, 127.05, 129.40],
  "충북": [36.00, 37.25, 127.30, 128.65],
  "충남": [35.90, 37.05, 125.95, 127.60],
  "전북": [35.30, 36.30, 126.40, 127.92],
  "전남": [33.90, 35.50, 125.90, 127.60],
  "경북": [35.60, 37.10, 127.80, 129.60],
  "경남": [34.50, 35.92, 127.58, 129.30],
  "제주": [33.10, 33.62, 126.10, 126.98],
};

// Frontend space pref -> DB indoor_outdoor token. "" never matches -> +0 score, no filter.
export const SPACE_MAP = { indoor: "실내", outdoor: "야외" };

// Valid 군(group) keys; anything else is normalized to "norm".
export const GROUPS = new Set(["cli", "isol", "norm"]);

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

// 클러스터 → DB 축 매핑
export const CLUSTER_AXIS = {
  C0: { ap: "P", ts: "S" },  // 집콕힐링형
  C1: { ap: "A", ts: "T" },  // 야외활동형
  C2: { ap: "P", ts: "T" },  // 문화예술형
};

// 고립은둔 수준별 파라미터 (ipynb recommend_engine_v2 이식)
export const ISOLATION_PARAMS = {
  cli:  { programBonus: -30, socialFitRatio: -1.0 },  // 은둔
  isol: { programBonus:   0, socialFitRatio:  0.5 },  // 고립
  norm: { programBonus:  30, socialFitRatio:  1.0 },  // 일반
};

export const SOCIAL_FIT_WEIGHT = 15;

// 무거운 역사 콘텐츠 감점
export const HEAVY_HISTORY_KEYWORDS = ["고문", "대공분실", "학살", "순국", "항쟁", "의거", "추모", "희생자"];
export const HEAVY_HISTORY_PENALTY  = { cli: -100, isol: -60, norm: 0 };