import { readFile } from "node:fs/promises";

import { children, parents, payroll, tasks } from "@ctrl-y/database";
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";

import { testApp } from "./helpers.js";

test("data migration replaces UTC totals with JST cutoff totals and is idempotent", async () => {
  const fixture = await testApp();
  try {
    const [parent] = await fixture.db
      .insert(parents)
      .values({ email: "migration@example.test", passwordHash: "unused", cutoffDay: true })
      .returning();
    const [child] = await fixture.db
      .insert(children)
      .values({ parentId: parent.id, name: "子" })
      .returning();
    await fixture.db.insert(tasks).values([
      {
        parentId: parent.id,
        childId: child.id,
        name: "境界",
        reward: 100,
        deadline: new Date(),
        status: "DONE",
        completedAt: new Date("2024-12-15T15:00:00Z"),
      },
      {
        parentId: parent.id,
        childId: child.id,
        name: "対象外",
        reward: 999,
        deadline: new Date(),
        status: "WAIT_REVIEW",
        completedAt: new Date("2024-12-15T15:00:00Z"),
      },
    ]);
    const [old] = await fixture.db
      .insert(payroll)
      .values({ childId: child.id, month: "2024-12-01", completedTaskCount: 1, totalReward: 100 })
      .returning();
    const migration = await readFile(
      new URL(
        "../../../packages/database/migrations/20261026024604_payroll_jst_cutoff.sql",
        import.meta.url,
      ),
      "utf8",
    );
    for (let i = 0; i < 2; i++) {
      await fixture.client.exec(migration);
      expect(await fixture.repository.listPayroll(parent.id)).toMatchObject([
        { id: old.id, month: "2024-12-01", completedTaskCount: 0, totalReward: 0 },
        { month: "2025-01-01", completedTaskCount: 1, totalReward: 100 },
      ]);
    }
    // An old Worker can overwrite a migrated month before the deployment switches Workers.
    await fixture.db
      .update(payroll)
      .set({ completedTaskCount: 1, totalReward: 100 })
      .where(eq(payroll.id, old.id));
    await fixture.client.exec(migration);
    expect(await fixture.repository.listPayroll(parent.id)).toMatchObject([
      { id: old.id, month: "2024-12-01", completedTaskCount: 0, totalReward: 0 },
      { month: "2025-01-01", completedTaskCount: 1, totalReward: 100 },
    ]);
    await fixture.repository.updatePayrollSettings(parent.id, { cutoffDay: false });
    await fixture.db.insert(tasks).values({
      parentId: parent.id,
      childId: child.id,
      name: "JST月初",
      reward: 200,
      deadline: new Date(),
      status: "DONE",
      completedAt: new Date("2024-12-31T15:00:00Z"),
    });
    await fixture.client.exec(migration);
    expect(await fixture.repository.listPayroll(parent.id)).toMatchObject([
      { month: "2024-12-01", completedTaskCount: 1, totalReward: 100 },
      { month: "2025-01-01", completedTaskCount: 1, totalReward: 200 },
    ]);
  } finally {
    await fixture.client.close();
  }
}, 30000);
