import { fileURLToPath } from "node:url";

import { createLocalDatabase } from "@ctrl-y/database/local";
import { migrate } from "drizzle-orm/pglite/migrator";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import { expect, test } from "vitest";

import { authenticate, familyId, issueToken, parentOnly, type AuthEnv } from "../src/auth.js";
import { createRepository } from "../src/repository.js";

test("real JWT middleware validates purpose, expiration, signature, role and family", async () => {
  const { db, client } = createLocalDatabase("memory://");
  try {
    await migrate(db, {
      migrationsFolder: fileURLToPath(
        new URL("../../../packages/database/migrations", import.meta.url),
      ),
    });
    const repository = createRepository(db);
    const parent = await repository.register("token@example.test", "test-hash");
    const child = await repository.addChild(parent!.id, "child", "keyword-hash");
    const secret = "test-only-secret-at-least-32-bytes-long";
    const auth = authenticate(secret, () => repository);
    const app = new Hono<AuthEnv>()
      .get("/session", auth, (c) => c.json({ parentId: familyId(c.get("identity")) }))
      .get("/parent", auth, parentOnly, (c) => c.json({ ok: true }));
    const request = (token: string, path = "/session") =>
      app.request(path, { headers: { Authorization: `Bearer ${token}` } });
    const parentToken = await issueToken({ id: parent!.id, role: "parent" }, secret);
    const childToken = await issueToken(
      { id: child!.id, role: "child", parentId: parent!.id },
      secret,
    );
    expect((await request(parentToken, "/parent")).status).toBe(200);
    expect(await (await request(childToken)).json()).toEqual({ parentId: parent!.id });
    expect((await request(childToken, "/parent")).status).toBe(403);
    expect((await app.request("/session")).status).toBe(401);
    expect((await request(`${parentToken}x`)).status).toBe(401);
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      sub: parent!.id,
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
      { exp: undefined },
      { role: "admin" },
      { iss: "other" },
      { aud: "other" },
      { sub: "bad-id" },
      { iat: now + 500 },
    ]) {
      expect((await request(await sign({ ...claims, ...override }, secret, "HS256"))).status).toBe(
        401,
      );
    }
    expect((await request(await sign(claims, `${secret}-wrong`, "HS256"))).status).toBe(401);
    const mismatch = await issueToken(
      { role: "child", id: child!.id, parentId: crypto.randomUUID() },
      secret,
    );
    expect((await request(mismatch)).status).toBe(401);
  } finally {
    await client.close();
  }
}, 30_000);
