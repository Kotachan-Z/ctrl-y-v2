import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

export function createLocalDatabase(
  path = process.env.PGLITE_PATH ??
    fileURLToPath(new URL("../../../.pglite/database", import.meta.url)),
) {
  const client = new PGlite(path);
  return { client, db: drizzle(client, { casing: "snake_case" }) };
}
