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

// #2: 프로그램명 정리. 소스가 "체험A+체험B+체험C…"로 길게 나열되거나
// "[기관명] 분기/구분 [실제 제목]" 대괄호 형식이라 카드 제목이 지저분 → 한 줄로 정돈.
export function cleanProgramName(s) {
  if (!s) return "";
  s = String(s).trim();
  // 끝에 "[실제 제목]"이 붙는 도서관/기관 형식이면 그 제목을 우선 사용.
  const tail = s.match(/\[([^[\]]{2,})\]\s*$/);
  if (tail) return tail[1].trim();
  // 선행 "[기관명]" 접두 제거.
  s = s.replace(/^\s*\[[^[\]]+\]\s*/, "").trim();
  // "+" 또는 "/" 로 3개 이상 길게 붙은 나열 → "첫 항목 외 N개".
  // 단, 괄호 안의 +,/ 는 무시하고 최상위 레벨에서만 분리(괄호 깨짐·개수 부풀림 방지).
  const parts = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if ((ch === "+" || ch === "/") && depth === 0) { parts.push(cur); cur = ""; }
    else cur += ch;
  }
  parts.push(cur);
  const items = parts.map((x) => x.trim()).filter(Boolean);
  if (items.length >= 3) return `${items[0]} 외 ${items.length - 1}개`;
  return s;
}

export function formatRow(r, group) {
  // UI chips: synthesized from the new taxonomy (no user_type_tag column anymore).
  // dedup keeps the chip row tidy when large_category == mid_category.
  const tags = [...new Set(
    [r.large_category, r.mid_category, r.social_mode].filter(Boolean)
  )];
  const name = r.is_program ? (cleanProgramName(r.program_name) || r.facility_name) : r.facility_name;
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
