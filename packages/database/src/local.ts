import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
export const client = new PGlite(
  fileURLToPath(new URL("../../../.pglite/database", import.meta.url)),
);
export const db = drizzle(client, { casing: "snake_case" });
