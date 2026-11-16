import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

import { assertCompatibleDataDir, defaultDatabasePath } from "./pglite-path";

export function createLocalDatabase(path = process.env.PGLITE_PATH ?? defaultDatabasePath) {
  assertCompatibleDataDir(path);
  const client = new PGlite(path);
  return { client, db: drizzle(client, { casing: "snake_case" }) };
}
