import { fileURLToPath } from "node:url";

import { createLocalDatabase } from "@ctrl-y/database/local";
import { migrate } from "drizzle-orm/pglite/migrator";

import { createRepository } from "../src/repository.js";
import { createApp } from "../src/server.js";
export const secret = "test-only-secret-at-least-32-bytes-long";
export async function testApp() {
  const { client, db } = createLocalDatabase("memory://");
  await migrate(db, {
    migrationsFolder: fileURLToPath(
      new URL("../../../packages/database/migrations", import.meta.url),
    ),
  });
  const repository = createRepository(db);
  return { client, db, repository, app: createApp({ repository, jwtSecret: secret }) };
}
