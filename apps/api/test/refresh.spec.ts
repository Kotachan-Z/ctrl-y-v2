/* Test response assertions use the API contract under test. */
/* oxlint-disable typescript-eslint/no-unsafe-type-assertion */
import { children, parents, refreshTokens } from "@ctrl-y/database";
import { eq } from "drizzle-orm";
import { verify } from "hono/jwt";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";

import { hashRefreshToken, issueSession } from "../src/auth.js";
import { secret, testApp } from "./helpers.js";

let fixture: Awaited<ReturnType<typeof testApp>>;
beforeAll(async () => {
  fixture = await testApp();
}, 30_000);
afterAll(async () => {
  await fixture?.client.close();
});
afterEach(() => vi.restoreAllMocks());
type Session = { token: string; refreshToken: string };
const post = (path: string, body: unknown) =>
  fixture.app.request(`/api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const refresh = (refreshToken: string, extra = {}) =>
  post("/auth/refresh", { refreshToken, ...extra });
async function session(role: "parent" | "child" = "parent") {
  const parent = (await fixture.repository.register(
    `${crypto.randomUUID()}@example.test`,
    "hash",
  ))!;
  const child = (await fixture.repository.addChild(parent.id, "child", "hash"))!;
  const identity =
    role === "parent" ? { role, id: parent.id } : { role, id: child.id, parentId: parent.id };
  return { ...(await issueSession(identity, secret, fixture.repository)), identity, parent, child };
}
async function rotate(token: string) {
  const response = await refresh(token);
  expect(response.status).toBe(200);
  return (await response.json()) as Session;
}

test.each(["parent", "child"] as const)(
  "%s refresh rotates opaque tokens and preserves identity",
  async (role) => {
    const original = await session(role);
    expect(original.refreshToken).toMatch(/^[0-9a-f]{64}$/);
    const [stored] = await fixture.db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, await hashRefreshToken(original.refreshToken)));
    expect(stored.tokenHash).not.toBe(original.refreshToken);
    expect(JSON.stringify(stored)).not.toContain(original.refreshToken);
    expect(stored.expiresAt.getTime() - stored.createdAt.getTime()).toBeGreaterThan(29 * 86400_000);
    expect(stored.expiresAt.getTime() - stored.createdAt.getTime()).toBeLessThanOrEqual(
      30 * 86400_000 + 1000,
    );
    const response = await refresh(original.refreshToken, {
      role: role === "parent" ? "child" : "parent",
      parentId: crypto.randomUUID(),
    });
    expect(response.status).toBe(200);
    const next = (await response.json()) as Session;
    expect(next.refreshToken).not.toBe(original.refreshToken);
    expect(next.token).not.toBe(original.token);
    const claims = await verify(next.token, secret, "HS256");
    expect(claims).toMatchObject({
      role,
      sub: original.identity.id,
      purpose: "access",
      iss: "ctrl-y",
      aud: "ctrl-y-api",
    });
    expect(Number(claims.exp) - Number(claims.iat)).toBe(3600);
    if (role === "child") expect(claims.parentId).toBe(original.parent.id);
    else expect(claims.parentId).toBeUndefined();
    const headers = { Authorization: `Bearer ${next.token}` };
    expect(await (await fixture.app.request("/api/session", { headers })).json()).toEqual({
      identity: original.identity,
    });
    expect((await fixture.app.request("/api/children", { headers })).status).toBe(
      role === "parent" ? 200 : 403,
    );
    const [successor] = await fixture.db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, await hashRefreshToken(next.refreshToken)));
    expect(successor.previousId).toBe(stored.id);
    expect(successor.rootId).toBe(stored.rootId);
    const [used] = await fixture.db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.id, stored.id));
    expect(used.revokedAt).toBeInstanceOf(Date);
  },
);

test("reuse of an ancestor revokes the entire chain, but leaves other login sessions intact", async () => {
  const first = await session();
  const independent = await issueSession(first.identity, secret, fixture.repository);
  const second = await rotate(first.refreshToken);
  const third = await rotate(second.refreshToken);
  expect((await refresh(second.refreshToken)).status).toBe(401);
  expect((await refresh(third.refreshToken)).status).toBe(401);
  expect((await refresh(first.refreshToken)).status).toBe(401);
  const rows = await fixture.db
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.parentId, first.parent.id));
  expect(rows.filter((row) => row.revokedAt)).toHaveLength(3);
  await rotate(independent.refreshToken);
});

test("concurrent refresh permits only one rotation and reuse invalidates the winner", async () => {
  const first = await session();
  const responses = await Promise.all([refresh(first.refreshToken), refresh(first.refreshToken)]);
  expect(responses.map((response) => response.status)).toEqual(expect.arrayContaining([200, 401]));
  const next = (await responses.find((response) => response.ok)!.json()) as Session;
  expect((await refresh(next.refreshToken)).status).toBe(401);
});

test("ancestor reuse racing a descendant refresh leaves no active descendant", async () => {
  const first = await session();
  const next = await rotate(first.refreshToken);
  const responses = await Promise.all([refresh(next.refreshToken), refresh(first.refreshToken)]);
  expect(responses[1].status).toBe(401);
  const rows = await fixture.db
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.parentId, first.parent.id));
  expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
});

test.each(["parent", "child"] as const)(
  "%s expired token is rejected without issuing a successor",
  async (role) => {
    const first = await session(role);
    await fixture.db
      .update(refreshTokens)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(refreshTokens.tokenHash, await hashRefreshToken(first.refreshToken)));
    expect((await refresh(first.refreshToken)).status).toBe(401);
    expect(
      await fixture.db
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.parentId, first.parent.id)),
    ).toHaveLength(1);
  },
);

test.each(["parent", "child"] as const)(
  "%s logout is idempotent and revokes refresh credentials",
  async (role) => {
    const first = await session(role);
    for (const token of [first.refreshToken, first.refreshToken, "unknown"]) {
      expect((await post("/auth/logout", { refreshToken: token })).status).toBe(200);
    }
    expect((await refresh(first.refreshToken)).status).toBe(401);
    const [stored] = await fixture.db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, await hashRefreshToken(first.refreshToken)));
    expect(stored.revokedAt).toBeInstanceOf(Date);
  },
);

test("refresh rate limit isolates token digests and expires after 60 seconds", async () => {
  const token = crypto.randomUUID();
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  for (let i = 0; i < 5; i++) expect((await refresh(token)).status).toBe(401);
  expect((await refresh(token)).status).toBe(429);
  expect((await refresh(crypto.randomUUID())).status).toBe(401);
  const valid = await session();
  await rotate(valid.refreshToken);
  clock.mockReturnValue(now + 60_000);
  expect((await refresh(token)).status).toBe(401);
});

test("malformed bodies are rejected and access JWTs cannot refresh", async () => {
  for (const path of ["/auth/refresh", "/auth/logout"]) {
    for (const body of [
      null,
      {},
      { refreshToken: 1 },
      { refreshToken: "" },
      { refreshToken: "x".repeat(1025) },
    ]) {
      expect((await post(path, body)).status).toBe(400);
    }
  }
  const first = await session();
  expect((await refresh(first.token)).status).toBe(401);
});

test.each(["parent", "child"] as const)(
  "deleting the %s removes its refresh credentials",
  async (role) => {
    const first = await session(role);
    const next = await rotate(first.refreshToken);
    if (role === "parent") await fixture.db.delete(parents).where(eq(parents.id, first.parent.id));
    else await fixture.db.delete(children).where(eq(children.id, first.child.id));
    expect((await refresh(next.refreshToken)).status).toBe(401);
  },
);

test("database rejects role/owner and child/family mismatches", async () => {
  const first = await session();
  const other = await session();
  for (const fields of [
    { role: "parent" as const, childId: first.child.id },
    { role: "child" as const, childId: null },
    { role: "child" as const, childId: other.child.id },
  ]) {
    const id = crypto.randomUUID();
    await expect(
      fixture.db.insert(refreshTokens).values({
        id,
        rootId: id,
        parentId: first.parent.id,
        tokenHash: crypto.randomUUID(),
        expiresAt: new Date(),
        ...fields,
      }),
    ).rejects.toThrow();
  }
});

test("failed successor insertion rolls back consumption of the previous token", async () => {
  const first = await session();
  const tokenHash = await hashRefreshToken(first.refreshToken);
  await expect(
    fixture.repository.rotateRefreshToken(tokenHash, {
      tokenHash,
      expiresAt: new Date(Date.now() + 86400_000),
    }),
  ).rejects.toThrow();
  await rotate(first.refreshToken);
});

test("revoking a parent session leaves its child's session usable", async () => {
  const first = await session();
  const child = await issueSession(
    { role: "child", id: first.child.id, parentId: first.parent.id },
    secret,
    fixture.repository,
  );
  expect((await post("/auth/logout", { refreshToken: first.refreshToken })).status).toBe(200);
  expect((await refresh(first.refreshToken)).status).toBe(401);
  const next = await rotate(child.refreshToken);
  expect(await verify(next.token, secret, "HS256")).toMatchObject({
    role: "child",
    sub: first.child.id,
  });
});

test.each(["parent", "child"] as const)(
  "%s logout with a rotated ancestor revokes descendants only in that chain",
  async (role) => {
    const first = await session(role);
    const independent = await issueSession(first.identity, secret, fixture.repository);
    const second = await rotate(first.refreshToken);
    const third = await rotate(second.refreshToken);
    for (let i = 0; i < 2; i++)
      expect((await post("/auth/logout", { refreshToken: first.refreshToken })).status).toBe(200);
    expect((await refresh(third.refreshToken)).status).toBe(401);
    await rotate(independent.refreshToken);
  },
);

test("logout racing a rotation leaves no active descendant", async () => {
  const first = await session();
  const second = await rotate(first.refreshToken);
  const responses = await Promise.all([
    refresh(second.refreshToken),
    post("/auth/logout", { refreshToken: first.refreshToken }),
  ]);
  expect(responses[1].status).toBe(200);
  const rows = await fixture.db
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.parentId, first.parent.id));
  expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
});
