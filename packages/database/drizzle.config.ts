import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "drizzle-kit";
const databasePath =
  process.env.PGLITE_PATH ?? fileURLToPath(new URL("../../.pglite/database", import.meta.url));
mkdirSync(dirname(databasePath), { recursive: true });
export default defineConfig({
  casing: "snake_case",
  dialect: "postgresql",
  driver: "pglite",
  dbCredentials: { url: databasePath },
  migrations: { prefix: "timestamp" },
  out: "./migrations",
  schema: "./src/schema.ts",
});
