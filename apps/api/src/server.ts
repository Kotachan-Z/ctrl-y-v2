import { compare, hash } from "bcryptjs";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";

import { authenticate, familyId, isUuid, issueToken, parentOnly, type AuthEnv } from "./auth.js";
import { createFailureLimiter } from "./rate-limit.js";
import type { AuthRepository } from "./repository.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
async function body(request: Request): Promise<Record<string, unknown>> {
  // Let stream errors reach bodyLimit; only JSON parsing failures are a 400.
  const text = await request.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new HTTPException(400, { message: "JSONを送信してください" });
  }
  if (!isRecord(data)) throw new HTTPException(400, { message: "入力形式が不正です" });
  return data;
}
function credentials(data: Record<string, unknown>) {
  const email = typeof data.email === "string" ? data.email.trim().toLowerCase() : "";
  if (email.includes("\u0000") || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new HTTPException(400, { message: "メールアドレスを確認してください" });
  return { email, password: secretText(data.password, 8, "パスワード") };
}
function secretText(value: unknown, min: number, label: string) {
  if (
    typeof value !== "string" ||
    value.includes("\u0000") ||
    Array.from(value).length < min ||
    !value.trim() ||
    new TextEncoder().encode(value).length > 72
  )
    throw new HTTPException(400, {
      message: `${label}は${min}文字以上・UTF-8で72バイト以内にしてください`,
    });
  return value;
}
function childName(value: unknown) {
  if (
    typeof value !== "string" ||
    value.includes("\u0000") ||
    !value.trim() ||
    Array.from(value.trim()).length > 50
  )
    throw new HTTPException(400, { message: "名前は1〜50文字にしてください" });
  return value.trim();
}
export function createApp(options: {
  repository: AuthRepository | (() => AuthRepository);
  jwtSecret: string;
}) {
  if (new TextEncoder().encode(options.jwtSecret).length < 32)
    throw new Error("JWT_SECRET must be at least 32 bytes");
  const repo = () =>
    typeof options.repository === "function" ? options.repository() : options.repository;
  const auth = authenticate(options.jwtSecret, repo);
  const app = new Hono<AuthEnv>();
  const limit = createFailureLimiter();
  app.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
    console.error("API request failed", error);
    return c.json({ error: "サーバーエラーが発生しました" }, 500);
  });
  app.use(
    "/api/*",
    bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: "入力が大きすぎます" }, 413) }),
  );
  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.get("/api/health", (c) => c.json({ status: "ok" }));
  app.post("/api/parents", async (c) => {
    const { email, password } = credentials(await body(c.req.raw));
    return limit(`register:${email}`, async () => {
      const parent = await repo().register(email, await hash(password, 12));
      if (!parent) return c.json({ error: "このメールアドレスは登録済みです" }, 409);
      return c.json(
        {
          token: await issueToken({ id: parent.id, role: "parent" }, options.jwtSecret),
          parent: { id: parent.id, email: parent.email },
          needsSetup: true,
        },
        201,
      );
    });
  });
  app.post("/api/parents/login", async (c) => {
    const { email, password } = credentials(await body(c.req.raw));
    return limit(`login:${email}`, async () => {
      const parent = await repo().parentByEmail(email);
      if (!parent || !(await compare(password, parent.passwordHash)))
        return c.json({ error: "メールアドレスまたはパスワードが違います" }, 401);
      return c.json({
        token: await issueToken({ id: parent.id, role: "parent" }, options.jwtSecret),
        parent: { id: parent.id, email: parent.email },
        needsSetup: (await repo().listChildren(parent.id)).length === 0,
      });
    });
  });
  app.post("/api/setup", auth, parentOnly, async (c) => {
    const data = await body(c.req.raw);
    const name = childName(data.name);
    const keyword = secretText(data.keyword, 4, "あいことば");
    const child = await repo().addChild(familyId(c.get("identity")), name, await hash(keyword, 12));
    if (!child) return c.json({ error: "初回セットアップは完了しています" }, 409);
    return c.json({ child }, 201);
  });
  app.post("/api/children", auth, parentOnly, async (c) => {
    const data = await body(c.req.raw);
    if (Object.keys(data).some((key) => key !== "name"))
      return c.json({ error: "子供の追加では名前のみ指定してください" }, 400);
    const child = await repo().addChild(familyId(c.get("identity")), childName(data.name));
    if (!child) return c.json({ error: "先に初回セットアップを完了してください" }, 409);
    return c.json({ child }, 201);
  });
  app.get("/api/children", auth, parentOnly, async (c) =>
    c.json({ children: await repo().listChildren(familyId(c.get("identity"))) }),
  );
  app.post("/api/children/:childId/login", async (c) => {
    const id = c.req.param("childId");
    if (!isUuid(id)) return c.json({ error: "ログインURLを確認してください" }, 400);
    const keyword = secretText((await body(c.req.raw)).keyword, 4, "あいことば");
    return limit(`child:${id.toLowerCase()}`, async () => {
      const record = await repo().childById(id);
      if (!record || !record.parent.keyword || !(await compare(keyword, record.parent.keyword)))
        return c.json({ error: "ログインURLまたはあいことばが違います" }, 401);
      return c.json({
        token: await issueToken(
          { id, role: "child", parentId: record.parent.id },
          options.jwtSecret,
        ),
        child: { id, name: record.child.name },
      });
    });
  });
  // Used by guards to validate expiration, identity, and family membership server-side.
  app.get("/api/session", auth, (c) => c.json({ identity: c.get("identity") }));
  return app;
}
