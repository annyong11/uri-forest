// src/index.js
// ES module Worker entry point. /api/* is routed here (run_worker_first in
// wrangler.jsonc); every other path falls through to the static assets in ./public/.
// All logic lives in the sibling modules — this file is just the router.

import { json } from "./http.js";
import { handleRecommend } from "./recommend.js";
import { handlePlaces, handleResult, handleStats } from "./endpoints.js";

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
