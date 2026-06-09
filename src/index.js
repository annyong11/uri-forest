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
      if (url.pathname === "/api/result") return handleResult(request, env);
      if (url.pathname === "/api/stats") return handleStats(request, env);
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

// ── 속성 기반 코멘트 생성 ──────────────────────────────────────────────
// 원본 comment_default는 카테고리별 1~3개 고정 템플릿이라 placeholder 티가 남.
// 대신 (장소 성격 × 군 톤)으로 조합해 덜 반복적이고 상태에 맞는 문구를 만든다.
// row_id를 시드로 써서 장소마다 결정적으로 다른 조합을 고른다. 이름은 카드
// 제목에 이미 있으므로 코멘트엔 넣지 않는다. (comment_type_A/B가 채워지면 그걸 우선)
const DESCRIPTORS = {
  park: [
    "탁 트인 자연 속에서 아무 생각 없이 걷기 좋은 곳이에요",
    "초록 사이를 천천히 거닐며 머리를 비우기 좋아요",
    "맑은 공기 마시며 한 바퀴 걷기 좋은 곳이에요",
  ],
  outdoor: [
    "탁 트인 바깥에서 천천히 걷고 둘러보기 좋은 곳이에요",
    "바람 쐬며 가볍게 둘러보기 좋아요",
  ],
  art: [
    "조용히 작품 사이를 거니는 공간이에요",
    "그림 앞에 가만히 머무는 시간을 가질 수 있어요",
    "전시를 천천히 둘러보며 마음을 채우기 좋아요",
  ],
  museum: [
    "이야기와 전시물을 차분히 둘러보는 공간이에요",
    "천천히 둘러보며 잠시 다른 세계에 머물기 좋아요",
  ],
  performance: [
    "객석에 앉아 무대에 가만히 빠져드는 시간이에요",
    "공연 한 편에 몰입하며 잠시 쉬어가기 좋아요",
  ],
  movie: [
    "스크린 앞에 앉아 잠시 딴 세상으로 떠나기 좋아요",
    "영화 한 편에 푹 빠져드는 시간이에요",
  ],
  reading: [
    "책 사이에서 나만의 아늑한 시간을 보내기 좋아요",
    "서가를 거닐며 조용히 마음을 채우는 공간이에요",
  ],
  active: [
    "몸을 움직이며 머릿속을 비우기 좋은 곳이에요",
    "가볍게 땀 흘리며 기분을 전환하기 좋아요",
  ],
  community: [
    "따뜻한 사람들과 가벼운 체험을 즐기기 좋은 곳이에요",
    "소박한 분위기 속에서 가볍게 어울리기 좋아요",
  ],
  generic: [
    "잠시 일상에서 벗어나 머물기 좋은 곳이에요",
    "가볍게 들러 나만의 시간을 보내기 좋아요",
  ],
};

const TONE = {
  cli:  ["부담 갖지 말고, 마음 내킬 때 잠깐이면 충분해요.", "꼭 가지 않아도 괜찮아요. 이런 곳이 있다는 것만 기억해요.", "그냥 이런 곳이 있구나, 하고 알아두기만 해도 돼요."],
  burn: ["에너지 많이 쓰지 않아도 되는 곳이라 지금 딱 좋아요.", "짧게 들렀다 와도 충분해요.", "느긋하게, 쉬엄쉬엄 둘러봐도 좋아요."],
  isol: ["혼자 가도 전혀 이상하지 않은 곳이에요.", "누구와 말 섞지 않아도 괜찮아요.", "조용히 나만의 속도로 머물다 와도 돼요."],
  mix:  ["작게, 부담 없는 선에서 시작해봐요.", "무리하지 말고 혼자 조용히 다녀와도 좋아요.", "편한 마음으로, 한 걸음만 떼어봐요."],
  norm: ["오늘 같은 날 가볍게 다녀오기 좋아요.", "마음 가는 대로 편하게 즐겨봐요.", "기분 전환 삼아 한번 들러봐요."],
};

