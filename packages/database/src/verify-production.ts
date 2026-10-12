import { readMigrations, readProductionHistory } from "./migration-history";

async function verifyProduction() {
  const url = process.env.PRODUCTION_DATABASE_URL;
  if (!url) throw new Error("Missing production database configuration");
  const expected = await readMigrations();
  const rows = await readProductionHistory(url);
  const applied = new Set(rows.map(({ hash }) => hash));
  const missing = expected.filter(({ hash }) => !applied.has(hash));
  if (missing.length) {
    for (const { tag } of missing) {
      console.error(`Missing production migration (SQL hash not recorded): ${tag}.sql`);
    }
    console.error(
      "::error::Production migration verification failed: missing migration SQL hashes.",
    );
    process.exitCode = 1;
    return;
  }
  console.log(`Production migration verification: OK (${expected.length} SQL hashes recorded)`);
}

try {
  await verifyProduction();
} catch {
  // Driver errors can contain connection details. Never print the error or URL.
  console.error(
    "::error::Production migration verification failed. Check PRODUCTION_DATABASE_URL, database connectivity, migration-history read permissions, and local migration files.",
  );
  process.exitCode = 1;
}
