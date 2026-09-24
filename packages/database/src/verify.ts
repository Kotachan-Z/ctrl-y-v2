import assert from "node:assert/strict";

import { eq } from "drizzle-orm";

import { client, db } from "./local";
import { users } from "./schema";
try {
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.id, "00000000-0000-4000-8000-000000000001"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.name, "Local scaffold user");
  assert.ok(rows[0]?.createdAt instanceof Date);
  console.log("PGLite migration / seed / Drizzle query: OK");
} finally {
  await client.close();
}
