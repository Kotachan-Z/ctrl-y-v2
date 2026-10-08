import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { createChildrenRepository } from "./children.js";
import { createParentsRepository } from "./parents.js";
import { createPayrollRepository } from "./payroll.js";
import { createPushRepository } from "./push.js";
import { createRefreshTokensRepository } from "./refresh-tokens.js";
import { createTasksRepository } from "./tasks.js";
export type { PushSubscription, PayrollSettings, TaskFields, TaskStatus } from "./types.js";

// Routes depend on this repository, not a connection driver. A Postgres adapter
// can replace this implementation without changing authentication or routes.
export function createRepository<T extends PgQueryResultHKT, S extends Record<string, unknown>>(
  db: PgDatabase<T, S>,
) {
  return {
    ...createPushRepository(db),
    ...createRefreshTokensRepository(db),
    ...createPayrollRepository(db),
    ...createTasksRepository(db),
    ...createParentsRepository(db),
    ...createChildrenRepository(db),
  };
}
export type AuthRepository = ReturnType<typeof createRepository>;
