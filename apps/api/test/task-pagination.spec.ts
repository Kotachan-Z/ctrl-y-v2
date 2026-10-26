import { children, parents, tasks } from "@ctrl-y/database";
import { eq, sql } from "drizzle-orm";
import { expect, test } from "vitest";

import { issueToken } from "../src/auth.js";
import { secret, testApp } from "./helpers.js";

test("DONE cursors preserve microseconds, ties and NULL fallback across DateStyle and time zones", async () => {
  const fixture = await testApp();
  try {
    const [parent] = await fixture.db
      .insert(parents)
      .values({ email: "pages@example.test", passwordHash: "unused" })
      .returning();
    const token = await issueToken({ role: "parent", id: parent.id }, secret);
    const request = (query: string) =>
      fixture.app.request(`/api/tasks?${query}`, { headers: { Authorization: `Bearer ${token}` } });
    for (let i = 0; i < 12; i++) {
      await fixture.db.insert(tasks).values({
        parentId: parent.id,
        name: `task${i}`,
        reward: 1,
        deadline: new Date(),
        status: "DONE",
        createdAt: sql`'2028-01-01T00:00:00.123451Z'::timestamptz`,
        completedAt: i % 4 === 0 ? null : sql`${`2028-01-01T00:00:00.12345${i % 3}Z`}::timestamptz`,
      });
    }
    const expected = await fixture.db
      .select({ id: tasks.id })
      .from(tasks)
      .orderBy(sql`coalesce(${tasks.completedAt}, ${tasks.createdAt}) desc, ${tasks.id} desc`);
    for (const style of ["ISO, MDY", "SQL, DMY", "Postgres, DMY"]) {
      await fixture.client.query(`set datestyle = '${style}'`);
      for (const zone of ["UTC", "Asia/Kolkata", "America/St_Johns"]) {
        await fixture.client.query(`set time zone '${zone}'`);
        for (const limit of [1, 2, 5]) {
          const ids: string[] = [];
          let cursor: string | null = null;
          do {
            const response = await request(
              `status=DONE&limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`,
            );
            expect(response.status).toBe(200);
            const page = await response.json();
            ids.push(...page.tasks.map((task: { id: string }) => task.id));
            cursor = page.nextCursor;
            expect(ids.length).toBeLessThanOrEqual(12);
          } while (cursor);
          expect(ids).toEqual(expected.map((task) => task.id));
        }
      }
    }
  } finally {
    await fixture.client.close();
  }
}, 30000);

test("combined active statuses validate filters and keyset pages handle status changes", async () => {
  const fixture = await testApp();
  try {
    const [parent] = await fixture.db
      .insert(parents)
      .values({ email: "changes@example.test", passwordHash: "unused" })
      .returning();
    const [child] = await fixture.db
      .insert(children)
      .values({ parentId: parent.id, name: "子供" })
      .returning();
    const token = await issueToken({ role: "parent", id: parent.id }, secret);
    const request = (query: string) =>
      fixture.app.request(`/api/tasks?${query}`, { headers: { Authorization: `Bearer ${token}` } });
    const inserted = await fixture.db
      .insert(tasks)
      .values(
        (["TODO", "IN_PROGRESS", "WAIT_REVIEW", "DONE", "DONE", "DONE"] as const).map(
          (status, i) => ({
            parentId: parent.id,
            childId: child.id,
            name: `task${i}`,
            reward: 1,
            deadline: new Date(),
            status,
            completedAt: new Date(`2028-01-0${i + 1}T00:00:00Z`),
          }),
        ),
      )
      .returning();
    const active = `status=TODO,IN_PROGRESS,WAIT_REVIEW&childId=${child.id}`;
    const ids = async () =>
      (await (await request(active)).json()).tasks.map((task: { id: string }) => task.id);
    // Both sides are fresh arrays from map(), so sorting in place is safe.
    // oxlint-disable-next-line unicorn/no-array-sort
    expect((await ids()).sort()).toEqual(
      inserted
        .slice(0, 3)
        .map((task) => task.id)
        // oxlint-disable-next-line unicorn/no-array-sort
        .sort(),
    );
    await fixture.db
      .update(tasks)
      .set({ status: "IN_PROGRESS" })
      .where(eq(tasks.id, inserted[0].id));
    expect(await ids()).toHaveLength(3);
    for (const status of ["TODO,", ",DONE", "TODO,invalid", "", "DONE,DONE"])
      expect((await request(`status=${status}`)).status).toBe(400);
    const first = await (await request("status=DONE&limit=1")).json();
    expect(first.tasks[0].id).toBe(inserted[5].id);
    await fixture.db
      .update(tasks)
      .set({ status: "WAIT_REVIEW" })
      .where(eq(tasks.id, inserted[4].id));
    await fixture.db
      .update(tasks)
      .set({ status: "DONE", completedAt: new Date("2029-01-01") })
      .where(eq(tasks.id, inserted[2].id));
    const rest = await (await request(`status=DONE&limit=10&cursor=${first.nextCursor}`)).json();
    expect(rest.tasks.map((task: { id: string }) => task.id)).toEqual([inserted[3].id]);
    expect(rest.nextCursor).toBeNull();
    expect((await (await request("status=DONE&limit=1")).json()).tasks[0].id).toBe(inserted[2].id);
  } finally {
    await fixture.client.close();
  }
}, 30000);
