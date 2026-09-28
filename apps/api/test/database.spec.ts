import { fileURLToPath } from "node:url";

import { children, parents, payroll, tasks } from "@ctrl-y/database";
import { createLocalDatabase } from "@ctrl-y/database/local";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, expect, test } from "vitest";

import { createRepository } from "../src/repository.js";

const { db, client } = createLocalDatabase("memory://");
const repository = createRepository(db);
beforeAll(async () => {
  await migrate(db, {
    migrationsFolder: fileURLToPath(
      new URL("../../../packages/database/migrations", import.meta.url),
    ),
  });
}, 30_000);
afterAll(async () => {
  await client.close();
});

test("repository scopes children, rejects duplicate parents and serializes setup", async () => {
  const parent = await repository.register("db@example.test", "test-hash");
  const other = await repository.register("other@example.test", "test-hash");
  expect(parent).toMatchObject({
    cutoffDay: false,
    payDay: false,
    keyword: "",
    pushSubscription: null,
  });
  expect(await repository.register("db@example.test", "another-hash")).toBeUndefined();
  expect(await repository.addChild(parent!.id, "before-setup")).toBeUndefined();
  const results = await Promise.all([
    repository.addChild(parent!.id, "A", "keyword-a-hash"),
    repository.addChild(parent!.id, "B", "keyword-b-hash"),
  ]);
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(await repository.listChildren(parent!.id)).toHaveLength(1);
  expect(await repository.listChildren(other!.id)).toHaveLength(0);
  expect(await repository.addChild(parent!.id, "second")).toBeDefined();
  const [child] = await repository.listChildren(parent!.id);
  expect((await repository.childById(child.id))?.parent.id).toBe(parent!.id);
});

test("failed child creation rolls keyword update back", async () => {
  const parent = await repository.register("rollback@example.test", "test-hash");
  // PostgreSQL text rejects NUL. Failure occurs after the keyword update.
  await expect(repository.addChild(parent!.id, "\u0000", "keyword-hash")).rejects.toThrow();
  expect((await repository.parentById(parent!.id))?.keyword).toBe("");
  expect(await repository.listChildren(parent!.id)).toHaveLength(0);
});

test("task family ownership and payroll month uniqueness are DB constraints", async () => {
  const parent = await repository.register("constraints@example.test", "test-hash");
  const other = await repository.register("constraints-other@example.test", "test-hash");
  const child = await repository.addChild(parent!.id, "child", "keyword-hash");
  const task = {
    parentId: parent!.id,
    childId: child!.id,
    name: "片付け",
    reward: 100,
    deadline: new Date(),
  };
  const [created] = await db.insert(tasks).values(task).returning();
  expect(created.status).toBe("TODO");
  await db.insert(tasks).values({ ...task, childId: null });
  await expect(db.insert(tasks).values({ ...task, parentId: other!.id })).rejects.toThrow();
  await expect(db.insert(tasks).values({ ...task, reward: -1 })).rejects.toThrow();
  await db.insert(tasks).values({ ...task, reward: 1000000 });
  await expect(db.insert(tasks).values({ ...task, reward: 1000001 })).rejects.toThrow();
  await expect(
    db.update(tasks).set({ reward: 1000001 }).where(eq(tasks.id, created.id)),
  ).rejects.toThrow();
  await db
    .insert(payroll)
    .values({ childId: child!.id, month: "2026-09-01", completedTaskCount: 1, totalReward: 100 });
  await expect(
    db.insert(payroll).values({ childId: child!.id, month: "2026-09-01" }),
  ).rejects.toThrow();
  await expect(
    db.insert(payroll).values({ childId: child!.id, month: "2026-10-15" }),
  ).rejects.toThrow();
  await expect(
    db.insert(payroll).values({ childId: child!.id, month: "2026-10-01", totalReward: -1 }),
  ).rejects.toThrow();
  await db.delete(parents).where(eq(parents.id, parent!.id));
  expect(await db.select().from(children).where(eq(children.id, child!.id))).toHaveLength(0);
});
