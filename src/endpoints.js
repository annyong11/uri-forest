// src/endpoints.js
// The smaller /api/* endpoints: shared-place lookup + anonymous participant tracking.

import { json } from "./http.js";
import { GROUPS } from "./constants.js";
import { SELECT_COLS } from "./candidates.js";
import { formatResults } from "./format.js";

// Fetch specific places by row_id (for shared "같이 가자" links). Order preserved.
export async function handlePlaces(request, env) {
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

// Record an anonymous completed test (for the shared 전국 distribution map).
export async function handleResult(request, env) {
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
export async function handleStats(request, env) {
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
