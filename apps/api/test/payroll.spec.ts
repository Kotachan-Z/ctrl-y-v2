import { children, parents, payroll, tasks } from "@ctrl-y/database";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";

import { issueToken } from "../src/auth.js";
import { secret, testApp } from "./helpers.js";

let fixture: Awaited<ReturnType<typeof testApp>>;
let parentId: string, childId: string, siblingId: string, outsiderId: string;
let parent: string, other: string, child: string;
const deadline = new Date("2027-01-01T00:00:00Z");
beforeAll(async () => {
  fixture = await testApp();
  const [p, q] = await fixture.db
    .insert(parents)
    .values([
      { email: "payroll@example.test", passwordHash: "unused" },
      { email: "payroll-other@example.test", passwordHash: "unused" },
    ])
    .returning();
  parentId = p.id;
  const [a, b, c] = await fixture.db
    .insert(children)
    .values([
      { parentId, name: "A" },
      { parentId, name: "B" },
      { parentId: q.id, name: "C" },
    ])
    .returning();
  childId = a.id;
  siblingId = b.id;
  outsiderId = c.id;
  parent = await issueToken({ role: "parent", id: parentId }, secret);
  other = await issueToken({ role: "parent", id: q.id }, secret);
  child = await issueToken({ role: "child", id: childId, parentId }, secret);
}, 30000);
afterAll(async () => {
  await fixture?.client.close();
});
function request(path: string, method = "GET", token = parent, body?: unknown) {
  return fixture.app.request(`/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function totals(month: string, id = childId) {
  const response = await request(`/payroll?month=${month}&childId=${id}`);
  expect(response.status).toBe(200);
  return (await response.json()).payroll;
}

test("recalculation derives UTC month totals, excludes other tasks and is idempotent", async () => {
  await fixture.db.insert(tasks).values(
    [
      { completedAt: new Date("2024-02-01T00:00:00Z"), reward: 100 },
      { completedAt: new Date("2024-02-29T23:59:59.999Z"), reward: 250 },
      { completedAt: new Date("2024-01-31T23:59:59.999Z"), reward: 1000 },
      { completedAt: new Date("2024-03-01T00:00:00Z"), reward: 1000 },
      { completedAt: null, reward: 1000 },
    ].map((fields) => ({
      ...fields,
      parentId,
      childId,
      deadline,
      name: "境界",
      status: "DONE" as const,
    })),
  );
  await fixture.db.insert(tasks).values([
    {
      parentId,
      childId,
      deadline,
      name: "未完了",
      status: "WAIT_REVIEW",
      completedAt: new Date("2024-02-10T00:00:00Z"),
      reward: 1000,
    },
    {
      parentId,
      childId: siblingId,
      deadline,
      name: "兄弟",
      status: "DONE",
      completedAt: new Date("2024-02-10T00:00:00Z"),
      reward: 1000,
    },
  ]);
  const first = await fixture.repository.recalculatePayroll(childId, "2024-02-01");
  expect(first).toMatchObject({ completedTaskCount: 2, totalReward: 350 });
  await fixture.db.update(payroll).set({ totalReward: 9999 }).where(eq(payroll.id, first.id));
  expect(await fixture.repository.recalculatePayroll(childId, "2024-02-01")).toEqual(first);
  expect(await totals("2024-02-01")).toHaveLength(1);
  expect(await fixture.repository.recalculatePayroll(childId, "2024-04-01")).toMatchObject({
    completedTaskCount: 0,
    totalReward: 0,
  });
});

test("approval, reward edits, reopening across months and deletion recalculate payroll", async () => {
  const created = await request("/tasks", "POST", parent, {
    name: "掃除",
    reward: 100,
    deadline: deadline.toISOString(),
  });
  expect(created.status).toBe(201);
  const { task } = await created.json();
  const path = `/tasks/${task.id}`;
  for (const status of ["IN_PROGRESS", "WAIT_REVIEW"])
    expect((await request(`${path}/status`, "PATCH", child, { status })).status).toBe(200);
  expect((await request(`${path}/status`, "PATCH", parent, { status: "DONE" })).status).toBe(200);
  const stored = await fixture.repository.taskById(parentId, task.id);
  const month = `${stored!.completedAt!.toISOString().slice(0, 7)}-01`;
  expect(await totals(month)).toMatchObject([{ completedTaskCount: 1, totalReward: 100 }]);
  expect((await request(`${path}/status`, "PATCH", parent, { status: "DONE" })).status).toBe(409);
  expect((await request(path, "PATCH", parent, { reward: 275 })).status).toBe(200);
  expect(await totals(month)).toMatchObject([{ completedTaskCount: 1, totalReward: 275 }]);
  expect((await request(`${path}/status`, "PATCH", child, { status: "WAIT_REVIEW" })).status).toBe(
    409,
  );
  expect((await request(`${path}/status`, "PATCH", parent, { status: "WAIT_REVIEW" })).status).toBe(
    200,
  );
  expect((await fixture.repository.taskById(parentId, task.id))?.completedAt).toBeNull();
  expect(await totals(month)).toMatchObject([{ completedTaskCount: 0, totalReward: 0 }]);
  // Seed an earlier completion to exercise approval reversal across a month boundary.
  await fixture.db
    .update(tasks)
    .set({ status: "DONE", completedAt: new Date("2023-12-31T23:59:59Z") })
    .where(eq(tasks.id, task.id));
  await fixture.repository.recalculatePayroll(childId, "2023-12-01");
  expect((await request(`${path}/status`, "PATCH", parent, { status: "WAIT_REVIEW" })).status).toBe(
    200,
  );
  expect((await request(`${path}/status`, "PATCH", parent, { status: "DONE" })).status).toBe(200);
  expect(await totals("2023-12-01")).toMatchObject([{ completedTaskCount: 0, totalReward: 0 }]);
  expect(await totals(month)).toMatchObject([{ completedTaskCount: 1, totalReward: 275 }]);
  expect((await request(path, "DELETE")).status).toBe(200);
  expect(await totals(month)).toMatchObject([{ completedTaskCount: 0, totalReward: 0 }]);
});

test("payroll reads filter, order and enforce parent ownership and child identity", async () => {
  await fixture.repository.recalculatePayroll(siblingId, "2024-02-01");
  await fixture.repository.recalculatePayroll(outsiderId, "2024-02-01");
  const all = (await (await request("/payroll")).json()).payroll;
  expect(new Set(all.map((row: { childId: string }) => row.childId))).toEqual(
    new Set([childId, siblingId]),
  );
  expect((await (await request("/payroll?month=2024-02-01")).json()).payroll).toHaveLength(2);
  const history = (await (await request(`/children/${childId}/payroll`)).json()).payroll;
  expect(history.every((row: { childId: string }) => row.childId === childId)).toBe(true);
  const months: string[] = history.map((row: { month: string }) => row.month);
  expect(months.every((month, index) => index === 0 || months[index - 1] <= month)).toBe(true);
  expect(
    (await (await request(`/children/${childId}/payroll`, "GET", child)).json()).payroll,
  ).toEqual(history);
  expect((await request(`/children/${siblingId}/payroll`, "GET", child)).status).toBe(403);
  expect((await request(`/children/${outsiderId}/payroll`, "GET", child)).status).toBe(404);
  expect((await request(`/children/${childId}/payroll`, "GET", other)).status).toBe(404);
  expect((await request(`/payroll?childId=${outsiderId}`)).status).toBe(404);
  expect((await request(`/payroll?childId=${childId}`, "GET", other)).status).toBe(404);
  expect((await request("/payroll", "GET", child)).status).toBe(403);
  for (const path of ["/payroll", `/children/${childId}/payroll`])
    expect((await request(path, "GET", "")).status).toBe(401);
  for (const query of [
    "month=2024-02-02",
    "month=2024-13-01",
    "month=0000-01-01",
    "month=bad",
    "month=",
    "childId=bad",
    "childId=",
  ])
    expect((await request(`/payroll?${query}`)).status).toBe(400);
  expect((await request("/children/bad/payroll")).status).toBe(400);
  expect((await request(`/children/${crypto.randomUUID()}/payroll`)).status).toBe(404);
  expect(await totals("2020-01-01")).toEqual([]);
});
