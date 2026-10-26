import type { parents, tasks } from "@ctrl-y/database";

export type PushSubscription = { endpoint: string; keys: { p256dh: string; auth: string } };
export type PayrollSettings = Pick<typeof parents.$inferSelect, "payDay" | "cutoffDay">;

export type TaskFields = Pick<typeof tasks.$inferInsert, "name" | "memo" | "reward" | "deadline">;
export type TaskStatus = typeof tasks.$inferSelect.status;
