// src/index.js
// ES module Worker. /api/* is handled here (run_worker_first in wrangler.jsonc);
// every other path falls through to the static assets in ./public/.

export default {
  /**
   * @param {Request} request
   * @param {{ DB: D1Database, ASSETS: Fetcher }} env
   */
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      if (url.pathname === "/api/recommend") return handleRecommend(request, env);
      if (url.pathname === "/api/places") return handlePlaces(request, env);
      return json({ error: "not_found" }, 404);
    }
    return env.ASSETS.fetch(request);
  },
};

// ──────────────────────────────────────────────────────────────────────────
// Lookup tables
// ──────────────────────────────────────────────────────────────────────────

// Frontend uses short 시·도 names; DB stores full names (plus a small dirty tail).
// Map each short name to every DB sido string that should match it.
const SIDO_MAP = {
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
const SIDO_ONLY_REGIONS = new Set(["세종"]);

const SPACE_MAP = { indoor: "실내", outdoor: "야외" };

// Which curation comment to prefer per group. comment_type_A/B are currently
// empty in the data, so this falls back to comment_default — but the logic is ready.
const GROUP_COMMENT = {
  cli: "A", burn: "A", mix: "A", // 위로/내면치유형
  isol: "B", norm: "B",          // 도전/사회복귀형
};

// ──────────────────────────────────────────────────────────────────────────
// Filter fragment builders (all SQL fragments come from whitelisted enums — no
// user free-text is ever concatenated into SQL; user strings are bound as params)
// ──────────────────────────────────────────────────────────────────────────

// 군(group) filter, re-expressed against DB columns (validated for selectivity).
function groupPredicate(group) {
  switch (group) {
    case "cli":  return "solo_ok = 1 AND activity_nature = '정적' AND price = 0";
    case "burn": return "activity_nature = '정적'";
    case "isol": return "solo_ok = 1";
    case "mix":  return "solo_ok = 1 AND activity_nature = '정적'";
    case "norm":
    default:     return "1 = 1";
  }
}

function costPredicate(cost) {
  switch (cost) {
    case "free":  return "price = 0";
    case "cheap": return "price < 10000";
    case "mid":   return "price < 30000";
    case "high":
    default:      return "1 = 1";
  }
}

// time_preference OR-match via precomputed flags (상관없음 => tp_any acts as wildcard).
function timePredicate(time) {
  switch (time) {
    case "day":   return "(tp_day = 1 OR tp_any = 1)";
    case "night": return "(tp_night = 1 OR tp_any = 1)";
    case "weekend":
    default:      return "1 = 1"; // weekend is a free-day pref, not a time-of-day filter
  }
}

// Geographic predicate. Returns { sql, params }.
//   walk / 30min -> sido + sigungu ; 1h (or sido-only regions) -> sido whole province
function geoPredicate(region, district, distance, sidoOnly) {
  const sidos = SIDO_MAP[region] || [];
  if (sidos.length === 0) return { sql: "1 = 1", params: [] }; // unknown region -> nationwide
  const inList = sidos.map(() => "?").join(",");
  const useSigungu = !sidoOnly && district && distance !== "1h" && !SIDO_ONLY_REGIONS.has(region);
  if (useSigungu) {
    return { sql: `sido IN (${inList}) AND sigungu = ?`, params: [...sidos, district] };
  }
  return { sql: `sido IN (${inList})`, params: [...sidos] };
}

// ──────────────────────────────────────────────────────────────────────────
// Candidate query
// ──────────────────────────────────────────────────────────────────────────

const SELECT_COLS = `
  row_id, content_id, is_program, facility_name, program_name,
  sido, sigungu, address, latitude, longitude, price, parking_fee,
  time_preference, is_time_fixed, operating_hours_remark,
  user_type_tag, activity_nature, indoor_outdoor, interaction_level,
  comment_default, comment_type_A, comment_type_B, homepage_url,
  category_key, is_outdoor_park, base_score`;

async function fetchCandidates(env, { ap, ts, spaceDb, geo, group, cost, time, poolLimit }) {
  // Personality score computed in SQL. Scoring params (?,?,?,?) appear in SELECT,
  // so they are bound FIRST, before the geo params in WHERE.
  const sql =
    `SELECT ${SELECT_COLS},
       ( (axis_ap = ?) * 2
         + ( (axis_ts = ?) OR (? = 'S' AND solo_ok = 1) ) * 2
         + (indoor_outdoor = ?) * 1
         + base_score ) AS score
     FROM solutions
     WHERE is_active = 1
       AND ${geo.sql}
       AND ${groupPredicate(group)}
       AND ${costPredicate(cost)}
       AND ${timePredicate(time)}
     ORDER BY score DESC, base_score DESC, RANDOM()
     LIMIT ?`;
  const params = [ap, ts, ts, spaceDb, ...geo.params, poolLimit];
  const { results } = await env.DB.prepare(sql).bind(...params).all();
  return results || [];
}

// ──────────────────────────────────────────────────────────────────────────
// Post-processing
// ──────────────────────────────────────────────────────────────────────────

function priceLabel(price) {
  if (price == null) return "정보 없음";
  if (price === 0) return "무료";
  return `${Number(price).toLocaleString("ko-KR")}원`;
}

function pickEmoji(r) {
  if (r.is_program) return "🎟️";
  if (r.indoor_outdoor === "야외") return r.is_outdoor_park ? "🌳" : "🏞️";
  const t = r.category_key || "";
  if (t.includes("박물관") || t.includes("전시")) return "🖼️";
  if (t.includes("미술")) return "🎨";
  if (t.includes("공연") || t.includes("연극") || t.includes("클래식")) return "🎭";
  if (t.includes("영화")) return "🎬";
  if (t.includes("도서") || t.includes("교양")) return "📚";
  if (t.includes("관계")) return "🤝";
  return "🏛️";
}

function pickComment(r, group) {
  const want = GROUP_COMMENT[group];
  if (want === "A" && r.comment_type_A) return r.comment_type_A;
  if (want === "B" && r.comment_type_B) return r.comment_type_B;
  return r.comment_default || "";
}

function formatRow(r, group) {
  const tags = (r.user_type_tag || "")
    .split(",").map((t) => t.trim()).filter(Boolean);
  const name = r.is_program ? (r.program_name || r.facility_name) : r.facility_name;
  const where = [r.sido, r.sigungu].filter(Boolean).join(" ");
  return {
    row_id: r.row_id,            // surrogate key — used to pin/share exact places
    content_id: r.content_id,
    is_program: !!r.is_program,
    name,
    facility_name: r.facility_name,
    where,
    address: r.address,
    lat: r.latitude,
    lng: r.longitude,
    price: r.price,
    price_label: priceLabel(r.price),
    parking_free: r.parking_fee === 0,
    tags,
    category_key: r.category_key,
    indoor_outdoor: r.indoor_outdoor,
    activity_nature: r.activity_nature,
    interaction_level: r.interaction_level,
    time_preference: r.time_preference,
    time_warning: r.is_time_fixed === 0, // "방문 전 운영시간 확인" 안내 대상
    operating_remark: r.operating_hours_remark,
    comment: pickComment(r, group),
    homepage_url: r.homepage_url,
    emoji: pickEmoji(r),
    info: `${where} · ${priceLabel(r.price)}`,
    score: r.score,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Endpoint
// ──────────────────────────────────────────────────────────────────────────

const GROUPS = new Set(["cli", "burn", "isol", "mix", "norm"]);

async function handleRecommend(request, env) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  // ---- parse + validate (whitelist everything) ----
  const group = GROUPS.has(body.group) ? body.group : "norm";
  const animal = typeof body.animal === "string" ? body.animal.toUpperCase() : "PSF";
  const ap = animal[0] === "A" ? "A" : "P";
  const ts = animal[1] === "T" ? "T" : "S";
  const region = typeof body.region === "string" ? body.region : "";
  const district = typeof body.district === "string" ? body.district : "";
  const space = body.space === "outdoor" ? "outdoor" : body.space === "indoor" ? "indoor" : "";
  const spaceDb = SPACE_MAP[space] || "";              // "" never matches -> +0 score, no filter
  const distance = ["walk", "30min", "1h"].includes(body.distance) ? body.distance : "1h";
  const cost = ["free", "cheap", "mid", "high"].includes(body.cost) ? body.cost : "high";
  const time = ["day", "night", "weekend"].includes(body.time) ? body.time : "weekend";
  const limit = Math.min(Math.max(parseInt(body.limit, 10) || 5, 1), 20);

  try {
    // Relaxation ladder. We pick DIVERSE results (category cap = 2) greedily,
    // tightest step first; only widen when the cap can't be satisfied locally.
    // This keeps the park/forest flood capped instead of padding with duplicates.
    const ladder = [
      { distance, cost, time, group },                            // 1) as requested
      { distance: "1h", cost, time, group },                      // 2) widen to province
      { distance: "1h", cost: "high", time, group },              // 3) drop budget cap
      { distance: "1h", cost: "high", time: "weekend", group },   // 4) drop time-of-day
      { distance: "1h", cost: "high", time: "weekend", group: "norm" }, // 5) loosen group
    ];
    const PER_CAT = 2;

    const seenCat = {};
    const inTop = new Set();
    const inAll = new Set();
    const allRows = [];
    const top = [];
    let stepsUsed = 0;

    for (let i = 0; i < ladder.length && top.length < limit; i++) {
      const step = ladder[i];
      const geo = geoPredicate(region, district, step.distance, false);
      const rows = await fetchCandidates(env, {
        ap, ts, spaceDb, geo, group: step.group, cost: step.cost, time: step.time, poolLimit: 120,
      });
      stepsUsed = i;
      for (const r of rows) {
        if (!inAll.has(r.row_id)) { inAll.add(r.row_id); allRows.push(r); }
        if (top.length >= limit) continue;
        if (inTop.has(r.row_id)) continue;
        const key = r.category_key || "기타";
        if ((seenCat[key] || 0) >= PER_CAT) continue;   // respect the cap
        inTop.add(r.row_id);
        seenCat[key] = (seenCat[key] || 0) + 1;
        top.push(r);
      }
    }

    // Last resort: only if even the widest, group-loosened search couldn't find
    // `limit` diverse items, pad ignoring the cap so the UI still gets a full set.
    let capRelaxed = false;
    if (top.length < limit) {
      for (const r of allRows) {
        if (top.length >= limit) break;
        if (inTop.has(r.row_id)) continue;
        inTop.add(r.row_id); top.push(r); capRelaxed = true;
      }
    }

    const out = top.map((r) => formatRow(r, group));
    return json({
      ok: true,
      group,
      animal: ap + ts + (animal[2] === "E" ? "E" : "F"),
      region,
      district,
      count: out.length,
      relaxed: stepsUsed > 0 || capRelaxed,
      results: out,
    });
  } catch (e) {
    return json({ error: "query_failed", detail: String(e && e.message || e) }, 500);
  }
}

// Fetch specific places by row_id (for shared "같이 가자" links). Order preserved.
async function handlePlaces(request, env) {
  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
  const raw = new URL(request.url).searchParams.get("ids") || "";
  const ids = raw
    .split(",")
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(0, 20);
  if (ids.length === 0) return json({ ok: true, results: [] });
  try {
    const ph = ids.map(() => "?").join(",");
    const { results } = await env.DB.prepare(
      `SELECT ${SELECT_COLS} FROM solutions WHERE is_active = 1 AND row_id IN (${ph})`
    ).bind(...ids).all();
    const byId = new Map((results || []).map((r) => [r.row_id, r]));
    const ordered = ids.map((id) => byId.get(id)).filter(Boolean).map((r) => formatRow(r, "norm"));
    return json({ ok: true, results: ordered });
  } catch (e) {
    return json({ error: "query_failed", detail: String((e && e.message) || e) }, 500);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
