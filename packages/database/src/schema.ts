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
