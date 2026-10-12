import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  isJournal,
  pendingMigrations,
  readMigrations,
  validateMigrationHistory,
  type Migration,
} from "./migration-history";

const migrations: Migration[] = [100, 150, 200].map((when) => ({
  tag: `migration_${when}`,
  when,
  hash: `hash_${when}`,
  sql: "SELECT 1;",
}));
const history = migrations.map(({ hash, when }) => ({ hash, created_at: when }));

await test("validates empty, partial, complete and unordered history", () => {
  for (const rows of [[], history.slice(0, 2), history, [history[2], history[1], history[0]]]) {
    assert.deepEqual(validateMigrationHistory(migrations, rows), []);
  }
});
await test("detects old unrecorded migration after when=200 was applied", () => {
  const rows = [history[0], history[2]];
  const issues = validateMigrationHistory(migrations, rows);
  assert.ok(issues.some((issue) => issue.includes("prefix")));
  assert.ok(issues.some((issue) => issue.includes("silently skipped: migration_150")));
  // Hash absence must not cause selection: drizzle silently skips when=150.
  assert.deepEqual(pendingMigrations(migrations, rows), []);
});
await test("detects changed applied SQL hash, including review comment additions", () => {
  const changed = migrations.map((m) => ({ ...m, hash: `${m.hash}_modified` }));
  assert.ok(
    validateMigrationHistory(changed, history).some((s) => s.includes("SQL hash mismatch")),
  );
});
await test("detects unknown production history", () => {
  assert.ok(
    validateMigrationHistory(migrations, [{ hash: "unknown", created_at: 300 }]).some((s) =>
      s.includes("no matching local migration"),
    ),
  );
});
await test("detects timestamp mismatch even if hash is recorded", () => {
  assert.ok(
    validateMigrationHistory(migrations, [{ hash: migrations[0].hash, created_at: 99 }]).length,
  );
});
await test("detects duplicate production rows", () => {
  assert.ok(validateMigrationHistory(migrations, [history[0], history[0]]).length);
});
await test("detects duplicate tag and when and nonincreasing journal", () => {
  const issues = validateMigrationHistory([migrations[0], migrations[0]], []);
  for (const phrase of ["Duplicate journal tag", "Duplicate journal when", "strictly increase"]) {
    assert.ok(issues.some((s) => s.includes(phrase)));
  }
  assert.ok(validateMigrationHistory([migrations[2], migrations[1], migrations[0]], []).length);
});
await test("equal timestamp is also silently skipped", () => {
  const local = [...migrations, { ...migrations[2], tag: "equal", hash: "other" }];
  assert.ok(
    validateMigrationHistory(local, history).some((s) => s.includes("silently skipped: equal")),
  );
  assert.deepEqual(pendingMigrations(local, history), []);
});
await test("pending selection uses maximum timestamp and ignores hashes", () => {
  assert.deepEqual(pendingMigrations(migrations, []), migrations);
  assert.deepEqual(pendingMigrations(migrations, [history[0]]), migrations.slice(1));
  assert.deepEqual(pendingMigrations(migrations, [history[1], history[0]]), migrations.slice(2));
  assert.deepEqual(
    pendingMigrations(migrations, [{ hash: "unknown", created_at: 150 }]),
    migrations.slice(2),
  );
});
await test("rejects invalid history timestamp", () => {
  assert.ok(
    validateMigrationHistory(migrations, [{ hash: "x", created_at: NaN }]).some((s) =>
      s.includes("Invalid production"),
    ),
  );
});
await test("journal shape validation", () => {
  assert.ok(isJournal({ entries: [{ tag: "a", when: 100 }] }));
  for (const value of [
    null,
    {},
    { entries: [null] },
    { entries: [{ tag: 1, when: 1 }] },
    { entries: [{ tag: "a", when: "100" }] },
    { entries: [{ tag: "a", when: NaN }] },
  ]) {
    assert.equal(isJournal(value), false);
  }
});
await test("SQL hashes include the full file and comments", async () => {
  for (const migration of await readMigrations()) {
    assert.equal(migration.hash, createHash("sha256").update(migration.sql).digest("hex"));
    assert.notEqual(
      migration.hash,
      createHash("sha256")
        .update(`-- destructive-change: reviewed\n${migration.sql}`)
        .digest("hex"),
    );
  }
});
