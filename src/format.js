// src/format.js
// Shapes a raw DB row into the JSON contract the frontend (recoCardHTML) consumes.

import { composeComment, pickComment } from "./comments.js";

export function priceLabel(price) {
  if (price == null) return "정보 없음";
  if (price === 0) return "무료";
  return `${Number(price).toLocaleString("ko-KR")}원`;
}

export function pickEmoji(r) {
  if (r.is_program) return "🎟️";
  if (r.indoor_outdoor === "야외") return r.is_outdoor_park ? "🌳" : "🏞️";
  const t = r.category_key || "";
  if (t.includes("박물관") || t.includes("전시")) return "🖼️";
  if (t.includes("미술")) return "🎨";
  if (t.includes("공연") || t.includes("연극") || t.includes("클래식")) return "🎭";
  if (t.includes("영화")) return "🎬";
  if (t.includes("도서") || t.includes("교양")) return "📚";
  if (t.includes("관계")) return "🤝";
  return "🏛️";
}

export function formatRow(r, group) {
  // UI chips: synthesized from the new taxonomy (no user_type_tag column anymore).
  // dedup keeps the chip row tidy when large_category == mid_category.
  const tags = [...new Set(
    [r.large_category, r.mid_category, r.social_mode].filter(Boolean)
  )];
  const name = r.is_program ? (r.program_name || r.facility_name) : r.facility_name;
  const where = [r.sido, r.sigungu].filter(Boolean).join(" ");
  return {
    row_id: r.row_id,            // surrogate key — used to pin/share exact places
    content_id: r.content_id,
    is_program: !!r.is_program,
    name,
    facility_name: r.facility_name,
    where,
    address: r.address,
    lat: r.latitude,
    lng: r.longitude,
    price: r.price,
    price_label: priceLabel(r.price),
    tags,
    category_key: r.category_key,
    indoor_outdoor: r.indoor_outdoor,
    social_mode: r.social_mode,
    content_mode: r.content_mode,
    description: r.description,
    // "방문 전 운영시간 확인" 안내. is_time_fixed=0 이 신규 데이터의 92.5% 기본값이라
    // 무조건 켜면 노이즈가 됨 → 운영시간이 실제로 중요한 실내 시설/프로그램에만 표시.
    time_warning: r.is_time_fixed === 0 && (r.indoor_outdoor !== "야외" || !!r.is_program),
    operating_remark: r.operating_hours_remark,
    comment: pickComment(r, group),
    homepage_url: r.homepage_url,
    // 네이버 지도 검색 링크 — 이름+시군구로 항상 생성 (homepage_url은 18%만 채워져 있어 길찾기 보강)
    map_url: "https://map.naver.com/p/search/" +
      encodeURIComponent(`${r.facility_name || name} ${r.sigungu || ""}`.trim()),
    emoji: pickEmoji(r),
    info: `${where} · ${priceLabel(r.price)}`,
    score: r.score,
  };
}

// Map rows to output, ensuring no two cards share the same generated comment
// (nudge the variant until unique within this result set).
export function formatResults(rows, group) {
  const seen = new Set();
  return rows.map((r) => {
    const item = formatRow(r, group);
    let c = item.comment, n = 0;
    while (c && seen.has(c) && n < 8) c = composeComment(r, group, ++n);
    seen.add(c);
    item.comment = c;
    return item;
  });
}
