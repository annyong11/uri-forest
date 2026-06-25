import { describe, it, expect } from "vitest";
import { groupPredicate, costPredicate, timePredicate, geoPredicate } from "../src/predicates.js";

describe("groupPredicate", () => {
  it("maps each 군 to its DB filter (정적 => axis_ap='P')", () => {
    expect(groupPredicate("cli")).toBe("solo_ok = 1 AND axis_ap = 'P'");
    expect(groupPredicate("burn")).toBe("axis_ap = 'P'");
    expect(groupPredicate("isol")).toBe("solo_ok = 1");
    expect(groupPredicate("mix")).toBe("solo_ok = 1 AND axis_ap = 'P'");
    expect(groupPredicate("norm")).toBe("1 = 1");
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

describe("geoPredicate", () => {
  it("uses sido+sigungu for short distances with a district", () => {
    const { sql, params } = geoPredicate("서울", "강남구", "walk", false);
    expect(sql).toBe("sido IN (?) AND sigungu = ?");
    expect(params).toEqual(["서울특별시", "강남구"]);
  });
  it("uses whole-province (sido only) for 1h", () => {
    const { sql, params } = geoPredicate("서울", "강남구", "1h", false);
    expect(sql).toBe("sido IN (?)");
    expect(params).toEqual(["서울특별시"]);
  });
  it("expands multi-string sido maps (강원 -> 2 variants)", () => {
    const { sql, params } = geoPredicate("강원", "", "1h", false);
    expect(sql).toBe("sido IN (?,?)");
    expect(params).toEqual(["강원특별자치도", "강원도"]);
  });
  it("forces sido-level for 세종 even with a district", () => {
    const { sql, params } = geoPredicate("세종", "조치원읍", "walk", false);
    expect(sql).toBe("sido IN (?,?,?)");
    expect(params).toEqual(["세종특별자치시", "세종특별시", "세종"]);
  });
  it("falls back to nationwide for an unknown region", () => {
    expect(geoPredicate("Atlantis", "x", "walk", false)).toEqual({ sql: "1 = 1", params: [] });
  });
});
