import { describe, it, expect } from "vitest";
import { priceLabel, pickEmoji, formatRow, formatResults } from "../src/format.js";

describe("priceLabel", () => {
  it("null/undefined price => 정보 없음 (unknown, NOT free)", () => {
    expect(priceLabel(null)).toBe("정보 없음");
    expect(priceLabel(undefined)).toBe("정보 없음");
  });
  it("0 => 무료, positive => localized 원", () => {
    expect(priceLabel(0)).toBe("무료");
    expect(priceLabel(12000)).toBe("12,000원");
  });
});

describe("pickEmoji", () => {
  it("programs, parks, and category buckets", () => {
    expect(pickEmoji({ is_program: 1 })).toBe("🎟️");
    expect(pickEmoji({ indoor_outdoor: "야외", is_outdoor_park: 1 })).toBe("🌳");
    expect(pickEmoji({ indoor_outdoor: "야외", is_outdoor_park: 0 })).toBe("🏞️");
    expect(pickEmoji({ category_key: "박물관" })).toBe("🖼️");
    expect(pickEmoji({ category_key: "미술관" })).toBe("🎨");
    expect(pickEmoji({ category_key: "도서관" })).toBe("📚");
    expect(pickEmoji({ category_key: "기타" })).toBe("🏛️");
  });
});

describe("formatRow", () => {
  const base = {
    row_id: 7, content_id: "PLACE_7", is_program: 0, facility_name: "서울숲",
    large_category: "자연", mid_category: "도시공원", social_mode: "1인가능",
    sido: "서울특별시", sigungu: "성동구", indoor_outdoor: "야외", is_outdoor_park: 1,
    is_time_fixed: 0, latitude: 37.5, longitude: 127.0, price: null, category_key: "outdoor_park",
  };
  it("produces the frontend contract fields", () => {
    const r = formatRow(base, "norm");
    for (const k of ["name", "where", "price_label", "indoor_outdoor", "tags",
      "time_warning", "comment", "map_url", "homepage_url", "emoji", "row_id"]) {
      expect(r, `missing ${k}`).toHaveProperty(k);
    }
    expect(r.name).toBe("서울숲");
    expect(r.where).toBe("서울특별시 성동구");
    expect(Array.isArray(r.tags)).toBe(true);
  });
  it("dedups tags and uses program_name for programs", () => {
    const r = formatRow({ ...base, large_category: "자연", mid_category: "자연" }, "norm");
    expect(r.tags).toEqual(["자연", "1인가능"]); // 자연 collapsed
    const p = formatRow({ ...base, is_program: 1, program_name: "숲 체험" }, "norm");
    expect(p.name).toBe("숲 체험");
  });
  it("time_warning OFF for outdoor parks, ON for indoor venues", () => {
    expect(formatRow(base, "norm").time_warning).toBe(false); // 야외 park
    const indoor = formatRow({ ...base, indoor_outdoor: "실내", is_outdoor_park: 0, category_key: "박물관" }, "norm");
    expect(indoor.time_warning).toBe(true);
    const prog = formatRow({ ...base, is_program: 1, program_name: "야외 행사" }, "norm");
    expect(prog.time_warning).toBe(true); // program even though 야외
  });
  it("builds a naver map link from name + sigungu", () => {
    expect(formatRow(base, "norm").map_url).toContain("https://map.naver.com/p/search/");
  });
});

describe("formatResults", () => {
  it("makes generated comments unique within the set", () => {
    // two rows, same archetype+group+seed-ish => composer would collide; nudge fixes it
    const rows = [
      { row_id: 1, facility_name: "A", category_key: "박물관", indoor_outdoor: "실내", is_time_fixed: 1 },
      { row_id: 1, facility_name: "B", category_key: "박물관", indoor_outdoor: "실내", is_time_fixed: 1 },
    ];
    const out = formatResults(rows, "norm");
    expect(out[0].comment).not.toBe(out[1].comment);
  });
});
