import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createLocalDatabase } from "./local";

await test("refuses data directories from an older PostgreSQL major", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctrl-y-pglite-"));
  try {
    writeFileSync(join(dir, "PG_VERSION"), "17\n");
    assert.throws(() => createLocalDatabase(dir), /PostgreSQL 17 のローカルDB/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("opens in-memory databases without a version check", async () => {
  const { client } = createLocalDatabase("memory://");
  try {
    assert.deepEqual((await client.query("select 1 as one")).rows, [{ one: 1 }]);
  } finally {
    await client.close();
  }
});
