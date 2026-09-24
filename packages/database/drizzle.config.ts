import { mkdirSync } from "node:fs";

import { defineConfig } from "drizzle-kit";
mkdirSync(new URL("../../.pglite", import.meta.url), { recursive: true });

export default defineConfig({
  casing: "snake_case",
  dialect: "postgresql",
  driver: "pglite",
  dbCredentials: { url: "../../.pglite/database" },
  migrations: { prefix: "timestamp" },
  out: "./migrations",
  schema: "./src/schema.ts",
});
