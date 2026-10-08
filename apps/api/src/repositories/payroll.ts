import { children, parents, payroll, tasks } from "@ctrl-y/database";
import { and, count, eq, gte, lt, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import type { PayrollSettings } from "./types.js";

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

export async function recalculateTaskPayroll(
  tx: Transaction,
  task: typeof tasks.$inferSelect | undefined,
) {
  if (task?.status === "DONE" && task.childId && task.completedAt)
    await recalculatePayroll(tx, task.childId, `${task.completedAt.toISOString().slice(0, 7)}-01`);
}

export function createPayrollRepository<
  T extends PgQueryResultHKT,
  S extends Record<string, unknown>,
>(db: PgDatabase<T, S>) {
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
  };
}
