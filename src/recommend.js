// src/recommend.js
// POST /api/recommend — the core recommendation endpoint: validate input, then run a
// relaxation ladder with a per-category diversity cap over the SQL-scored candidates.

import { json } from "./http.js";
import { GROUPS, SPACE_MAP, PER_CAT, POOL_LIMIT, RADIUS_KM, KR_BOUNDS, HEAVY_HISTORY_KEYWORDS, HEAVY_HISTORY_PENALTY } from "./constants.js";
import { fetchCandidates } from "./candidates.js";
import { formatResults } from "./format.js";

function applyHeavyHistoryPenalty(rows, group) {
  const penalty = HEAVY_HISTORY_PENALTY[group] ?? 0;
  if (penalty === 0) return rows;  // norm은 감점 없으니 바로 반환
  return rows.map(r => {
    const text = `${r.facility_name || ""} ${r.description || ""}`;
    const hasKeyword = HEAVY_HISTORY_KEYWORDS.some(k => text.includes(k));
    if (!hasKeyword) return r;
    return { ...r, score: (r.score || 0) + penalty };
  }).sort((a, b) => (b.score || 0) - (a.score || 0));
}

export async function handleRecommend(request, env) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  // ---- parse + validate (whitelist everything) ----
  const group = GROUPS.has(body.group) ? body.group : "norm";
  const animal = ["C0","C1","C2"].includes(body.animal) ? body.animal : "C0";
  const animal = ["C0","C1","C2"].includes(body.animal) ? body.animal : "C0";
  const region = typeof body.region === "string" ? body.region : "";
  const district = typeof body.district === "string" ? body.district : "";
  const space = body.space === "outdoor" ? "outdoor" : body.space === "indoor" ? "indoor" : "";
  const spaceDb = SPACE_MAP[space] || "";              // "" never matches -> +0 score, no filter
  const distance = ["walk", "30min", "1h"].includes(body.distance) ? body.distance : "1h";
  const cost = ["free", "cheap", "mid", "high"].includes(body.cost) ? body.cost : "high";
  const time = ["day", "night", "weekend"].includes(body.time) ? body.time : "weekend";
  const limit = Math.min(Math.max(parseInt(body.limit, 10) || 5, 1), 20);

  // ---- 위치 모드 결정: GPS 실거리 반경 vs 시군구 폴백 ----
  // 좌표가 한반도 범위 안이고, 선택한 시·도와 크게 어긋나지 않을 때만 GPS를 신뢰.
  // (실제 서울인데 충남을 고른 충돌 케이스 등은 GPS를 버리고 드롭다운으로 폴백)
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  const inKR =
    Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= KR_BOUNDS[0] && lat <= KR_BOUNDS[1] &&
    lng >= KR_BOUNDS[2] && lng <= KR_BOUNDS[3];
  const useGps = inKR && gpsInRegion(lat, lng, region);
  const baseRadius = RADIUS_KM[distance] || RADIUS_KM["1h"];

  try {
    // Relaxation ladder. We pick DIVERSE results (category cap = PER_CAT) greedily,
    // tightest step first; only widen when the cap can't be satisfied locally.
    // This keeps the park/forest flood capped instead of padding with duplicates.
    //   GPS 모드  : 반경을 단계적으로 넓힌다(rMult). 외곽/시골이라 후보가 적을 때 graceful 확장.
    //   시군구 모드: 선택 시군구 먼저, 부족하면 도 전체로 확장.
    const ladder = useGps
      ? [
          { rMult: 1, cost, time, group },                       // 1) 요청 반경
          { rMult: 2.5, cost, time, group },                     // 2) 반경 확장
          { rMult: 2.5, cost: "high", time, group },             // 3) 예산 캡 해제
          { rMult: 5, cost: "high", time, group: "norm" },       // 4) 군 완화
        ]
      : [
          { sigungu: true, cost, time, group },                  // 1) 선택 시군구
          { sigungu: false, cost, time, group },                 // 2) 도 전체로 확장
          { sigungu: false, cost: "high", time, group },         // 3) 예산 캡 해제
          { sigungu: false, cost: "high", time, group: "norm" }, // 4) 군 완화
        ];

    const seenCat = {};
    const seenNames = new Set();   // 같은 시설명 중복 제거 (content_id 중복으로 한 시설이 여러 행)
    const inTop = new Set();
    const inAll = new Set();
    const allRows = [];
    const top = [];
    let stepsUsed = 0;
    const nameKey = (r) => (r.facility_name || "").replace(/\s+/g, ""); // 공백 무시 비교 ("못된 강아지"="못된강아지")
    // #5: 다이버시티 캡 버킷. 문화유적 계열(large_category '문화유적' + '문화유적/스토리')은
    // 사용자에겐 같은 "문화유적"으로 보이므로 한 버킷으로 묶어 2+2=4개 중복을 막는다.
    const bucketKey = (r) => {
    const mid = r.mid_category || "";
    if (mid === "도시공원" || mid === "국공립공원") return "공원류";
    if (mid === "향토문화유적" || mid === "도보여행지(골목/스토리)") return "문화유적류";
    return r.category_key || "기타";
    };

    for (let i = 0; i < ladder.length && top.length < limit; i++) {
      const step = ladder[i];
      const geo = useGps
        ? geoRadius(lat, lng, baseRadius * step.rMult)
        : geoDistrict(region, district, step.sigungu);
      const rawRows = await fetchCandidates(env, {
        animal, spaceDb, geo, group: step.group, cost: step.cost, time: step.time, poolLimit: POOL_LIMIT,
      });
      const rows = applyHeavyHistoryPenalty(rawRows, group);
      stepsUsed = i;
      for (const r of rows) {
        if (!inAll.has(r.row_id)) { inAll.add(r.row_id); allRows.push(r); }
        if (top.length >= limit) continue;
        if (inTop.has(r.row_id)) continue;
        const nm = nameKey(r);
        if (nm && seenNames.has(nm)) continue;          // skip same-facility duplicates
        const key = bucketKey(r);
        if ((seenCat[key] || 0) >= PER_CAT) continue;   // respect the cap
        inTop.add(r.row_id);
        seenNames.add(nm);
        seenCat[key] = (seenCat[key] || 0) + 1;
        top.push(r);
      }
    }

    // Last resort: if the capped pass came up short, RAISE the per-category cap one
    // step at a time (3, 4, … up to limit) instead of removing it outright. This adds
    // the minimum extra concentration needed — e.g. if a park-dominated pool has a
    // single 미술관, that 미술관 is taken before a 3rd park — so the park/forest flood
    // stays as contained as the available candidates allow.
    let capRelaxed = false;
    for (let cap = PER_CAT + 1; top.length < limit && cap <= limit; cap++) {
      for (const r of allRows) {
        if (top.length >= limit) break;
        if (inTop.has(r.row_id)) continue;
        const nm = nameKey(r);
        if (nm && seenNames.has(nm)) continue;          // dedup names in backfill too
        const key = bucketKey(r);
        if ((seenCat[key] || 0) >= cap) continue;
        inTop.add(r.row_id); seenNames.add(nm);
        seenCat[key] = (seenCat[key] || 0) + 1;
        top.push(r); capRelaxed = true;
      }
    }

    const out = formatResults(top, group);
    return json({
      ok: true,
      group,
      animal,
      region,
      district,
      locationMode: useGps ? "gps" : "district",   // 실제 적용된 위치 기준 (검증용)
      count: out.length,
      relaxed: stepsUsed > 0 || capRelaxed,
      results: out,
    });
  } catch (e) {
    return json({ error: "query_failed", detail: String(e && e.message || e) }, 500);
  }
}
