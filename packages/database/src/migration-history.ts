import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import postgres from "postgres";

export interface JournalEntry {
  tag: string;
  when: number;
}

export interface Migration extends JournalEntry {
  sql: string;
  hash: string;
}

export interface MigrationHistoryRow {
  hash: string;
  created_at: number;
}

export function isJournal(value: unknown): value is { entries: JournalEntry[] } {
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
        typeof entry.when === "number" &&
        Number.isSafeInteger(entry.when),
    )
  );
}

export async function readMigrations(
  directory = new URL("../migrations/", import.meta.url),
): Promise<Migration[]> {
  const journal: unknown = JSON.parse(
    await readFile(new URL("meta/_journal.json", directory), "utf8"),
  );
  if (!isJournal(journal)) throw new Error("Invalid migration journal");
  return Promise.all(
    journal.entries.map(async (entry) => {
      const sql = await readFile(new URL(`${entry.tag}.sql`, directory), "utf8");
      // drizzle-orm 0.45.2 migrator.js hashes the full UTF-8 SQL, including comments.
      return { ...entry, sql, hash: createHash("sha256").update(sql).digest("hex") };
    }),
  );
}

export async function readProductionHistory(url: string): Promise<MigrationHistoryRow[]> {
  const sql = postgres(url, { max: 1, connect_timeout: 15, onnotice: () => {} });
  try {
    const [table] = await sql<{ name: string | null }[]>`
      select to_regclass('drizzle.__drizzle_migrations')::text as name
    `;
    // Missing history is NOT proof that the database itself is empty.
    if (!table?.name) return [];
    const rows = await sql<{ hash: string; created_at: string | number | null }[]>`
      select hash, created_at from drizzle.__drizzle_migrations order by created_at asc
    `;
    return rows.map(({ hash, created_at }) => ({
      hash,
      created_at: created_at === null ? Number.NaN : Number(created_at),
    }));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export function validateMigrationHistory(
  migrations: Migration[],
  history: MigrationHistoryRow[],
): string[] {
  const issues: string[] = [];
  const tags = new Set<string>();
  const times = new Set<number>();
  for (const [index, migration] of migrations.entries()) {
    if (tags.has(migration.tag)) issues.push(`Duplicate journal tag: ${migration.tag}`);
    if (times.has(migration.when)) issues.push(`Duplicate journal when: ${migration.when}`);
    if (!Number.isSafeInteger(migration.when)) {
      issues.push(`Invalid journal when: ${migration.tag}`);
    }
    const previous = migrations[index - 1];
    if (previous && migration.when <= previous.when) {
      issues.push(`Journal when must strictly increase: ${previous.tag} -> ${migration.tag}`);
    }
    tags.add(migration.tag);
    times.add(migration.when);
  }
  // ES2022 target: sort a copy to leave caller-owned history unchanged.
  // oxlint-disable-next-line unicorn/no-array-sort
  const ordered = [...history].sort((a, b) => a.created_at - b.created_at);
  for (const [index, row] of ordered.entries()) {
    if (!Number.isSafeInteger(row.created_at)) {
      issues.push(`Invalid production created_at at history row ${index + 1}`);
    }
    const expected = migrations[index];
    if (!expected || row.hash !== expected.hash || row.created_at !== expected.when) {
      issues.push(
        `Production history row ${index + 1} is not the journal prefix: expected ${expected ? `${expected.tag} (when=${expected.when})` : "no further migration"}; hash or timestamp mismatch`,
      );
    }
    if (!migrations.some((m) => m.hash === row.hash && m.when === row.created_at)) {
      const sameTime = migrations.find((m) => m.when === row.created_at);
      issues.push(
        sameTime
          ? `Applied SQL hash mismatch: ${sameTime.tag}.sql (when=${sameTime.when})`
          : `Production history row ${index + 1} has no matching local migration`,
      );
    }
  }
  if (history.length) {
    const latest = Math.max(...history.map((row) => row.created_at));
    for (const migration of migrations) {
      const recorded = history.some(
        (row) => row.hash === migration.hash && row.created_at === migration.when,
      );
      if (!recorded && migration.when <= latest) {
        issues.push(
          `Unrecorded migration would be silently skipped: ${migration.tag}.sql (when=${migration.when} <= latest created_at=${latest})`,
        );
      }
    }
  }
  return issues;
}

export function pendingMigrations(
  migrations: Migration[],
  history: MigrationHistoryRow[],
): Migration[] {
  // pg-core/dialect.js stores folderMillis (= journal.when) as created_at,
  // and selects by time alone, not by whether the SQL hash is recorded.
  if (!history.length) return [...migrations];
  const latest = Math.max(...history.map((row) => row.created_at));
  return migrations.filter(({ when }) => when > latest);
}
