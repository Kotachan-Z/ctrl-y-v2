import type { parents, tasks } from "@ctrl-y/database";

export type PushSubscription = NonNullable<typeof parents.$inferSelect.pushSubscription>;
export type PayrollSettings = Pick<typeof parents.$inferSelect, "payDay" | "cutoffDay">;

export type TaskFields = Pick<typeof tasks.$inferInsert, "name" | "memo" | "reward" | "deadline">;
export type TaskStatus = typeof tasks.$inferSelect.status;
