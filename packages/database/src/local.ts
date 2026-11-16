import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

// PGlite 0.5 embeds PostgreSQL 18 and cannot open data directories from older releases.
const POSTGRES_MAJOR = "18";

export function createLocalDatabase(
  path = process.env.PGLITE_PATH ??
    fileURLToPath(new URL("../../../.pglite/database", import.meta.url)),
) {
  const versionFile = join(path, "PG_VERSION");
  if (!path.includes("://") && existsSync(versionFile)) {
    const major = readFileSync(versionFile, "utf8").trim();
    if (major !== POSTGRES_MAJOR)
      throw new Error(
        `${path} は PostgreSQL ${major} のローカルDBで、現在の PGlite（PostgreSQL ${POSTGRES_MAJOR}）では開けません。` +
          "`mise run dev` で作り直すか、データを残す場合は旧版で dump してから移行してください（https://pglite.dev/docs/upgrade）。",
      );
  }
  const client = new PGlite(path);
  return { client, db: drizzle(client, { casing: "snake_case" }) };
}
