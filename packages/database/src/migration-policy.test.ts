import assert from "node:assert/strict";
import { test } from "node:test";

import { readMigrations } from "./migration-history";
import { findDestructiveStatements, hasDestructiveReview } from "./migration-policy";

for (const sql of [
  "DROP TABLE t;",
  "ALTER TABLE t DROP COLUMN c;",
  "drop table t;",
  "TRUNCATE t;",
  "ALTER TABLE t ALTER COLUMN c TYPE text;",
  "DROP INDEX i;",
  "ALTER TABLE t DROP CONSTRAINT c;",
  "DROP TYPE t;",
  'ALTER TABLE "t" RENAME COLUMN "a" TO "b";',
  'ALTER TABLE "t" RENAME TO "u";',
  'ALTER TABLE "t" ALTER COLUMN "c" SET NOT NULL;',
  'alter table "public"."t" rename column "a" to "b";',
  "DROP SCHEMA public CASCADE;",
  "DROP VIEW v;",
  "DROP MATERIALIZED VIEW v;",
  "DROP SEQUENCE s;",
  "DELETE FROM t;",
  "DROP/* separator */TABLE t;",
  "DROP-- separator\nTABLE t;",
]) {
  await test(`detects ${sql}`, () => assert.ok(findDestructiveStatements(sql).length));
}
for (const sql of [
  "ALTER TABLE t ADD COLUMN c text;",
  'ALTER TABLE "t" ADD COLUMN "c" text NOT NULL;',
  'ALTER TABLE "t" ALTER COLUMN "a" SET DEFAULT 1, ADD COLUMN "c" text NOT NULL;',
  'ALTER TABLE "t" ALTER COLUMN "a" SET DEFAULT 1; ALTER TABLE "t" ADD COLUMN "c" text NOT NULL;',
  'ALTER TABLE "t" ADD COLUMN "c" text NOT NULL DEFAULT \'value\';',
  'ALTER TABLE "t" ALTER COLUMN "c" DROP NOT NULL;',
  "-- DELETE FROM t;\n/* ALTER TABLE t RENAME TO u; */ SELECT 1;",
  "CREATE TABLE t (id int);",
  "CREATE INDEX i ON t (id);",
  "ALTER TABLE t ADD CONSTRAINT c UNIQUE (id);",
  "-- DROP TABLE t;\nSELECT 1; /* TRUNCATE t; */",
  "/* multi\nline DROP INDEX i; */ SELECT 1;",
]) {
  await test(`allows ${sql}`, () => assert.deepEqual(findDestructiveStatements(sql), []));
}
for (const [sql, expected] of [
  ["-- destructive-change: reviewed\nDROP TABLE t;", true],
  ["\n-- explanation\n\n  -- destructive-change: reviewed\r\nDROP TABLE t;", true],
  ["DROP TABLE t;\n-- destructive-change: reviewed", false],
  ["DROP TABLE t;", false],
  ["/* -- destructive-change: reviewed */\nDROP TABLE t;", false],
  ["/* heading */\n-- destructive-change: reviewed\nDROP TABLE t;", false],
  ["-- destructive-change: reviewed extra\nDROP TABLE t;", false],
] as const) {
  await test(`marker ${JSON.stringify(sql)}`, () =>
    assert.equal(hasDestructiveReview(sql), expected));
}

await test("migrations are non-destructive or explicitly reviewed", async () => {
  const migrations = await readMigrations();
  for (const migration of migrations) {
    assert.ok(
      findDestructiveStatements(migration.sql).length === 0 || hasDestructiveReview(migration.sql),
      migration.tag,
    );
  }
});
