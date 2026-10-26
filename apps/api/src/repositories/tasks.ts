import { tasks } from "@ctrl-y/database";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { lockPayrollParent, recalculateTaskPayroll } from "./payroll.js";
import type { TaskFields, TaskStatus } from "./types.js";

export function createTasksRepository<
  T extends PgQueryResultHKT,
  S extends Record<string, unknown>,
>(db: PgDatabase<T, S>) {
  return {
    async createTask(parentId: string, fields: TaskFields) {
      return (
        await db
          .insert(tasks)
          .values({ ...fields, parentId })
          .returning()
      )[0];
    },
    async listTasks(parentId: string, status?: TaskStatus | TaskStatus[], childId?: string | null) {
      return db
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.parentId, parentId),
            status ? inArray(tasks.status, Array.isArray(status) ? status : [status]) : undefined,
            childId === null
              ? isNull(tasks.childId)
              : childId
                ? eq(tasks.childId, childId)
                : undefined,
          ),
        )
        .orderBy(tasks.createdAt, tasks.id);
    },
    async listTasksPage(
      parentId: string,
      status: TaskStatus | TaskStatus[] | undefined,
      childId: string | null | undefined,
      limit: number,
      cursor?: { time: string; id: string },
    ) {
      const done =
        status === "DONE" || (Array.isArray(status) && status.length === 1 && status[0] === "DONE");
      // Keep PostgreSQL timestamp precision in the cursor (Date truncates microseconds).
      const time = done
        ? sql`coalesce(${tasks.completedAt}, ${tasks.createdAt})`
        : sql`${tasks.createdAt}`;
      const rows = await db
        .select({
          task: tasks,
          time: sql<string>`to_char(${time} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        })
        .from(tasks)
        .where(
          and(
            eq(tasks.parentId, parentId),
            status ? inArray(tasks.status, Array.isArray(status) ? status : [status]) : undefined,
            childId === null
              ? isNull(tasks.childId)
              : childId
                ? eq(tasks.childId, childId)
                : undefined,
            cursor
              ? done
                ? sql`(${time}, ${tasks.id}) < (${cursor.time}::timestamptz, ${cursor.id}::uuid)`
                : sql`(${time}, ${tasks.id}) > (${cursor.time}::timestamptz, ${cursor.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(done ? desc(time) : asc(time), done ? desc(tasks.id) : asc(tasks.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        tasks: page.map((row) => row.task),
        next: rows.length > limit && last ? { time: last.time, id: last.task.id } : null,
      };
    },
    async taskById(parentId: string, id: string) {
      return (
        await db
          .select()
          .from(tasks)
          .where(and(eq(tasks.parentId, parentId), eq(tasks.id, id)))
      ).at(0);
    },
    async editTask(parentId: string, id: string, fields: Partial<TaskFields>) {
      return db.transaction(async (tx) => {
        await lockPayrollParent(tx, parentId);
        const [task] = await tx
          .update(tasks)
          .set(fields)
          .where(and(eq(tasks.parentId, parentId), eq(tasks.id, id)))
          .returning();
        if (fields.reward !== undefined) await recalculateTaskPayroll(tx, task);
        return task;
      });
    },
    async deleteTask(parentId: string, id: string) {
      return db.transaction(async (tx) => {
        await lockPayrollParent(tx, parentId);
        const [task] = await tx
          .delete(tasks)
          .where(and(eq(tasks.parentId, parentId), eq(tasks.id, id)))
          .returning();
        await recalculateTaskPayroll(tx, task);
        return task ? { id: task.id } : undefined;
      });
    },
    async transitionTask(
      parentId: string,
      id: string,
      status: Exclude<TaskStatus, "TODO">,
      childId?: string,
    ) {
      // Compare-and-set keeps claiming and all later transitions atomic across clients.
      const previous =
        status === "IN_PROGRESS"
          ? "TODO"
          : status === "WAIT_REVIEW"
            ? childId
              ? "IN_PROGRESS"
              : "DONE"
            : "WAIT_REVIEW";
      return db.transaction(async (tx) => {
        await lockPayrollParent(tx, parentId);
        const [oldTask] = await tx
          .select()
          .from(tasks)
          .where(and(eq(tasks.parentId, parentId), eq(tasks.id, id)))
          .for("update");
        const [task] = await tx
          .update(tasks)
          .set({
            status,
            ...(status === "IN_PROGRESS" ? { childId } : {}),
            completedAt: status === "DONE" ? new Date() : null,
          })
          .where(
            and(
              eq(tasks.parentId, parentId),
              eq(tasks.id, id),
              eq(tasks.status, previous),
              status === "IN_PROGRESS"
                ? isNull(tasks.childId)
                : status === "WAIT_REVIEW" && childId
                  ? eq(tasks.childId, childId)
                  : undefined,
            ),
          )
          .returning();
        if (task) {
          await recalculateTaskPayroll(tx, oldTask);
          await recalculateTaskPayroll(tx, task);
        }
        return task;
      });
    },
  };
}
