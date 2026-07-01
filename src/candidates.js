// src/candidates.js
// The D1 candidate query: personality score computed in SQL + filters.

import { W, CLUSTER_POOL, POOL_BONUS, NOT_IN_POOL_BONUS, ISOLATION_PARAMS, SOCIAL_FIT_WEIGHT } from "./constants.js";
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
export async function fetchCandidates(env, { animal, spaceDb, geo, group, cost, time, poolLimit }) {
  const pool = CLUSTER_POOL[animal] || [];
  const p = ISOLATION_PARAMS[group] || ISOLATION_PARAMS.norm;
  const absFitRatio = Math.abs(p.socialFitRatio);
  const fitSign = p.socialFitRatio < 0 ? -1 : 1;

  // mid_category가 클러스터 풀에 있으면 POOL_BONUS, 없으면 NOT_IN_POOL_BONUS
  const poolCaseSQL = pool.length > 0
    ? `CASE WHEN mid_category IN (${pool.map(() => "?").join(",")}) THEN ${POOL_BONUS} ELSE ${NOT_IN_POOL_BONUS} END`
    : `${NOT_IN_POOL_BONUS}`;

  const sql =
    `SELECT ${SELECT_COLS},
       ( ${poolCaseSQL} * ${W.pool}
         + (indoor_outdoor = ?) * ${W.space}
         + (base_score / 5.0) * ${W.pop}
         + (is_program = 1) * ?
         + CASE
             WHEN social_intensity_score IS NULL THEN 0
             WHEN ? < 0 THEN (1.0 - social_intensity_score) * ? * ?
             ELSE social_intensity_score * ? * ?
           END
       ) AS score
     FROM solutions
     WHERE is_active = 1
       AND ${geo.sql}
       AND ${groupPredicate(group)}
       AND ${costPredicate(cost)}
       AND ${timePredicate(time)}
     ORDER BY score DESC, RANDOM()
     LIMIT ?`;

  const params = [
    ...pool,                                           // CASE WHEN mid_category IN (...)
    spaceDb,                                           // indoor_outdoor 매칭
    p.programBonus,                                    // is_program 가점/감점
    fitSign, SOCIAL_FIT_WEIGHT, absFitRatio,           // social_fit (ratio < 0 분기)
    SOCIAL_FIT_WEIGHT, absFitRatio,                    // social_fit (ratio >= 0 분기)
    ...geo.params,
    poolLimit,
  ];

  const { results } = await env.DB.prepare(sql).bind(...params).all();
  let rows = results || [];
  if (geo.within) {
    rows = rows
      .filter(r =>
        r.mid_category === "온라인콘텐츠" || r.mid_category === "DIY키트"
        || geo.within(r)
      )
      .map(r => {
        // 좌표 없는 시설은 9999km 페널티 (온라인콘텐츠 제외)
        const isOnline = r.mid_category === "온라인콘텐츠" || r.mid_category === "DIY키트";
        if (!isOnline && (r.latitude == null || r.longitude == null)) {
          return { ...r, score: (r.score || 0) - 9999 * 0.5 };
        }
        return r;
      })
      .sort((a, b) => (b.score || 0) - (a.score || 0));
  }
  return rows;
}
