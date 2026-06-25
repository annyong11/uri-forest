// src/candidates.js
// The D1 candidate query: personality score computed in SQL + filters.

import { W } from "./constants.js";
import { groupPredicate, costPredicate, timePredicate } from "./predicates.js";

// Columns selected for every place/program row (shared by recommend + places lookup).
export const SELECT_COLS = `
  row_id, content_id, is_program, facility_name, program_name,
  source, large_category, mid_category,
  sido, sigungu, address, latitude, longitude,
  price, is_free, price_known,
  is_time_fixed, operating_hours_remark,
  indoor_outdoor, social_mode, social_intensity_score, content_mode,
  description, homepage_url,
  category_key, is_outdoor_park, base_score`;

/**
 * Fetch the top `poolLimit` candidates for one relaxation step, scored in SQL.
 * @param {{ DB: D1Database }} env
 * @param {{ ap:string, ts:string, spaceDb:string, geo:{sql:string,params:any[]},
 *           group:string, cost:string, time:string, poolLimit:number }} opts
 * @returns {Promise<any[]>}
 */
export async function fetchCandidates(env, { ap, ts, spaceDb, geo, group, cost, time, poolLimit }) {
  // Personality score computed in SQL. Scoring params (?,?,?,?) appear in SELECT,
  // so they are bound FIRST, before the geo params in WHERE.
  const sql =
    `SELECT ${SELECT_COLS},
       ( (axis_ap = ?) * ${W.ap}
         + ( (axis_ts = ?) OR (? = 'S' AND solo_ok = 1) ) * ${W.ts}
         + (indoor_outdoor = ?) * ${W.space}
         + (base_score / 5.0) * ${W.pop} ) AS score
     FROM solutions
     WHERE is_active = 1
       AND ${geo.sql}
       AND ${groupPredicate(group)}
       AND ${costPredicate(cost)}
       AND ${timePredicate(time)}
     ORDER BY score DESC, RANDOM()
     LIMIT ?`;
  const params = [ap, ts, ts, spaceDb, ...geo.params, poolLimit];
  const { results } = await env.DB.prepare(sql).bind(...params).all();
  let rows = results || [];
  // GPS 모드: 바운딩 박스로 받은 뒤 정확한 반경 원으로 코너를 깎는다(박스 ⊃ 원).
  if (geo.within) rows = rows.filter(geo.within);
  return rows;
}
