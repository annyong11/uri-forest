import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, it, expect } from "vitest";

// ── Minimal in-memory fixture for the recommendation engine ──────────────────
// Mirrors the columns src/candidates.js (SELECT_COLS) + the scoring/filter logic read.
const COLS = [
  "row_id", "content_id", "is_program", "facility_name", "program_name",
  "source", "large_category", "mid_category", "sido", "sigungu", "address",
  "latitude", "longitude", "price", "is_free", "price_known", "is_time_fixed",
  "operating_hours_remark", "indoor_outdoor", "social_mode", "social_intensity_score",
  "content_mode", "description", "homepage_url", "category_key", "is_outdoor_park",
  "base_score", "axis_ap", "axis_ts", "solo_ok", "is_active",
];

const DEFAULTS = {
  program_name: null, source: "src", large_category: "문화시설", mid_category: "박물관",
  sido: "서울특별시", sigungu: "중구", address: "주소", latitude: 37.5, longitude: 127.0,
  price: null, is_free: 0, price_known: 0, is_time_fixed: 0, operating_hours_remark: null,
  indoor_outdoor: "실내", social_mode: "1인가능", social_intensity_score: 1,
  content_mode: "사고형", description: null, homepage_url: null, category_key: "박물관",
  is_outdoor_park: 0, base_score: 0, axis_ap: "P", axis_ts: "S", solo_ok: 1, is_active: 1,
};

const park = (id, name, ov = {}) => ({
  row_id: id, content_id: `P_${id}`, is_program: 0, facility_name: name,
  large_category: "자연", mid_category: "도시공원", indoor_outdoor: "야외",
  category_key: "outdoor_park", is_outdoor_park: 1, content_mode: "감각형",
  axis_ap: "A", axis_ts: "S", solo_ok: 1, ...ov,
});
const row = (id, name, ov = {}) => ({ row_id: id, content_id: `P_${id}`, is_program: 0, facility_name: name, ...ov });

const FIXTURE = [
  park(1, "서울숲"),
  park(2, "월드컵공원"),
  park(3, "보라매공원"),
  row(4, "국립중앙박물관", { category_key: "박물관", mid_category: "박물관" }),
  row(5, "서울역사박물관", { category_key: "박물관", mid_category: "박물관" }),
  row(6, "남산도서관", { category_key: "도서관", mid_category: "도서관" }),
  row(7, "서울시립미술관", { category_key: "미술관", mid_category: "미술관" }),
  { row_id: 8, content_id: "P_8", is_program: 1, facility_name: "체험공방", program_name: "도자기 원데이",
    large_category: "체험", mid_category: "농어촌체험마을", category_key: "농어촌체험마을",
    social_mode: "그룹", axis_ts: "T", solo_ok: 0, axis_ap: "A", content_mode: "감각형", indoor_outdoor: "야외" },
  row(9, "폐관박물관", { category_key: "박물관", is_active: 0 }),          // inactive -> never returned
  park(10, "서울숲", { content_id: "P_10", category_key: "관광지", mid_category: "관광지", is_outdoor_park: 0 }), // dup name
  park(11, "해운대", { sido: "부산광역시", sigungu: "해운대구" }),         // different region
  row(12, "무료갤러리", { category_key: "전시관", mid_category: "전시관", is_free: 1, price: 0, price_known: 1 }),
];

async function seed() {
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS solutions (" + COLS.map((c) => `${c}`).join(", ") + ")"
  );
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS results (id INTEGER PRIMARY KEY AUTOINCREMENT, animal TEXT, group_key TEXT, sido TEXT, created_at TEXT)"
  );
  const ph = COLS.map(() => "?").join(",");
  const stmt = env.DB.prepare(`INSERT INTO solutions (${COLS.join(",")}) VALUES (${ph})`);
  await env.DB.batch(
    FIXTURE.map((r) => stmt.bind(...COLS.map((c) => (c in r ? r[c] : DEFAULTS[c]))))
  );
}

