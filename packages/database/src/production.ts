import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema.js";

export function createProductionDatabase(hyperdrive: { connectionString: string }) {
  // Stay below Workers' limit of six concurrent external connections.
  const sql = postgres(hyperdrive.connectionString, { max: 5 });
  return { sql, db: drizzle(sql, { schema, casing: "snake_case" }) };
}
