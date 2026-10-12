import {
  pendingMigrations,
  readMigrations,
  readProductionHistory,
  validateMigrationHistory,
} from "./migration-history";
import { findDestructiveStatements, hasDestructiveReview } from "./migration-policy";

async function preflightProduction() {
  const url = process.env.PRODUCTION_DATABASE_URL;
  if (!url) throw new Error("Missing production database configuration");
  const migrations = await readMigrations();
  const history = await readProductionHistory(url);
  const issues = validateMigrationHistory(migrations, history);
  // History inconsistencies cannot be overridden by a destructive-change marker.
  if (issues.length) {
    console.error(
      "::error::Production migration preflight failed: inconsistent migration history.",
    );
    for (const issue of issues) console.error(issue);
    process.exitCode = 1;
    return;
  }
  const pending = pendingMigrations(migrations, history);
  for (const migration of pending) {
    const matches = findDestructiveStatements(migration.sql);
    if (matches.length && !hasDestructiveReview(migration.sql)) {
      console.error(`${migration.tag}.sql: ${matches.join(", ")} (missing leading review marker)`);
      process.exitCode = 1;
    }
  }
  if (process.exitCode) {
    console.error(
      "::error::Production migration preflight failed: destructive SQL requires human review.",
    );
  } else {
    console.log(`Production migration preflight: OK (${pending.length} pending migrations)`);
  }
}

try {
  await preflightProduction();
} catch {
  // Driver errors can contain connection details. Never print the error or URL.
  console.error(
    "::error::Production migration preflight failed. Check PRODUCTION_DATABASE_URL, database connectivity, migration-history read permissions, and local migration files.",
  );
  process.exitCode = 1;
}
