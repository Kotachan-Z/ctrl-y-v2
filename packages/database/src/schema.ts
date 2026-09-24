import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
// Infrastructure placeholder only; not the application user/auth model.
export const users = pgTable("users", {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
