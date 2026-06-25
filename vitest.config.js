// vitest.config.js — runs tests inside a real workerd via @cloudflare/vitest-pool-workers.
// Pure-function tests need nothing special; the API integration tests get an ephemeral
// local D1 bound as env.DB (seeded per-suite). We define bindings via miniflare directly
// rather than reading wrangler.jsonc, so the static-assets / custom-domain config and the
// remote database_id are irrelevant to the test run.
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        main: "./src/index.js",
        singleWorker: true,
        miniflare: {
          // test-only date; kept <= the workerd build the pool bundles to avoid a
          // "compatibility date in the future" error. Prod date lives in wrangler.jsonc.
          compatibilityDate: "2025-09-01",
          d1Databases: ["DB"],
        },
      },
    },
  },
});
