import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { sign, verify } from "hono/jwt";

import type { AuthEnv } from "../auth.js";
import { familyId, isUuid, parentOnly } from "../auth.js";
import { body } from "../lib/request.js";
import { taskFields, taskStatus } from "../lib/validation.js";
import { notifyReview } from "../push.js";
import type { RouteDeps } from "./types.js";

export function registerTaskRoutes(app: Hono<AuthEnv>, deps: RouteDeps): void {
  const { repo, auth, vapid, backgroundTask } = deps;
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
    const statuses = status?.split(",");
    if (
      statuses !== undefined &&
      (!statuses.every(taskStatus) || new Set(statuses).size !== statuses.length)
    )
      throw new HTTPException(400, { message: "ステータスが不正です" });
    if (childId !== undefined && childId !== "null" && !isUuid(childId))
      throw new HTTPException(400, { message: "担当者が不正です" });
    const limit = c.req.query("limit");
    const cursor = c.req.query("cursor");
    const parentId = familyId(c.get("identity"));
    const assigned = childId === "null" ? null : childId;
    if (limit !== undefined && (!/^[1-9]\d*$/.test(limit) || Number(limit) > 100))
      throw new HTTPException(400, { message: "取得件数は1〜100の整数で指定してください" });
    let position: { time: string; id: string } | undefined;
    if (cursor !== undefined) {
      try {
        if (limit === undefined || cursor.length > 2048) throw new Error();
        const payload = await verify(cursor, deps.jwtSecret, "HS256");
        if (
          payload.purpose !== "task-page" ||
          payload.parentId !== parentId ||
          payload.status !== (status ?? null) ||
          payload.childId !== (assigned === undefined ? "all" : assigned) ||
          typeof payload.time !== "string" ||
          !Number.isFinite(Date.parse(payload.time)) ||
          typeof payload.id !== "string" ||
          !isUuid(payload.id)
        )
          throw new Error();
        position = { time: payload.time, id: payload.id };
      } catch {
        throw new HTTPException(400, { message: "カーソルが不正です" });
      }
    }
    if (limit !== undefined) {
      const page = await repo().listTasksPage(
        parentId,
        statuses,
        assigned,
        Number(limit),
        position,
      );
      return c.json({
        tasks: page.tasks,
        nextCursor: page.next
          ? await sign(
              {
                purpose: "task-page",
                parentId,
                status: status ?? null,
                childId: assigned === undefined ? "all" : assigned,
                ...page.next,
              },
              deps.jwtSecret,
              "HS256",
            )
          : null,
      });
    }
    return c.json({
      tasks: await repo().listTasks(
        familyId(c.get("identity")),
        statuses,
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
    if (identity.role === "child" && task.status === "WAIT_REVIEW") {
      const notification = notifyReview(repo(), vapid, parentId, task.name);
      backgroundTask?.(notification);
    }
    return c.json({ task });
  });
}
