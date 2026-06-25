// src/recommend.js
// POST /api/recommend — the core recommendation endpoint: validate input, then run a
// relaxation ladder with a per-category diversity cap over the SQL-scored candidates.

import { json } from "./http.js";
import { GROUPS, SPACE_MAP, PER_CAT, POOL_LIMIT } from "./constants.js";
import { geoPredicate } from "./predicates.js";
import { fetchCandidates } from "./candidates.js";
import { formatResults } from "./format.js";

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
    // Relaxation ladder. We pick DIVERSE results (category cap = PER_CAT) greedily,
    // tightest step first; only widen when the cap can't be satisfied locally.
    // This keeps the park/forest flood capped instead of padding with duplicates.
    const ladder = [
      { distance, cost, time, group },                       // 1) as requested
      { distance: "1h", cost, time, group },                 // 2) widen to province
      { distance: "1h", cost: "high", time, group },         // 3) drop budget cap
      { distance: "1h", cost: "high", time, group: "norm" }, // 4) loosen group
    ];

    const seenCat = {};
    const seenNames = new Set();   // 같은 시설명 중복 제거 (content_id 중복으로 한 시설이 여러 행)
    const inTop = new Set();
    const inAll = new Set();
    const allRows = [];
    const top = [];
    let stepsUsed = 0;
    const nameKey = (r) => (r.facility_name || "").replace(/\s+/g, ""); // 공백 무시 비교 ("못된 강아지"="못된강아지")

    for (let i = 0; i < ladder.length && top.length < limit; i++) {
      const step = ladder[i];
      const geo = geoPredicate(region, district, step.distance, false);
      const rows = await fetchCandidates(env, {
        ap, ts, spaceDb, geo, group: step.group, cost: step.cost, time: step.time, poolLimit: POOL_LIMIT,
      });
      stepsUsed = i;
      for (const r of rows) {
        if (!inAll.has(r.row_id)) { inAll.add(r.row_id); allRows.push(r); }
        if (top.length >= limit) continue;
        if (inTop.has(r.row_id)) continue;
        const nm = nameKey(r);
        if (nm && seenNames.has(nm)) continue;          // skip same-facility duplicates
        const key = r.category_key || "기타";
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
        const key = r.category_key || "기타";
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
