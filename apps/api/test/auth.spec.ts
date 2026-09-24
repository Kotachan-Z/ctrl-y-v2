/* Test response assertions use the API contract under test. */
/* oxlint-disable typescript-eslint/no-unsafe-type-assertion */
import { randomUUID } from "node:crypto";

import { parents } from "@ctrl-y/database";
import { compare } from "bcryptjs";
import { eq } from "drizzle-orm";
import { sign, verify } from "hono/jwt";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { familyId, issueToken } from "../src/auth.js";
import { createApp } from "../src/server.js";
import { secret, testApp } from "./helpers.js";

let fixture: Awaited<ReturnType<typeof testApp>>;
beforeAll(async () => {
  fixture = await testApp();
}, 30_000);
afterAll(async () => {
  await fixture?.client.close();
});
const password = "password-123";
const keyword = "ひみつのことば";
function request(path: string, body?: unknown, token?: string) {
  return fixture.app.request(`/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function register() {
  const email = `${randomUUID()}@example.test`;
  const response = await request("/parents", { email, password });
  expect(response.status).toBe(201);
  const result = (await response.json()) as {
    token: string;
    parent: { id: string; email: string };
    needsSetup: boolean;
  };
  return { ...result, email };
}
async function setup(token: string) {
  const response = await request("/setup", { name: "はな", keyword }, token);
  expect(response.status).toBe(201);
  return ((await response.json()) as { child: { id: string; name: string } }).child;
}

describe("parent and child authentication", () => {
  test("registration hashes secrets, normalizes email, rejects duplicates, and logs in", async () => {
    const email = `${randomUUID()}@example.test`;
    const response = await request("/parents", { email: ` ${email.toUpperCase()} `, password });
    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.parent.email).toBe(email);
    expect(data.needsSetup).toBe(true);
    expect(JSON.stringify(data)).not.toContain("passwordHash");
    const parent = await fixture.repository.parentByEmail(email);
    expect(parent?.keyword).toBe("");
    expect(parent?.passwordHash).not.toBe(password);
    expect(await compare(password, parent!.passwordHash)).toBe(true);
    const claims = await verify(data.token, secret, "HS256");
    expect(claims).toMatchObject({
      sub: data.parent.id,
      role: "parent",
      purpose: "access",
      iss: "ctrl-y",
      aud: "ctrl-y-api",
    });
    expect(Number(claims.exp) - Number(claims.iat)).toBe(86400);
    expect((await request("/parents", { email, password })).status).toBe(409);
    expect((await request("/parents/login", { email, password })).status).toBe(200);
    expect(
      (await request("/parents/login", { email, password: "incorrect-password" })).status,
    ).toBe(401);
    expect(
      (await request("/parents/login", { email: "missing@example.test", password })).status,
    ).toBe(401);
  });
  test("setup, shared keyword, extra children, session role and family isolation", async () => {
    const parent = await register();
    expect((await request("/children", { name: "まだ" }, parent.token)).status).toBe(409);
    const first = await setup(parent.token);
    const stored = await fixture.repository.parentById(parent.parent.id);
    expect(stored?.keyword).not.toBe(keyword);
    expect(await compare(keyword, stored!.keyword)).toBe(true);
    expect(
      (await request("/setup", { name: "重複", keyword: "changed-keyword" }, parent.token)).status,
    ).toBe(409);
    expect((await request("/children", { name: "ふたりめ", keyword }, parent.token)).status).toBe(
      400,
    );
    const added = await request("/children", { name: "ふたりめ" }, parent.token);
    expect(added.status).toBe(201);
    const second = (await added.json()).child;
    const children = await (await request("/children", undefined, parent.token)).json();
    expect(children.children).toHaveLength(2);
    expect(children.children.map((c: { id: string }) => c.id)).toContain(first.id);
    expect(JSON.stringify(children)).not.toContain("keyword");
    const other = await register();
    expect(await (await request("/children", undefined, other.token)).json()).toEqual({
      children: [],
    });
    for (const child of [first, second]) {
      const login = await request(`/children/${child.id}/login`, { keyword });
      expect(login.status).toBe(200);
      const { token } = await login.json();
      expect(await verify(token, secret, "HS256")).toMatchObject({
        sub: child.id,
        role: "child",
        parentId: parent.parent.id,
      });
      expect(await (await request("/session", undefined, token)).json()).toEqual({
        identity: { id: child.id, role: "child", parentId: parent.parent.id },
      });
      expect((await request("/children", undefined, token)).status).toBe(403);
      expect((await request("/setup", { name: "禁止", keyword }, token)).status).toBe(403);
      expect((await request("/children", { name: "禁止" }, token)).status).toBe(403);
      expect((await request(`/children/${child.id}/login`, { keyword: "wrong-word" })).status).toBe(
        401,
      );
    }
    expect((await request(`/children/${randomUUID()}/login`, { keyword })).status).toBe(401);
    expect((await request("/children/not-an-id/login", { keyword })).status).toBe(400);
    expect(
      (await (await request("/parents/login", { email: parent.email, password })).json())
        .needsSetup,
    ).toBe(false);
  });
  test("concurrent setup creates exactly one child and keeps its keyword", async () => {
    const parent = await register();
    const responses = await Promise.all([
      request("/setup", { name: "A", keyword: "keyword-a" }, parent.token),
      request("/setup", { name: "B", keyword: "keyword-b" }, parent.token),
    ]);
    expect(responses.map((r) => r.status)).toEqual(expect.arrayContaining([201, 409]));
    const children = await fixture.repository.listChildren(parent.parent.id);
    expect(children).toHaveLength(1);
    expect(
      (
        await request(`/children/${children[0].id}/login`, {
          keyword: children[0].name === "A" ? "keyword-a" : "keyword-b",
        })
      ).status,
    ).toBe(200);
  });
});

test("validation rejects malformed JSON, invalid email, short/oversized secrets and empty names", async () => {
  expect((await fixture.app.request("/api/parents", { method: "POST", body: "{" })).status).toBe(
    400,
  );
  for (const body of [
    null,
    [],
    { email: "invalid", password },
    { email: "a@b.test", password: "short" },
    { email: "a@b.test", password: "あ".repeat(25) },
  ]) {
    expect((await request("/parents", body)).status).toBe(400);
  }
  const parent = await register();
  for (const body of [
    { name: " ", keyword },
    { name: "a".repeat(51), keyword },
    { name: "a", keyword: "abc" },
    { name: "a", keyword: "あ".repeat(25) },
  ]) {
    expect((await request("/setup", body, parent.token)).status).toBe(400);
  }
  expect(
    (await request("/parents", { email: "a@b.test", password: "a".repeat(17000) })).status,
  ).toBe(413);
});

test.each([false, true])(
  "body limit enforces UTF-8 byte size (Content-Length: %s)",
  async (withLength) => {
    const payload = JSON.stringify({ email: "invalid", password: "あ".repeat(5500) });
    const size = new TextEncoder().encode(payload).length;
    expect(payload.length).toBeLessThan(16 * 1024);
    expect(size).toBeGreaterThan(16 * 1024);
    const response = await fixture.app.request("/api/parents", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(withLength ? { "Content-Length": String(size) } : {}),
      },
      body: payload,
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "入力が大きすぎます" });
  },
);

test("authentication rejects missing, tampered, expired, reset-purpose and malformed claims", async () => {
  const parent = await register();
  expect((await request("/children")).status).toBe(401);
  expect((await request("/children", undefined, `${parent.token}x`)).status).toBe(401);
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    sub: parent.parent.id,
    role: "parent",
    purpose: "access",
    iss: "ctrl-y",
    aud: "ctrl-y-api",
    iat: now,
    exp: now + 3600,
  };
  for (const override of [
    { purpose: "password-reset" },
    { exp: now - 1 },
    { role: "admin" },
    { exp: undefined },
    { iss: "other" },
    { aud: "other" },
    { sub: "bad-id" },
    { role: "child", parentId: "bad-id" },
    { iat: now + 500 },
  ]) {
    const token = await sign({ ...claims, ...override }, secret, "HS256");
    expect((await request("/children", undefined, token)).status).toBe(401);
  }
  const wrongKey = await sign(claims, `${secret}-wrong`, "HS256");
  expect((await request("/children", undefined, wrongKey)).status).toBe(401);
  const child = await setup(parent.token);
  const mismatchedFamily = await issueToken(
    { role: "child", id: child.id, parentId: randomUUID() },
    secret,
  );
  expect((await request("/session", undefined, mismatchedFamily)).status).toBe(401);
  await fixture.db.delete(parents).where(eq(parents.id, parent.parent.id));
  expect((await request("/children", undefined, parent.token)).status).toBe(401);
});

test("family helper returns parent scope and missing secret fails closed", () => {
  expect(familyId({ role: "parent", id: "parent" })).toBe("parent");
  expect(familyId({ role: "child", id: "child", parentId: "parent" })).toBe("parent");
  expect(() => createApp({ repository: fixture.repository, jwtSecret: "" })).toThrow("JWT_SECRET");
});
