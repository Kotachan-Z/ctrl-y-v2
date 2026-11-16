import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { defineConfig } from "drizzle-kit";

import { assertCompatibleDataDir, defaultDatabasePath } from "./src/pglite-path";
const databasePath = process.env.PGLITE_PATH ?? defaultDatabasePath;
// Only these commands open the database; generate, check, up and drop work on files alone.
if (["migrate", "push", "studio", "pull", "introspect"].some((c) => process.argv.includes(c)))
  assertCompatibleDataDir(databasePath);
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
