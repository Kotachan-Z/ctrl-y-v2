import { compare, hash } from "bcryptjs";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";

import { authenticate, familyId, isUuid, issueToken, parentOnly, type AuthEnv } from "./auth.js";
import { notifyReview, readVapidConfig, validateVapidConfig, type VapidConfig } from "./push.js";
import { createFailureLimiter } from "./rate-limit.js";
import type { AuthRepository, TaskFields, TaskStatus } from "./repository.js";

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
function taskStatus(value: unknown): value is TaskStatus {
  return value === "TODO" || value === "IN_PROGRESS" || value === "WAIT_REVIEW" || value === "DONE";
}
function taskFields(data: Record<string, unknown>, partial = false): Partial<TaskFields> {
  const fail = () => {
    throw new HTTPException(400, { message: "タスクの入力を確認してください" });
  };
  if (
    !Object.keys(data).length ||
    Object.keys(data).some((key) => !["name", "memo", "reward", "deadline"].includes(key))
  )
    fail();
  const result: Partial<TaskFields> = {};
  if (!partial || "name" in data) {
    if (
      typeof data.name !== "string" ||
      !data.name.trim() ||
      data.name.includes("\u0000") ||
      Array.from(data.name.trim()).length > 100
    )
      return fail();
    result.name = data.name.trim();
  }
  if ("memo" in data) {
    if (
      data.memo !== null &&
      (typeof data.memo !== "string" ||
        data.memo.includes("\u0000") ||
        Array.from(data.memo).length > 2000)
    )
      return fail();
    result.memo = data.memo;
  }
  if (!partial || "reward" in data) {
    if (
      typeof data.reward !== "number" ||
      !Number.isInteger(data.reward) ||
      data.reward < 0 ||
      data.reward > 2147483647
    )
      return fail();
    result.reward = data.reward;
  }
  if (!partial || "deadline" in data) {
    if (
      typeof data.deadline !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
        data.deadline,
      ) ||
      !Number.isFinite(Date.parse(data.deadline))
    )
      return fail();
    const date = data.deadline.slice(0, 10);
    if (new Date(date).toISOString().slice(0, 10) !== date) return fail();
    result.deadline = new Date(data.deadline);
  }
  return result;
}
export function createApp(options: {
  repository: AuthRepository | (() => AuthRepository);
  jwtSecret: string;
  vapid?: VapidConfig;
}) {
  if (new TextEncoder().encode(options.jwtSecret).length < 32)
    throw new Error("JWT_SECRET must be at least 32 bytes");
  const vapid = validateVapidConfig(options.vapid ?? readVapidConfig());
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
  app.get("/api/push/public-key", (c) => c.json({ publicKey: vapid.publicKey }));
  app.put("/api/parents/push-subscription", auth, parentOnly, async (c) => {
    const data = await body(c.req.raw);
    let endpoint: URL | undefined;
    try {
      if (typeof data.endpoint === "string") endpoint = new URL(data.endpoint);
    } catch {
      /* Invalid URLs are rejected below. */
    }
    if (
      !endpoint ||
      endpoint.protocol !== "https:" ||
      endpoint.username ||
      endpoint.password ||
      typeof data.endpoint !== "string" ||
      /\s/.test(data.endpoint) ||
      !isRecord(data.keys) ||
      typeof data.keys.p256dh !== "string" ||
      !data.keys.p256dh.trim() ||
      typeof data.keys.auth !== "string" ||
      !data.keys.auth.trim()
    )
      throw new HTTPException(400, { message: "通知の購読情報を確認してください" });
    await repo().setPushSubscription(familyId(c.get("identity")), {
      endpoint: data.endpoint,
      keys: { p256dh: data.keys.p256dh, auth: data.keys.auth },
    });
    return c.json({ success: true });
  });
  app.delete("/api/parents/push-subscription", auth, parentOnly, async (c) => {
    await repo().setPushSubscription(familyId(c.get("identity")), null);
    return c.json({ success: true });
  });
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
  const ownedPayrollChild = async (parentId: string, id: string) => {
    if (!isUuid(id)) throw new HTTPException(400, { message: "子供IDが不正です" });
    const record = await repo().childById(id);
    if (!record || record.parent.id !== parentId)
      throw new HTTPException(404, { message: "子供が見つかりません" });
    return record.child;
  };
  app.get("/api/payroll", auth, parentOnly, async (c) => {
    const parentId = familyId(c.get("identity"));
    const month = c.req.query("month");
    const childId = c.req.query("childId");
    if (month !== undefined && !/^(?!0000)\d{4}-(?:0[1-9]|1[0-2])-01$/.test(month))
      throw new HTTPException(400, { message: "対象月が不正です" });
    if (childId !== undefined) await ownedPayrollChild(parentId, childId);
    return c.json({ payroll: await repo().listPayroll(parentId, month, childId) });
  });
  app.get("/api/children/:childId/payroll", auth, async (c) => {
    const identity = c.get("identity");
    const child = await ownedPayrollChild(familyId(identity), c.req.param("childId"));
    if (identity.role === "child" && identity.id.toLowerCase() !== child.id)
      throw new HTTPException(403, { message: "この操作は許可されていません" });
    return c.json({ payroll: await repo().listPayroll(familyId(identity), undefined, child.id) });
  });
  app.post("/api/tasks", auth, parentOnly, async (c) => {
    const fields = taskFields(await body(c.req.raw));
    if (fields.name === undefined || fields.reward === undefined || fields.deadline === undefined)
      throw new HTTPException(400, { message: "必須項目を入力してください" });
    return c.json(
      {
        task: await repo().createTask(familyId(c.get("identity")), {
          ...fields,
          name: fields.name,
          reward: fields.reward,
          deadline: fields.deadline,
        }),
      },
      201,
    );
  });
  app.get("/api/tasks", auth, async (c) => {
    const status = c.req.query("status");
    const childId = c.req.query("childId");
    if (status !== undefined && !taskStatus(status))
      throw new HTTPException(400, { message: "ステータスが不正です" });
    if (childId !== undefined && childId !== "null" && !isUuid(childId))
      throw new HTTPException(400, { message: "担当者が不正です" });
    return c.json({
      tasks: await repo().listTasks(
        familyId(c.get("identity")),
        status,
        childId === "null" ? null : childId,
      ),
    });
  });
  app.use("/api/tasks/:taskId/*", auth);
  app.use("/api/tasks/:taskId/*", async (c, next) => {
    if (!isUuid(c.req.param("taskId")))
      throw new HTTPException(400, { message: "タスクIDが不正です" });
    await next();
  });
  const ownedTask = async (parentId: string, id: string) => {
    if (!isUuid(id)) throw new HTTPException(400, { message: "タスクIDが不正です" });
    const task = await repo().taskById(parentId, id);
    if (!task) throw new HTTPException(404, { message: "タスクが見つかりません" });
    return task;
  };
  app.get("/api/tasks/:taskId", async (c) =>
    c.json({ task: await ownedTask(familyId(c.get("identity")), c.req.param("taskId")) }),
  );
  app.patch("/api/tasks/:taskId", parentOnly, async (c) => {
    const parentId = familyId(c.get("identity"));
    const id = c.req.param("taskId");
    await ownedTask(parentId, id);
    const task = await repo().editTask(parentId, id, taskFields(await body(c.req.raw), true));
    if (!task) throw new HTTPException(404, { message: "タスクが見つかりません" });
    return c.json({ task });
  });
  app.delete("/api/tasks/:taskId", parentOnly, async (c) => {
    const parentId = familyId(c.get("identity"));
    const id = c.req.param("taskId");
    await ownedTask(parentId, id);
    if (!(await repo().deleteTask(parentId, id)))
      throw new HTTPException(404, { message: "タスクが見つかりません" });
    return c.json({ success: true });
  });
  app.patch("/api/tasks/:taskId/status", async (c) => {
    const identity = c.get("identity");
    const parentId = familyId(identity);
    const id = c.req.param("taskId");
    const current = await ownedTask(parentId, id);
    const data = await body(c.req.raw);
    if (
      Object.keys(data).some((key) => key !== "status") ||
      !taskStatus(data.status) ||
      data.status === "TODO"
    )
      throw new HTTPException(400, { message: "ステータス変更が不正です" });
    const reopening =
      identity.role === "parent" && current.status === "DONE" && data.status === "WAIT_REVIEW";
    if (!reopening && (data.status === "DONE") !== (identity.role === "parent"))
      throw new HTTPException(403, { message: "この操作は許可されていません" });
    const task = await repo().transitionTask(
      parentId,
      id,
      data.status,
      identity.role === "child" ? identity.id : undefined,
    );
    if (!task)
      throw new HTTPException(409, {
        message: "タスクの状態または担当者が変わっています。一覧を更新してください",
      });
    if (identity.role === "child" && task.status === "WAIT_REVIEW")
      void notifyReview(repo(), vapid, parentId, task.name);
    return c.json({ task });
  });
  // Used by guards to validate expiration, identity, and family membership server-side.
  app.get("/api/session", auth, (c) => c.json({ identity: c.get("identity") }));
  return app;
}