function archetypeOf(r) {
  const c = r.category_key || "";
  if (r.is_outdoor_park) return "park";
  if (r.indoor_outdoor === "야외") return "outdoor";
  if (/미술|갤러리|전시|예술감상/.test(c)) return "art";
  if (/박물관|기념관|유적|향토/.test(c)) return "museum";
  if (/공연|연극|예술센터|문화센터|클래식/.test(c)) return "performance";
  if (/영화|시네마|극장/.test(c)) return "movie";
  if (/도서|문화탐색|교양/.test(c)) return "reading";
  if (/액티브|체육|오락|스포츠/.test(c)) return "active";
  if (/관계|체험|마을|농어촌/.test(c)) return "community";
  return "generic";
}

function commentSeed(r) {
  if (Number.isInteger(r.row_id)) return r.row_id;
  let h = 0;
  const s = r.facility_name || "";
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function composeComment(r, group, nudge = 0) {
  const dPool = DESCRIPTORS[archetypeOf(r)] || DESCRIPTORS.generic;
  const tPool = TONE[group] || TONE.norm;
  const seed = commentSeed(r);
  const desc = dPool[(seed + nudge) % dPool.length];
  const tone = tPool[(Math.floor(seed / 7) + nudge) % tPool.length];
  return `${desc}. ${tone}`;
}

function pickComment(r, group) {
  const want = GROUP_COMMENT[group];
  if (want === "A" && r.comment_type_A) return r.comment_type_A; // 향후 LLM 생성분 우선
  if (want === "B" && r.comment_type_B) return r.comment_type_B;
  return composeComment(r, group) || r.comment_default || "";
}

// Map rows to output, ensuring no two cards share the same generated comment
// (nudge the variant until unique within this result set).
function formatResults(rows, group) {
  const seen = new Set();
  return rows.map((r) => {
    const item = formatRow(r, group);
    let c = item.comment, n = 0;
    while (c && seen.has(c) && n < 8) c = composeComment(r, group, ++n);
    seen.add(c);
    item.comment = c;
    return item;
  });
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
    // 네이버 지도 검색 링크 — 이름+시군구로 항상 생성 (homepage_url은 18%만 채워져 있어 길찾기 보강)
    map_url: "https://map.naver.com/p/search/" +
      encodeURIComponent(`${r.facility_name || name} ${r.sigungu || ""}`.trim()),
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

    const out = formatResults(top, group);
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

// Record an anonymous completed test (for the shared 전국 distribution map).
async function handleResult(request, env) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  let b;
  try { b = await request.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const animal = typeof b.animal === "string" ? b.animal.toUpperCase().slice(0, 3) : "";
  if (!/^[AP][TS][EF]$/.test(animal)) return json({ error: "bad_animal" }, 400);
  const group = GROUPS.has(b.group) ? b.group : "norm";
  const region = (typeof b.region === "string" ? b.region : "").slice(0, 20);
  try {
    await env.DB.prepare(
      "INSERT INTO results (animal, group_key, sido, created_at) VALUES (?, ?, ?, datetime('now'))"
    ).bind(animal, group, region).run();
    return json({ ok: true });
  } catch (e) {
    return json({ error: "insert_failed", detail: String((e && e.message) || e) }, 500);
  }
}

// Aggregate participant distribution by 시도 + animal (for the map).
async function handleStats(request, env) {
  try {
    const { results } = await env.DB.prepare(
      "SELECT sido, animal, COUNT(*) AS c FROM results GROUP BY sido, animal"
    ).all();
    const byRegion = {};
    const byAnimal = {};
    let total = 0;
    for (const r of results || []) {
      total += r.c;
      byAnimal[r.animal] = (byAnimal[r.animal] || 0) + r.c;
      if (!byRegion[r.sido]) byRegion[r.sido] = { count: 0, animals: {} };
      byRegion[r.sido].count += r.c;
      byRegion[r.sido].animals[r.animal] = (byRegion[r.sido].animals[r.animal] || 0) + r.c;
    }
    return json({ ok: true, total, byRegion, byAnimal });
  } catch (e) {
    // results table may not exist yet — return empty stats rather than 500
    return json({ ok: true, total: 0, byRegion: {}, byAnimal: {}, note: String((e && e.message) || e) });
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
    const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
    return json({ ok: true, results: formatResults(ordered, "norm") });
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
