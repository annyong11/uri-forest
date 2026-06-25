// src/http.js
// Shared HTTP helpers for the /api/* JSON endpoints.

/**
 * JSON response with charset + no-store caching (API responses are always fresh).
 * @param {unknown} data
 * @param {number} [status]
 * @returns {Response}
 */
export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