const post = (path, body) =>
  SELF.fetch(`https://x${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeAll(seed);

describe("POST /api/recommend", () => {
  const CONTRACT = ["name", "where", "price_label", "indoor_outdoor", "tags",
    "time_warning", "comment", "map_url", "homepage_url", "emoji", "row_id"];

  it("returns diverse 서울 results honoring the contract", async () => {
    const r = await post("/api/recommend", { group: "norm", animal: "ASF", region: "서울", limit: 5 });
    const d = await r.json();
    expect(d.ok).toBe(true);
    expect(d.count).toBe(5);
    for (const item of d.results) for (const k of CONTRACT) expect(item, `missing ${k}`).toHaveProperty(k);
  });

  it("respects the per-category cap (<=2 parks when diversity exists)", async () => {
    const d = await (await post("/api/recommend", { group: "norm", animal: "ASF", region: "서울", limit: 5 })).json();
    const parks = d.results.filter((x) => x.category_key === "outdoor_park").length;
    expect(parks).toBeLessThanOrEqual(2);
  });

  it("excludes inactive rows and other regions", async () => {
    const d = await (await post("/api/recommend", { group: "norm", animal: "ASF", region: "서울", limit: 20 })).json();
    const ids = d.results.map((x) => x.content_id);
    expect(ids).not.toContain("P_9");   // inactive
    expect(ids).not.toContain("P_11");  // 부산
  });

  it("dedups identical facility names", async () => {
    const d = await (await post("/api/recommend", { group: "norm", animal: "ASF", region: "서울", limit: 20 })).json();
    const seoulSup = d.results.filter((x) => x.facility_name === "서울숲").length;
    expect(seoulSup).toBeLessThanOrEqual(1);
  });

  it("normalizes a bogus group to norm and clamps limit", async () => {
    const d = await (await post("/api/recommend", { group: "bogus", animal: "ASF", region: "서울", limit: 1 })).json();
    expect(d.group).toBe("norm");
    expect(d.count).toBe(1);
  });

  it("rejects non-POST and invalid JSON", async () => {
    expect((await SELF.fetch("https://x/api/recommend")).status).toBe(405);
    const bad = await SELF.fetch("https://x/api/recommend", { method: "POST", body: "notjson" });
    expect(bad.status).toBe(400);
  });
});

describe("GET /api/places", () => {
  it("returns requested rows in the given order, excluding inactive", async () => {
    const d = await (await SELF.fetch("https://x/api/places?ids=6,4")).json();
    expect(d.ok).toBe(true);
    expect(d.results.map((x) => x.content_id)).toEqual(["P_6", "P_4"]);
    const withInactive = await (await SELF.fetch("https://x/api/places?ids=9,4")).json();
    expect(withInactive.results.map((x) => x.content_id)).toEqual(["P_4"]);
  });
  it("empty ids => empty result set", async () => {
    const d = await (await SELF.fetch("https://x/api/places")).json();
    expect(d).toEqual({ ok: true, results: [] });
  });
});

describe("/api/result + /api/stats", () => {
  it("records a result and aggregates it", async () => {
    expect((await (await post("/api/result", { animal: "ASF", group: "norm", region: "서울특별시" })).json()).ok).toBe(true);
    const stats = await (await SELF.fetch("https://x/api/stats")).json();
    expect(stats.ok).toBe(true);
    expect(stats.total).toBeGreaterThanOrEqual(1);
    expect(stats.byAnimal.ASF).toBeGreaterThanOrEqual(1);
  });
  it("rejects a malformed animal code", async () => {
    expect((await post("/api/result", { animal: "ZZZ", group: "norm" })).status).toBe(400);
  });
});

describe("router", () => {
  it("404s unknown /api/* paths", async () => {
    expect((await SELF.fetch("https://x/api/nope")).status).toBe(404);
  });
});
