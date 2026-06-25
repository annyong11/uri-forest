// src/predicates.js
// SQL WHERE-fragment builders. Every fragment comes from a whitelisted enum — no user
// free-text is ever concatenated into SQL; user strings are bound as params elsewhere.

import { SIDO_MAP, SIDO_ONLY_REGIONS } from "./constants.js";

// 군(group) filter, re-expressed against DB columns (validated for selectivity).
// 정적(passive) intent maps to axis_ap='P' (사고형) — the new file has no
// activity_nature column. The old cli "price = 0" hard filter is dropped: price is
// unknown for ~96.6% of rows, so requiring it would collapse cli to a handful of rows.
export function groupPredicate(group) {
  switch (group) {
    case "cli":  return "solo_ok = 1 AND axis_ap = 'P'";
    case "burn": return "axis_ap = 'P'";
    case "isol": return "solo_ok = 1";
    case "mix":  return "solo_ok = 1 AND axis_ap = 'P'";
    case "norm":
    default:     return "1 = 1";
  }
}

// price is real data for only ~3.4% of rows; the rest are price_known=0 (UNKNOWN, not
// free). Unknown-price rows stay ELIGIBLE for cheap/mid (so a budget filter doesn't
// wipe the catalog); only 'free' requires an explicit is_free flag.
export function costPredicate(cost) {
  switch (cost) {
    case "free":  return "is_free = 1";
    case "cheap": return "(price_known = 0 OR price < 10000)";
    case "mid":   return "(price_known = 0 OR price < 30000)";
    case "high":
    default:      return "1 = 1";
  }
}

// Time-of-day filtering is inert: the new file has no time_preference and open/close
// hours for only ~8% of rows. Kept as a no-op so the body.time param stays accepted.
export function timePredicate(_time) {
  return "1 = 1";
}

// Geographic predicate. Returns { sql, params }.
//   walk / 30min -> sido + sigungu ; 1h (or sido-only regions) -> sido whole province
export function geoPredicate(region, district, distance, sidoOnly) {
  const sidos = SIDO_MAP[region] || [];
  if (sidos.length === 0) return { sql: "1 = 1", params: [] }; // unknown region -> nationwide
  const inList = sidos.map(() => "?").join(",");
  const useSigungu = !sidoOnly && district && distance !== "1h" && !SIDO_ONLY_REGIONS.has(region);
  if (useSigungu) {
    return { sql: `sido IN (${inList}) AND sigungu = ?`, params: [...sidos, district] };
  }
  return { sql: `sido IN (${inList})`, params: [...sidos] };
}
