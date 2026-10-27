import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: process.env.BASE_URL || "http://127.0.0.1:4321",
    browserName: "chromium",
  },
  // Run `npm run build` first. The server keeps its KV data in memory, so
  // each start seeds the fixtures again.
  webServer: {
    command:
      'npx quant serve dist --memory --seed-key 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef --user-name "Alex Morgan" --port 4321',
    url: "http://127.0.0.1:4321",
    reuseExistingServer: !process.env.CI,
  },
});
