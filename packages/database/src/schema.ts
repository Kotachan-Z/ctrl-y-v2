import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
export const parents = pgTable("parents", {
  id: uuid().primaryKey().defaultRandom(),
  email: text().notNull().unique(),
  passwordHash: text().notNull(),
  passwordResetHash: text(),
  passwordResetExpiresAt: timestamp({ withTimezone: true }),
  // Empty until setup; thereafter bcrypt hash of the shared passphrase.
  keyword: text().notNull().default(""),
  cutoffDay: boolean().notNull().default(false),
  payDay: boolean().notNull().default(false),
  pushSubscription: jsonb().$type<{ endpoint: string; keys: { p256dh: string; auth: string } }>(),
  createdAt: createdAt(),
});
export const children = pgTable(
  "children",
  {
    id: uuid().primaryKey().defaultRandom(),
    parentId: uuid()
      .notNull()
      .references(() => parents.id, { onDelete: "cascade" }),
    name: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("children_parent_idx").on(t.parentId),
    unique("children_id_parent_unique").on(t.id, t.parentId),
  ],
);
export const taskStatus = pgEnum("task_status", ["TODO", "IN_PROGRESS", "WAIT_REVIEW", "DONE"]);
export const tasks = pgTable(
  "tasks",
  {
    id: uuid().primaryKey().defaultRandom(),
    parentId: uuid()
      .notNull()
      .references(() => parents.id, { onDelete: "cascade" }),
    childId: uuid(),
    name: text().notNull(),
    memo: text(),
    reward: integer().notNull(),
    deadline: timestamp({ withTimezone: true }).notNull(),
    status: taskStatus().notNull().default("TODO"),
    completedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("tasks_parent_idx").on(t.parentId),
    index("tasks_child_idx").on(t.childId),
    foreignKey({
      columns: [t.childId, t.parentId],
      foreignColumns: [children.id, children.parentId],
    }),
    check("tasks_reward_nonnegative", sql`${t.reward} >= 0`),
    check("tasks_reward_max", sql`${t.reward} <= 1000000`),
  ],
);
export const payroll = pgTable(
  "payroll",
  {
    id: uuid().primaryKey().defaultRandom(),
    childId: uuid()
      .notNull()
      .references(() => children.id, { onDelete: "cascade" }),
    // First day of the target month (YYYY-MM-01).
    month: date().notNull(),
    completedTaskCount: integer().notNull().default(0),
    totalReward: integer().notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    unique("payroll_child_month_unique").on(t.childId, t.month),
    check("payroll_month_start", sql`extract(day from ${t.month}) = 1`),
    check("payroll_nonnegative", sql`${t.completedTaskCount} >= 0 and ${t.totalReward} >= 0`),
  ],
);

export const pushRetryQueue = pgTable(
  "push_retry_queue",
  {
    id: uuid().primaryKey().defaultRandom(),
    parentId: uuid()
      .notNull()
      .references(() => parents.id, { onDelete: "cascade" }),
    taskName: text().notNull(),
    attempts: integer().notNull().default(0),
    nextAttemptAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: createdAt(),
    lastError: text().notNull(),
  },
  (t) => [
    index("push_retry_due_idx").on(t.nextAttemptAt, t.id),
    index("push_retry_parent_idx").on(t.parentId),
    check("push_retry_attempts_nonnegative", sql`${t.attempts} >= 0`),
  ],
);

// parentId is the family for both roles; a child session must belong to that family.
export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: uuid().primaryKey(),
    role: text().$type<"parent" | "child">().notNull(),
    parentId: uuid()
      .notNull()
      .references(() => parents.id, { onDelete: "cascade" }),
    childId: uuid(),
    tokenHash: text().notNull().unique(),
    createdAt: createdAt(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    revokedAt: timestamp({ withTimezone: true }),
    // The initial row points to itself and is the lock shared by every rotation.
    rootId: uuid().notNull(),
    previousId: uuid().unique(),
  },
  (t) => [
    index("refresh_tokens_root_idx").on(t.rootId),
    index("refresh_tokens_parent_idx").on(t.parentId),
    index("refresh_tokens_child_idx").on(t.childId),
    foreignKey({
      columns: [t.childId, t.parentId],
      foreignColumns: [children.id, children.parentId],
    }).onDelete("cascade"),
    foreignKey({ columns: [t.rootId], foreignColumns: [t.id] }).onDelete("cascade"),
    foreignKey({ columns: [t.previousId], foreignColumns: [t.id] }).onDelete("cascade"),
    check(
      "refresh_tokens_role_owner",
      sql`(${t.role} = 'parent' and ${t.childId} is null) or (${t.role} = 'child' and ${t.childId} is not null)`,
    ),
  ],
);
