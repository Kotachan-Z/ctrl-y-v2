import { children, parents, tasks } from "@ctrl-y/database";
import { afterAll, beforeAll, expect, test } from "vitest";

import { issueToken } from "../src/auth.js";
import { secret, testApp } from "./helpers.js";

let fixture: Awaited<ReturnType<typeof testApp>>;
let parent: string, other: string, child: string, sibling: string, outsider: string;
let childId: string, siblingId: string, parentId: string;
const fields = { name: "おそうじ", memo: "玄関", reward: 100, deadline: "2027-01-01T12:00:00Z" };
beforeAll(async () => {
  fixture = await testApp();
  const [p, q] = await fixture.db
    .insert(parents)
    .values([
      { email: "tasks@example.test", passwordHash: "unused" },
      { email: "other@example.test", passwordHash: "unused" },
    ])
    .returning();
  parentId = p.id;
  const [a, b, c] = await fixture.db
    .insert(children)
    .values([
      { parentId: p.id, name: "A" },
      { parentId: p.id, name: "B" },
      { parentId: q.id, name: "C" },
    ])
    .returning();
  childId = a.id;
  siblingId = b.id;
  parent = await issueToken({ role: "parent", id: p.id }, secret);
  other = await issueToken({ role: "parent", id: q.id }, secret);
  child = await issueToken({ role: "child", id: a.id, parentId: p.id }, secret);
  sibling = await issueToken({ role: "child", id: b.id, parentId: p.id }, secret);
  outsider = await issueToken({ role: "child", id: c.id, parentId: q.id }, secret);
}, 30000);
afterAll(async () => {
  await fixture?.client.close();
});
function request(path: string, method = "GET", token = parent, body?: unknown) {
  return fixture.app.request(`/api/tasks${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function create() {
  const response = await request("", "POST", parent, fields);
  expect(response.status).toBe(201);
  return (await response.json()).task;
}
test("CRUD is authenticated, parent-only and family scoped", async () => {
  const task = await create();
  expect(task).toMatchObject({
    ...fields,
    deadline: "2027-01-01T12:00:00.000Z",
    childId: null,
    status: "TODO",
    completedAt: null,
  });
  for (const token of [parent, child])
    expect((await request(`/${task.id}`, "GET", token)).status).toBe(200);
  for (const token of [other, outsider]) {
    expect((await request(`/${task.id}`, "GET", token)).status).toBe(404);
    expect(
      (await request(`/${task.id}/status`, "PATCH", token, { status: "IN_PROGRESS" })).status,
    ).toBe(404);
    expect((await (await request("", "GET", token)).json()).tasks).toEqual([]);
  }
  for (const method of ["PATCH", "DELETE"]) {
    expect((await request(`/${task.id}`, method, other, { name: "盗む" })).status).toBe(404);
    expect((await request(`/${task.id}`, method, child, { name: "禁止" })).status).toBe(403);
  }
  expect((await request("", "POST", child, fields)).status).toBe(403);
  for (const [path, method] of [
    ["", "GET"],
    ["", "POST"],
    [`/${task.id}`, "GET"],
    [`/${task.id}`, "PATCH"],
    [`/${task.id}`, "DELETE"],
    [`/${task.id}/status`, "PATCH"],
  ])
    expect((await request(path, method, "", method === "GET" ? undefined : fields)).status).toBe(
      401,
    );
  const edited = await request(`/${task.id}`, "PATCH", parent, {
    name: "変更",
    memo: null,
    reward: 0,
  });
  expect(edited.status).toBe(200);
  expect((await edited.json()).task).toMatchObject({
    name: "変更",
    memo: null,
    reward: 0,
    status: "TODO",
  });
  expect((await request(`/${task.id}`, "DELETE")).status).toBe(200);
  expect((await request(`/${task.id}`)).status).toBe(404);
});
test("atomic claim, assigned-child submission and parent approval only; no skipping or reversing", async () => {
  const task = await create();
  const path = `/${task.id}/status`;
  const change = (token: string, status: string) => request(path, "PATCH", token, { status });
  expect((await change(parent, "IN_PROGRESS")).status).toBe(403);
  expect((await change(parent, "DONE")).status).toBe(409);
  expect((await change(child, "WAIT_REVIEW")).status).toBe(409);
  const results = await Promise.all([change(child, "IN_PROGRESS"), change(sibling, "IN_PROGRESS")]);
  expect(results.map((r) => r.status)).toEqual(expect.arrayContaining([200, 409]));
  const winner = results[0].status === 200 ? child : sibling;
  const loser = winner === child ? sibling : child;
  const assigned = winner === child ? childId : siblingId;
  expect((await (await request(`/${task.id}`)).json()).task).toMatchObject({
    childId: assigned,
    completedAt: null,
  });
  const filtered = await (
    await request(`?status=IN_PROGRESS&childId=${assigned}`, "GET", child)
  ).json();
  expect(filtered.tasks.map((t: { id: string }) => t.id)).toContain(task.id);
  expect((await change(loser, "WAIT_REVIEW")).status).toBe(409);
  expect((await change(parent, "WAIT_REVIEW")).status).toBe(403);
  expect((await change(winner, "DONE")).status).toBe(403);
  expect((await change(winner, "TODO")).status).toBe(400);
  expect((await change(winner, "WAIT_REVIEW")).status).toBe(200);
  expect((await change(winner, "IN_PROGRESS")).status).toBe(409);
  const before = Date.now();
  const approved = await change(parent, "DONE");
  expect(approved.status).toBe(200);
  const done = (await approved.json()).task;
  expect(done.status).toBe("DONE");
  expect(Date.parse(done.completedAt)).toBeGreaterThanOrEqual(before);
  expect(Date.parse(done.completedAt)).toBeLessThanOrEqual(Date.now());
  expect((await change(parent, "DONE")).status).toBe(409);
  expect((await change(winner, "WAIT_REVIEW")).status).toBe(409);
  expect((await (await request(`/${task.id}`)).json()).task.completedAt).toBe(done.completedAt);
});
test("a preassigned TODO cannot be claimed", async () => {
  const [task] = await fixture.db
    .insert(tasks)
    .values({ ...fields, deadline: new Date(fields.deadline), parentId, childId })
    .returning();
  expect(
    (await request(`/${task.id}/status`, "PATCH", child, { status: "IN_PROGRESS" })).status,
  ).toBe(409);
});
test("input validation rejects invalid fields and protected fields", async () => {
  const task = await create();
  for (const invalid of [
    { name: " " },
    { name: "a".repeat(101) },
    { name: "a\u0000" },
    { memo: "\u0000" },
    { memo: "a".repeat(2001) },
    { reward: -1 },
    { reward: 1.5 },
    { reward: 2147483648 },
    { reward: "1" },
    { deadline: "not-a-date" },
    { deadline: "2027-02-30T00:00:00Z" },
    { deadline: "2027-01-01" },
    { status: "DONE" },
    { childId },
    { parentId },
    { completedAt: fields.deadline },
  ]) {
    expect((await request("", "POST", parent, { ...fields, ...invalid })).status).toBe(400);
    expect((await request(`/${task.id}`, "PATCH", parent, invalid)).status).toBe(400);
  }
  for (const data of [{}, [], null])
    expect((await request("", "POST", parent, data)).status).toBe(400);
  expect((await request(`/${task.id}`, "PATCH", parent, {})).status).toBe(400);
  for (const path of ["/bad", "?status=invalid", "?childId=invalid"])
    expect((await request(path)).status).toBe(400);
  expect((await request(`/${task.id}/status`, "PATCH", child, { status: "INVALID" })).status).toBe(
    400,
  );
  expect(
    (await request(`/${task.id}/status`, "PATCH", child, { status: "IN_PROGRESS", childId }))
      .status,
  ).toBe(400);
  const unassigned = (await (await request("?status=TODO&childId=null")).json()).tasks;
  expect(unassigned.every((t: { childId: string | null }) => t.childId === null)).toBe(true);
});
