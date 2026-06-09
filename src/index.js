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

    // ---- API surface ----
    if (url.pathname.startsWith("/api/")) {
      if (url.pathname === "/api/recommend") {
        return handleRecommend(request, env);
      }
      return json({ error: "not_found" }, 404);
    }

    // ---- Everything else: serve the static site (index.html, assets) ----
    return env.ASSETS.fetch(request);
  },
};

// STUB ONLY (Phase 0). Phase 2 implements the real query:
//   성향 filter (group + axis_ap/axis_ts/solo_ok)
//   → variable-radius distance filter (800m / 5km / 15km / sido)
//   → category-exposure cap (park-flood control)
//   → preference-weight boost (base_score) → Top N
async function handleRecommend(request, env) {
  if (request.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  // Smoke-test query so we can verify the D1 binding end-to-end once data is loaded.
  // Safe even before data exists (returns count 0); remove/replace in Phase 2.
  let count = null;
  try {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM solutions WHERE is_active = 1"
    ).first();
    count = row ? row.n : null;
  } catch (e) {
    // Table may not exist yet on a fresh DB — that's fine for the stub.
    count = `db_not_ready: ${e.message}`;
  }

  return json({
    ok: true,
    stub: true,
    message: "recommendation logic not implemented yet (Phase 2)",
    active_rows: count,
    results: [],
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
