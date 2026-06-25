// src/predicates.js
// SQL WHERE-fragment builders. Every fragment comes from a whitelisted enum — no user
// free-text is ever concatenated into SQL; user strings are bound as params elsewhere.

import { SIDO_MAP, SIDO_ONLY_REGIONS, SIDO_BBOX } from "./constants.js";

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

// 두 좌표 사이 직선거리(km). GPS 반경 필터에 사용.
export function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// GPS 좌표가 "선택한 시·도"의 대략 박스 안에 있는가(margin° 여유 포함)?
// 실제 위치와 드롭다운 선택이 크게 어긋나면(서울에서 충남 선택 등) GPS를 신뢰하지 않기 위함.
// 알 수 없는 region 이면 GPS를 그대로 신뢰(true).
export function gpsInRegion(lat, lng, region, margin = 0.35) {
  const bb = SIDO_BBOX[region];
  if (!bb) return true;
  return (
    lat >= bb[0] - margin && lat <= bb[1] + margin &&
    lng >= bb[2] - margin && lng <= bb[3] + margin
  );
}

// 시·도/시·군·구 동등 비교 geo (GPS 폴백 경로). Returns { sql, params }.
//   useSigungu=true  -> sido + sigungu (선택 시군구 우선)
//   useSigungu=false -> sido 전체 (시군구로 결과가 부족할 때 도 단위로 확장)
export function geoDistrict(region, district, useSigungu) {
  const sidos = SIDO_MAP[region] || [];
  if (sidos.length === 0) return { sql: "1 = 1", params: [] }; // unknown region -> nationwide
  const inList = sidos.map(() => "?").join(",");
  if (useSigungu && district && !SIDO_ONLY_REGIONS.has(region)) {
    return { sql: `sido IN (${inList}) AND sigungu = ?`, params: [...sidos, district] };
  }
  return { sql: `sido IN (${inList})`, params: [...sidos] };
}

// GPS 반경 geo. Returns { sql, params, within }.
//   sql  : 바운딩 박스(위경도 BETWEEN) — idx_geo_active 를 타도록 SQL에서 1차 필터.
//   within(row) : 정확한 haversine 원 필터 — D1에 삼각함수가 없어 JS에서 코너를 깎는다.
export function geoRadius(lat, lng, radiusKm) {
  const latDelta = radiusKm / 111.0; // 위도 1° ≈ 111km
  const cos = Math.cos((lat * Math.PI) / 180);
  const lngDelta = radiusKm / (111.0 * Math.max(0.1, Math.abs(cos)));
  const sql = "latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?";
  const params = [lat - latDelta, lat + latDelta, lng - lngDelta, lng + lngDelta];
  const within = (r) =>
    r.latitude != null && r.longitude != null &&
    haversineKm(lat, lng, r.latitude, r.longitude) <= radiusKm;
  return { sql, params, within };
}
