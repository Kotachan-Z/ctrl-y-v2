import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import postgres from "postgres";

function isJournal(value: unknown): value is { entries: { tag: string; when: number }[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    "entries" in value &&
    Array.isArray(value.entries) &&
    value.entries.every(
      (entry: unknown) =>
        typeof entry === "object" &&
        entry !== null &&
        "tag" in entry &&
        typeof entry.tag === "string" &&
        "when" in entry &&
        typeof entry.when === "number",
    )
  );
}

async function verifyProduction() {
  const url = process.env.PRODUCTION_DATABASE_URL;
  if (!url) {
    throw new Error("Missing production database configuration");
  }
  const migrations = new URL("../migrations/", import.meta.url);
  const journal: unknown = JSON.parse(
    await readFile(new URL("meta/_journal.json", migrations), "utf8"),
  );
  if (!isJournal(journal)) {
    throw new Error("Invalid migration journal");
  }
  const expected = await Promise.all(
    journal.entries.map(async ({ tag }) => {
      const sql = await readFile(new URL(`${tag}.sql`, migrations), "utf8");
      // drizzle-orm 0.45.2 migrator.js hashes the entire UTF-8 SQL file,
      // including comments, whitespace, and statement-breakpoint markers.
      return { tag, hash: createHash("sha256").update(sql).digest("hex") };
    }),
  );
  const sql = postgres(url, { max: 1, connect_timeout: 15, onnotice: () => {} });
  try {
    const [table] = await sql<{ name: string | null }[]>`
      select to_regclass('drizzle.__drizzle_migrations')::text as name
    `;
    const rows = table?.name
      ? await sql<{ hash: string }[]>`select hash from drizzle.__drizzle_migrations`
      : [];
    const applied = new Set(rows.map(({ hash }) => hash));
    const missing = expected.filter(({ hash }) => !applied.has(hash));
    if (missing.length) {
      for (const { tag } of missing) {
        console.error(`Missing production migration (SQL hash not recorded): ${tag}.sql`);
      }
      process.exitCode = 1;
      return;
    }
    console.log(`Production migration verification: OK (${expected.length} SQL hashes recorded)`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

try {
  await verifyProduction();
} catch {
  // Driver errors can contain connection details. Never print the error or URL.
  console.error(
    "Production migration verification failed. Check PRODUCTION_DATABASE_URL, database connectivity, migration-history read permissions, and local migration files.",
  );
  process.exitCode = 1;
}
