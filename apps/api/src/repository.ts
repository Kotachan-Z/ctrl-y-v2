import { children, parents, payroll, pushRetryQueue, refreshTokens, tasks } from "@ctrl-y/database";
import { and, count, eq, gt, gte, isNull, lt, lte, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import type { Identity } from "./auth.js";

export type PushSubscription = NonNullable<typeof parents.$inferSelect.pushSubscription>;
export type PayrollSettings = Pick<typeof parents.$inferSelect, "payDay" | "cutoffDay">;

export type TaskFields = Pick<typeof tasks.$inferInsert, "name" | "memo" | "reward" | "deadline">;
export type TaskStatus = typeof tasks.$inferSelect.status;

type Transaction = Pick<PgDatabase<PgQueryResultHKT>, "select" | "insert">;

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
export function createRepository<T extends PgQueryResultHKT, S extends Record<string, unknown>>(
  db: PgDatabase<T, S>,
) {
  return {
    async enqueuePushRetry(
      parentId: string,
      taskName: string,
      lastError: string,
      nextAttemptAt: Date,
    ) {
      await db.insert(pushRetryQueue).values({ parentId, taskName, lastError, nextAttemptAt });
    },
    async claimPushRetries(now: Date, limit = 25) {
      return db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(pushRetryQueue)
          .where(lte(pushRetryQueue.nextAttemptAt, now))
          .orderBy(pushRetryQueue.nextAttemptAt, pushRetryQueue.id)
          .limit(limit)
          .for("update", { skipLocked: true });
        const claimed = [];
        for (const row of rows) {
          const [job] = await tx
            .update(pushRetryQueue)
            .set({
              attempts: row.attempts + 1,
              // Recover abandoned work after a crash without holding locks during fetch.
              nextAttemptAt: new Date(now.getTime() + 10 * 60_000),
            })
            .where(eq(pushRetryQueue.id, row.id))
            .returning();
          claimed.push(job);
        }
        return claimed;
      });
    },
    async ownsPushRetry(id: string, attempts: number) {
      const rows = await db
        .select({ id: pushRetryQueue.id })
        .from(pushRetryQueue)
        .where(and(eq(pushRetryQueue.id, id), eq(pushRetryQueue.attempts, attempts)))
        .limit(1);
      return rows.length > 0;
    },
    async finishPushRetry(
      id: string,
      attempts: number,
      retry?: { nextAttemptAt: Date; lastError: string },
    ) {
      const owned = and(eq(pushRetryQueue.id, id), eq(pushRetryQueue.attempts, attempts));
      if (retry) await db.update(pushRetryQueue).set(retry).where(owned);
      else await db.delete(pushRetryQueue).where(owned);
    },
    async createRefreshToken(identity: Identity, refresh: { tokenHash: string; expiresAt: Date }) {
      const id = crypto.randomUUID();
      await db.insert(refreshTokens).values({
        id,
        rootId: id,
        role: identity.role,
        parentId: identity.role === "parent" ? identity.id : identity.parentId,
        childId: identity.role === "child" ? identity.id : null,
        tokenHash: refresh.tokenHash,
        expiresAt: refresh.expiresAt,
      });
    },
    async rotateRefreshToken(tokenHash: string, next: { tokenHash: string; expiresAt: Date }) {
      return db.transaction(async (tx): Promise<Identity | undefined> => {
        const [found] = await tx
          .select()
          .from(refreshTokens)
          .where(eq(refreshTokens.tokenHash, tokenHash));
        if (!found) return undefined;
        // Lock the stable root before re-reading: reuse, logout and descendant rotations
        // serialize across Workers/processes, not just within one JavaScript isolate.
        await tx
          .select()
          .from(refreshTokens)
          .where(eq(refreshTokens.id, found.rootId))
          .for("update");
        const [current] = await tx
          .select()
          .from(refreshTokens)
          .where(eq(refreshTokens.id, found.id));
        if (!current) return undefined;
        const now = new Date(Date.now());
        if (current.revokedAt) {
          await tx
            .update(refreshTokens)
            .set({ revokedAt: now })
            .where(and(eq(refreshTokens.rootId, current.rootId), isNull(refreshTokens.revokedAt)));
          return undefined;
        }
        if (current.expiresAt <= now) return undefined;
        await tx
          .update(refreshTokens)
          .set({ revokedAt: now })
          .where(eq(refreshTokens.id, current.id));
        await tx.insert(refreshTokens).values({
          id: crypto.randomUUID(),
          rootId: current.rootId,
          previousId: current.id,
          role: current.role,
          parentId: current.parentId,
          childId: current.childId,
          tokenHash: next.tokenHash,
          expiresAt: next.expiresAt,
        });
        return current.role === "parent"
          ? { role: "parent", id: current.parentId }
          : { role: "child", id: current.childId!, parentId: current.parentId };
      });
    },
    async revokeRefreshToken(tokenHash: string) {
      await db.transaction(async (tx) => {
        const [found] = await tx
          .select()
          .from(refreshTokens)
          .where(eq(refreshTokens.tokenHash, tokenHash));
        if (!found) return;
        await tx
          .select()
          .from(refreshTokens)
          .where(eq(refreshTokens.id, found.rootId))
          .for("update");
        await tx
          .update(refreshTokens)
          .set({ revokedAt: new Date(Date.now()) })
          .where(and(eq(refreshTokens.rootId, found.rootId), isNull(refreshTokens.revokedAt)));
      });
    },
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
    async savePasswordReset(parentId: string, tokenHash: string, expiresAt: Date) {
      await db
        .update(parents)
        .set({ passwordResetHash: tokenHash, passwordResetExpiresAt: expiresAt })
        .where(eq(parents.id, parentId));
    },
    async resetPassword(parentId: string, tokenHash: string, passwordHash: string) {
      const rows = await db
        .update(parents)
        .set({ passwordHash, passwordResetHash: null, passwordResetExpiresAt: null })
        .where(
          and(
            eq(parents.id, parentId),
            eq(parents.passwordResetHash, tokenHash),
            gt(parents.passwordResetExpiresAt, new Date()),
          ),
        )
        .returning({ id: parents.id });
      return rows.length === 1;
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
    async getPayrollSettings(parentId: string) {
      return (
        await db
          .select({ payDay: parents.payDay, cutoffDay: parents.cutoffDay })
          .from(parents)
          .where(eq(parents.id, parentId))
      ).at(0);
    },
    async updatePayrollSettings(parentId: string, fields: Partial<PayrollSettings>) {
      return (
        await db
          .update(parents)
          .set(fields)
          .where(eq(parents.id, parentId))
          .returning({ payDay: parents.payDay, cutoffDay: parents.cutoffDay })
      ).at(0);
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
