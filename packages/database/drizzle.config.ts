import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { defineConfig } from "drizzle-kit";

import { assertCompatibleDataDir, defaultDatabasePath } from "./src/pglite-path";
const databasePath = process.env.PGLITE_PATH ?? defaultDatabasePath;
// `generate` only diffs the schema against migrations and never opens the database.
if (!process.argv.includes("generate")) assertCompatibleDataDir(databasePath);
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
