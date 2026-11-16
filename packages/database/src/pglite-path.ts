import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// PGlite 0.5 embeds PostgreSQL 18 and cannot open data directories from older releases.
const POSTGRES_MAJOR = "18";

export const defaultDatabasePath = fileURLToPath(
  new URL("../../../.pglite/database", import.meta.url),
);

// Fail with recovery steps instead of PGlite's opaque initialization error.
export function assertCompatibleDataDir(path: string) {
  // PGlite opens `file://` paths and plain paths from disk; other schemes are not directories.
  const directory = path.startsWith("file://")
    ? path.slice("file://".length)
    : path.includes("://")
      ? undefined
      : path;
  if (!directory) return;
  const versionFile = join(directory, "PG_VERSION");
  if (!existsSync(versionFile)) return;
  const major = readFileSync(versionFile, "utf8").trim();
  if (major === POSTGRES_MAJOR) return;
  const recovery =
    directory === defaultDatabasePath
      ? "`mise run dev` で作り直してください"
      : `このディレクトリ（PGLITE_PATH）を削除してから migration と seed をやり直してください`;
  throw new Error(
    `${directory} は PostgreSQL ${major} のローカルDBで、現在の PGlite（PostgreSQL ${POSTGRES_MAJOR}）では開けません。` +
      `${recovery}。データを残す場合は旧版で dump してから移行します（https://pglite.dev/docs/upgrade）。`,
  );
}
