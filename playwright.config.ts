import { fileURLToPath } from "node:url";

import { defineConfig } from "@playwright/test";

const apiPort = process.env.API_PORT ?? "3000";

export default defineConfig({
  testDir: "./e2e",
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: { baseURL: "http://127.0.0.1:5173", trace: "retain-on-failure" },
  webServer: [
    {
      command: "bun run --filter @ctrl-y/web dev",
      env: { API_PORT: apiPort },
      url: "http://127.0.0.1:5173",
      reuseExistingServer: false,
    },
    {
      command: "bun run --filter @ctrl-y/database migration && bun run --filter @ctrl-y/api dev",
      env: {
        API_PORT: apiPort,
        JWT_SECRET: "e2e-only-secret-at-least-32-bytes-long",
        PGLITE_PATH: fileURLToPath(new URL("./.pglite/e2e", import.meta.url)),
      },
      url: `http://127.0.0.1:${apiPort}/api/health`,
      reuseExistingServer: false,
    },
  ],
});
