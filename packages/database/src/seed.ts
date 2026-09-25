import { hash } from "bcryptjs";

import { createLocalDatabase } from "./local";
import { parents, children, tasks } from "./schema";
const { client, db } = createLocalDatabase();
export const sampleIds = {
  parent: "00000000-0000-4000-8000-000000000001",
  child: "00000000-0000-4000-8000-000000000002",
  task: "00000000-0000-4000-8000-000000000003",
};
try {
  const passwordHash = await hash("local-password", 12);
  const keyword = await hash("ひみつのことば", 12);
  await db.transaction(async (tx) => {
    await tx
      .insert(parents)
      .values({ id: sampleIds.parent, email: "parent@example.test", passwordHash, keyword })
      .onConflictDoNothing();
    await tx
      .insert(children)
      .values({ id: sampleIds.child, parentId: sampleIds.parent, name: "サンプルの子供" })
      .onConflictDoNothing();
    await tx
      .insert(tasks)
      .values({
        id: sampleIds.task,
        parentId: sampleIds.parent,
        childId: sampleIds.child,
        name: "お片付け",
        reward: 100,
        deadline: new Date("2026-10-01T00:00:00Z"),
      })
      .onConflictDoNothing();
  });
} finally {
  await client.close();
}
