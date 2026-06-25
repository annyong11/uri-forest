import { describe, it, expect } from "vitest";
import { archetypeOf, composeComment, pickComment } from "../src/comments.js";

describe("archetypeOf", () => {
  it("parks and outdoor are filtered first, then category regexes", () => {
    expect(archetypeOf({ is_outdoor_park: 1 })).toBe("park");
    expect(archetypeOf({ indoor_outdoor: "야외", category_key: "관광지" })).toBe("outdoor");
    expect(archetypeOf({ category_key: "전시관" })).toBe("art");
    expect(archetypeOf({ category_key: "향토문화유적" })).toBe("museum");
    expect(archetypeOf({ category_key: "공연/행사" })).toBe("performance");
    expect(archetypeOf({ category_key: "도서관" })).toBe("reading");
    expect(archetypeOf({ category_key: "실내문화공간(오락등)" })).toBe("active");
    expect(archetypeOf({ category_key: "농어촌체험마을" })).toBe("community");
    expect(archetypeOf({ category_key: "뭔가알수없음" })).toBe("generic");
  });
});

describe("composeComment", () => {
  const row = { row_id: 42, category_key: "박물관", indoor_outdoor: "실내" };
  it("is deterministic for a given (row, group, nudge)", () => {
    expect(composeComment(row, "cli")).toBe(composeComment(row, "cli"));
  });
  it("varies with nudge (used for in-set uniqueness)", () => {
    const a = composeComment(row, "cli", 0);
    const b = composeComment(row, "cli", 1);
    expect(a).not.toBe(b);
  });
  it("group tone changes the trailing sentence", () => {
    expect(composeComment(row, "cli")).not.toBe(composeComment(row, "norm"));
  });
  it("falls back to a string hash seed when row_id is not an integer", () => {
    const noId = { facility_name: "이름만있는곳", category_key: "박물관", indoor_outdoor: "실내" };
    expect(typeof composeComment(noId, "norm")).toBe("string");
    expect(composeComment(noId, "norm").length).toBeGreaterThan(0);
  });
  it("pickComment delegates to composeComment", () => {
    expect(pickComment(row, "isol")).toBe(composeComment(row, "isol"));
  });
});
