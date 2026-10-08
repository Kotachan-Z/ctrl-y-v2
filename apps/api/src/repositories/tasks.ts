import { tasks } from "@ctrl-y/database";
import { and, eq, isNull } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { recalculateTaskPayroll } from "./payroll.js";
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
    async listTasks(parentId: string, status?: TaskStatus, childId?: string | null) {
      return db
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.parentId, parentId),
            status ? eq(tasks.status, status) : undefined,
            childId === null
              ? isNull(tasks.childId)
              : childId
                ? eq(tasks.childId, childId)
                : undefined,
          ),
        )
        .orderBy(tasks.createdAt, tasks.id);
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
