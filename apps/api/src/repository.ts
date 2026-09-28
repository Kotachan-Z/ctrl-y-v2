import { children, parents, payroll, tasks } from "@ctrl-y/database";
import { and, count, eq, gte, isNull, lt, sql } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";

export type PushSubscription = NonNullable<typeof parents.$inferSelect.pushSubscription>;

export type TaskFields = Pick<typeof tasks.$inferInsert, "name" | "memo" | "reward" | "deadline">;
export type TaskStatus = typeof tasks.$inferSelect.status;

type Transaction = Parameters<Parameters<PgliteDatabase["transaction"]>[0]>[0];

async function recalculatePayroll(tx: Transaction, childId: string, month: string) {
  const start = new Date(`${month}T00:00:00.000Z`);
  if (!/^(?!0000)\d{4}-(?:0[1-9]|1[0-2])-01$/.test(month) || !Number.isFinite(start.getTime()))
    throw new Error("Invalid payroll month");
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  // Serialize aggregates even when this child's payroll row does not exist yet.
  await tx.select().from(children).where(eq(children.id, childId)).for("update");
  const [totals] = await tx
    .select({
      completedTaskCount: count(),
      totalReward: sql<number>`coalesce(sum(${tasks.reward}), 0)`.mapWith(Number),
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.childId, childId),
        eq(tasks.status, "DONE"),
        gte(tasks.completedAt, start),
        lt(tasks.completedAt, end),
      ),
    );
  return (
    await tx
      .insert(payroll)
      .values({ childId, month, ...totals })
      .onConflictDoUpdate({ target: [payroll.childId, payroll.month], set: totals })
      .returning()
  )[0];
}

async function recalculateTaskPayroll(
  tx: Transaction,
  task: typeof tasks.$inferSelect | undefined,
) {
  if (task?.status === "DONE" && task.childId && task.completedAt)
    await recalculatePayroll(tx, task.childId, `${task.completedAt.toISOString().slice(0, 7)}-01`);
}

// Routes depend on this repository, not a connection driver. A Postgres adapter
// can replace this implementation without changing authentication or routes.
export function createRepository(db: PgliteDatabase) {
  return {
    async recalculatePayroll(childId: string, month: string) {
      return db.transaction((tx) => recalculatePayroll(tx, childId, month));
    },
    async listPayroll(parentId: string, month?: string, childId?: string) {
      const rows = await db
        .select({ payroll })
        .from(payroll)
        .innerJoin(children, eq(payroll.childId, children.id))
        .where(
          and(
            eq(children.parentId, parentId),
            month ? eq(payroll.month, month) : undefined,
            childId ? eq(payroll.childId, childId) : undefined,
          ),
        )
        .orderBy(payroll.month, payroll.childId);
      return rows.map((row) => row.payroll);
    },
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
    async register(email: string, passwordHash: string) {
      const result = await db
        .insert(parents)
        .values({ email, passwordHash })
        .onConflictDoNothing({ target: parents.email })
        .returning();
      return result.at(0);
    },
    async setPushSubscription(parentId: string, subscription: PushSubscription | null) {
      await db
        .update(parents)
        .set({ pushSubscription: subscription })
        .where(eq(parents.id, parentId));
    },
    async clearPushSubscriptionIfUnchanged(parentId: string, subscription: PushSubscription) {
      // A delayed provider rejection must not erase a newer browser subscription.
      await db
        .update(parents)
        .set({ pushSubscription: null })
        .where(and(eq(parents.id, parentId), eq(parents.pushSubscription, subscription)));
    },
    async parentByEmail(email: string) {
      return (await db.select().from(parents).where(eq(parents.email, email))).at(0);
    },
    async parentById(id: string) {
      return (await db.select().from(parents).where(eq(parents.id, id))).at(0);
    },
    async childById(id: string) {
      return (
        await db
          .select({ child: children, parent: parents })
          .from(children)
          .innerJoin(parents, eq(children.parentId, parents.id))
          .where(eq(children.id, id))
      ).at(0);
    },
    async listChildren(parentId: string) {
      return db
        .select({ id: children.id, name: children.name })
        .from(children)
        .where(eq(children.parentId, parentId))
        .orderBy(children.createdAt, children.id);
    },
    async addChild(parentId: string, name: string, keywordHash?: string) {
      return db.transaction(async (tx) => {
        // Serializes setup and additions for the same family, including on Postgres.
        const [parent] = await tx
          .select()
          .from(parents)
          .where(eq(parents.id, parentId))
          .for("update");
        if (!parent) return undefined;
        const existing = await tx
          .select({ id: children.id })
          .from(children)
          .where(eq(children.parentId, parentId))
          .limit(1);
        if (keywordHash !== undefined) {
          if (existing.length) return undefined;
          await tx.update(parents).set({ keyword: keywordHash }).where(eq(parents.id, parentId));
        } else if (!existing.length || !parent.keyword) return undefined;
        const [child] = await tx
          .insert(children)
          .values({ parentId, name })
          .returning({ id: children.id, name: children.name });
        return child;
      });
    },
  };
}
export type AuthRepository = ReturnType<typeof createRepository>;
