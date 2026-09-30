import { children, parents } from "@ctrl-y/database";
import { afterAll, beforeAll, expect, test } from "vitest";

import { issueToken } from "../src/auth.js";
import { secret, testApp } from "./helpers.js";

let fixture: Awaited<ReturnType<typeof testApp>>;
let parentId: string;
let parent: string, child: string;
beforeAll(async () => {
  fixture = await testApp();
  const [p] = await fixture.db
    .insert(parents)
    .values({ email: "payroll-settings@example.test", passwordHash: "unused" })
    .returning();
  parentId = p.id;
  const [c] = await fixture.db.insert(children).values({ parentId, name: "子" }).returning();
  parent = await issueToken({ role: "parent", id: parentId }, secret);
  child = await issueToken({ role: "child", id: c.id, parentId }, secret);
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

test("payroll settings default to false, update independently and are parent-only", async () => {
  const initial = await request("/settings/payroll");
  expect(initial.status).toBe(200);
  expect(await initial.json()).toEqual({ settings: { payDay: false, cutoffDay: false } });

  const setPayDay = await request("/settings/payroll", "PATCH", parent, { payDay: true });
  expect(setPayDay.status).toBe(200);
  expect(await setPayDay.json()).toEqual({ settings: { payDay: true, cutoffDay: false } });

  const setCutoff = await request("/settings/payroll", "PATCH", parent, { cutoffDay: true });
  expect(setCutoff.status).toBe(200);
  expect(await setCutoff.json()).toEqual({ settings: { payDay: true, cutoffDay: true } });

  const setBoth = await request("/settings/payroll", "PATCH", parent, {
    payDay: false,
    cutoffDay: false,
  });
  expect(setBoth.status).toBe(200);
  expect(await setBoth.json()).toEqual({ settings: { payDay: false, cutoffDay: false } });
});

test("payroll settings reject invalid input and non-parent access", async () => {
  expect((await request("/settings/payroll", "GET", child)).status).toBe(403);
  expect((await request("/settings/payroll", "GET", "")).status).toBe(401);
  expect((await request("/settings/payroll", "PATCH", child, { payDay: true })).status).toBe(403);
  expect((await request("/settings/payroll", "PATCH", parent, {})).status).toBe(400);
  expect((await request("/settings/payroll", "PATCH", parent, { payDay: "yes" })).status).toBe(400);
  expect((await request("/settings/payroll", "PATCH", parent, { cutoffDay: 1 })).status).toBe(400);
  expect((await request("/settings/payroll", "PATCH", parent, { other: true })).status).toBe(400);
});
