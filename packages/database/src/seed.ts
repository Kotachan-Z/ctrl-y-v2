import { client, db } from "./local";
import { users } from "./schema";
try {
  await db
    .insert(users)
    .values({ id: "00000000-0000-4000-8000-000000000001", name: "Local scaffold user" })
    .onConflictDoNothing();
} finally {
  await client.close();
}
