import { createMiddleware } from "hono/factory";
import { sign, verify } from "hono/jwt";

import type { AuthRepository } from "./repository.js";

export type Identity =
  | { role: "parent"; id: string }
  | { role: "child"; id: string; parentId: string };
export type AuthEnv = { Variables: { identity: Identity } };
export const isUuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export function familyId(identity: Identity) {
  return identity.role === "parent" ? identity.id : identity.parentId;
}
const issuer = "ctrl-y";
const audience = "ctrl-y-api";
export async function issueToken(identity: Identity, secret: string) {
  const now = Math.floor(Date.now() / 1000);
  return sign(
    {
      sub: identity.id,
      role: identity.role,
      ...(identity.role === "child" ? { parentId: identity.parentId } : {}),
      purpose: "access",
      iss: issuer,
      aud: audience,
      iat: now,
      exp: now + 60 * 60,
      jti: crypto.randomUUID(),
    },
    secret,
    "HS256",
  );
}
export function authenticate(secret: string, repository: () => AuthRepository) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    const match = /^Bearer ([^\s]+)$/i.exec(c.req.header("Authorization") ?? "");
    if (!match) return c.json({ error: "ログインしてください" }, 401);
    let identity: Identity;
    try {
      const payload = await verify(match[1], secret, "HS256");
      const now = Math.floor(Date.now() / 1000);
      if (
        payload.purpose !== "access" ||
        payload.iss !== issuer ||
        payload.aud !== audience ||
        !isUuid(payload.sub) ||
        typeof payload.exp !== "number" ||
        !Number.isFinite(payload.exp) ||
        payload.exp <= now ||
        typeof payload.iat !== "number" ||
        !Number.isFinite(payload.iat) ||
        payload.iat > now ||
        payload.exp <= payload.iat ||
        payload.exp - payload.iat > 60 * 60
      )
        throw new Error("Invalid access claims");
      if (payload.role === "parent") identity = { role: "parent", id: payload.sub };
      else if (payload.role === "child" && isUuid(payload.parentId))
        identity = { role: "child", id: payload.sub, parentId: payload.parentId };
      else throw new Error("Invalid role");
    } catch {
      return c.json({ error: "ログインし直してください" }, 401);
    }
    const repo = repository();
    if (identity.role === "parent") {
      if (!(await repo.parentById(identity.id)))
        return c.json({ error: "ログインし直してください" }, 401);
    } else {
      const record = await repo.childById(identity.id);
      if (!record || record.parent.id !== identity.parentId)
        return c.json({ error: "ログインし直してください" }, 401);
    }
    c.set("identity", identity);
    await next();
  });
}
export const parentOnly = createMiddleware<AuthEnv>(async (c, next) => {
  if (c.get("identity").role !== "parent") return c.json({ error: "親アカウントが必要です" }, 403);
  await next();
});

export async function hashRefreshToken(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export async function newRefreshToken() {
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return {
    token,
    tokenHash: await hashRefreshToken(token),
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  };
}
export async function issueSession(identity: Identity, secret: string, repository: AuthRepository) {
  const refresh = await newRefreshToken();
  const token = await issueToken(identity, secret);
  await repository.createRefreshToken(identity, refresh);
  return { token, refreshToken: refresh.token };
}
