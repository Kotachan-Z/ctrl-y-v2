import { children, parents, payroll, tasks } from "@ctrl-y/database";
import { and, count, eq, gte, lt, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import type { PayrollSettings } from "./types.js";

type Transaction = Pick<PgDatabase<PgQueryResultHKT>, "select" | "insert">;

const JST_OFFSET = 9 * 60 * 60 * 1000;

export function payrollMonth(completedAt: Date, cutoffDay: boolean) {
  const date = new Date(completedAt.getTime() + JST_OFFSET);
  const nextMonth = cutoffDay && date.getUTCDate() > 15;
  date.setUTCDate(1);
  if (nextMonth) date.setUTCMonth(date.getUTCMonth() + 1);
  return `${date.toISOString().slice(0, 7)}-01`;
}

export async function lockPayrollParent(tx: Transaction, parentId: string) {
  return (await tx.select().from(parents).where(eq(parents.id, parentId)).for("no key update"))[0];
}

async function childCutoff(tx: Transaction, childId: string) {
  const [child] = await tx.select().from(children).where(eq(children.id, childId));
  if (!child) throw new Error("子供が見つかりません");
  return (await lockPayrollParent(tx, child.parentId)).cutoffDay;
}

async function recalculatePayroll(
  tx: Transaction,
  childId: string,
  month: string,
  cutoffDay: boolean,
) {
  const date = new Date(`${month}T00:00:00.000Z`);
  if (!/^(?!0000)\d{4}-(?:0[1-9]|1[0-2])-01$/.test(month) || !Number.isFinite(date.getTime()))
    throw new Error("給与の対象月が不正です");
  if (cutoffDay) {
    date.setUTCMonth(date.getUTCMonth() - 1);
    date.setUTCDate(16);
  }
  const start = new Date(date.getTime() - JST_OFFSET);
  date.setUTCMonth(date.getUTCMonth() + 1);
  const end = new Date(date.getTime() - JST_OFFSET);
  // Always lock the parent before the child, including task mutations.
  await tx.select().from(children).where(eq(children.id, childId)).for("no key update");
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
  if (task?.status === "DONE" && task.childId && task.completedAt) {
    const cutoffDay = await childCutoff(tx, task.childId);
    await recalculatePayroll(
      tx,
      task.childId,
      payrollMonth(task.completedAt, cutoffDay),
      cutoffDay,
    );
  }
}

export function createPayrollRepository<
  T extends PgQueryResultHKT,
  S extends Record<string, unknown>,
>(db: PgDatabase<T, S>) {
  return {
    async recalculatePayroll(childId: string, month: string) {
      return db.transaction(async (tx) => {
        const cutoffDay = await childCutoff(tx, childId);
        return recalculatePayroll(tx, childId, month, cutoffDay);
      });
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
      return db.transaction(async (tx) => {
        const parent = await lockPayrollParent(tx, parentId);
        if (!parent) return undefined;
        const [settings] = await tx
          .update(parents)
          .set(fields)
          .where(eq(parents.id, parentId))
          .returning({ payDay: parents.payDay, cutoffDay: parents.cutoffDay });
        if (settings.cutoffDay !== parent.cutoffDay) {
          const family = await tx
            .select()
            .from(children)
            .where(eq(children.parentId, parentId))
            .orderBy(children.id)
            .for("no key update");
          for (const child of family) {
            const oldRows = await tx
              .select({ month: payroll.month })
              .from(payroll)
              .where(eq(payroll.childId, child.id));
            const completed = await tx
              .select({ completedAt: tasks.completedAt })
              .from(tasks)
              .where(and(eq(tasks.childId, child.id), eq(tasks.status, "DONE")));
            const months = new Set(oldRows.map((row) => row.month));
            for (const task of completed) {
              if (task.completedAt) months.add(payrollMonth(task.completedAt, settings.cutoffDay));
            }
            for (const month of months)
              await recalculatePayroll(tx, child.id, month, settings.cutoffDay);
          }
        }
        return settings;
      });
    },
  };
}
