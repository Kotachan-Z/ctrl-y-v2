import assert from "node:assert/strict";

import { compare } from "bcryptjs";
import { eq } from "drizzle-orm";

import { createLocalDatabase } from "./local";
import { parents, children, tasks } from "./schema";
const { client, db } = createLocalDatabase();
try {
  const [row] = await db
    .select()
    .from(parents)
    .innerJoin(children, eq(children.parentId, parents.id))
    .innerJoin(tasks, eq(tasks.childId, children.id))
    .where(eq(parents.id, "00000000-0000-4000-8000-000000000001"));
  assert.ok(row);
  assert.equal(row.parents.email, "parent@example.test");
  assert.ok(await compare("local-password", row.parents.passwordHash));
  assert.ok(await compare("ひみつのことば", row.parents.keyword));
  assert.equal(row.children.name, "サンプルの子供");
  assert.equal(row.tasks.name, "お片付け");
  assert.equal(row.tasks.reward, 100);
  assert.equal(row.tasks.status, "TODO");
  assert.ok(row.tasks.createdAt instanceof Date);
  console.log("PGLite migration / parent + child + task seed / Drizzle query: OK");
} finally {
  await client.close();
}
