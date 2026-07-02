import { describe, it, expect } from "vitest";
import { groupPredicate, costPredicate, timePredicate, geoDistrict } from "../src/predicates.js";

describe("groupPredicate", () => {
  it("maps each 군 to its DB filter (혼자+사회강도 기준)", () => {
    expect(groupPredicate("cli")).toBe("solo_ok = 1 AND social_intensity_score <= 1");  // 은둔
    expect(groupPredicate("isol")).toBe("solo_ok = 1 AND social_intensity_score <= 2"); // 고립
    expect(groupPredicate("norm")).toBe("1 = 1");                                       // 일반
  });
  it("falls back to no-op for unknown group", () => {
    expect(groupPredicate("???")).toBe("1 = 1");
  });
});

describe("costPredicate", () => {
  it("free requires an explicit is_free flag", () => {
    expect(costPredicate("free")).toBe("is_free = 1");
  });
  it("cheap/mid keep unknown-price rows eligible", () => {
    expect(costPredicate("cheap")).toBe("(price_known = 0 OR price < 10000)");
    expect(costPredicate("mid")).toBe("(price_known = 0 OR price < 30000)");
  });
  it("high (and unknown) is a no-op", () => {
    expect(costPredicate("high")).toBe("1 = 1");
    expect(costPredicate("???")).toBe("1 = 1");
  });
});

describe("timePredicate", () => {
  it("is always inert (no time data in the new file)", () => {
    expect(timePredicate("day")).toBe("1 = 1");
    expect(timePredicate("night")).toBe("1 = 1");
    expect(timePredicate(undefined)).toBe("1 = 1");
  });
});

describe("geoDistrict", () => {
  it("uses sido+sigungu when useSigungu=true with a district", () => {
    const { sql, params } = geoDistrict("서울", "강남구", true);
    expect(sql).toBe("sido IN (?) AND sigungu = ?");
    expect(params).toEqual(["서울특별시", "강남구"]);
  });
  it("uses whole-province (sido only) when useSigungu=false", () => {
    const { sql, params } = geoDistrict("서울", "강남구", false);
    expect(sql).toBe("sido IN (?)");
    expect(params).toEqual(["서울특별시"]);
  });
  it("expands multi-string sido maps (강원 -> 2 variants)", () => {
    const { sql, params } = geoDistrict("강원", "", true);
    expect(sql).toBe("sido IN (?,?)");
    expect(params).toEqual(["강원특별자치도", "강원도"]);
  });
  it("forces sido-level for 세종 even with a district", () => {
    const { sql, params } = geoDistrict("세종", "조치원읍", true);
    expect(sql).toBe("sido IN (?,?,?)");
    expect(params).toEqual(["세종특별자치시", "세종특별시", "세종"]);
  });
  it("falls back to nationwide for an unknown region", () => {
    expect(geoDistrict("Atlantis", "x", true)).toEqual({ sql: "1 = 1", params: [] });
  });
});
