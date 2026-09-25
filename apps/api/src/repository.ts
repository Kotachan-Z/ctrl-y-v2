import { children, parents, tasks } from "@ctrl-y/database";
import { and, eq, isNull } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";

export type TaskFields = Pick<typeof tasks.$inferInsert, "name" | "memo" | "reward" | "deadline">;
export type TaskStatus = typeof tasks.$inferSelect.status;

// Routes depend on this repository, not a connection driver. A Postgres adapter
// can replace this implementation without changing authentication or routes.
export function createRepository(db: PgliteDatabase) {
  return {
    async createTask(parentId: string, fields: TaskFields) {
      return (
        await db
          .insert(tasks)
          .values({ ...fields, parentId })
          .returning()
      )[0];
    },
    async listTasks(parentId: string, status?: TaskStatus, childId?: string | null) {
      return db
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.parentId, parentId),
            status ? eq(tasks.status, status) : undefined,
            childId === null
              ? isNull(tasks.childId)
              : childId
                ? eq(tasks.childId, childId)
                : undefined,
          ),
        )
        .orderBy(tasks.createdAt, tasks.id);
    },
    async taskById(parentId: string, id: string) {
      return (
        await db
          .select()
          .from(tasks)
          .where(and(eq(tasks.parentId, parentId), eq(tasks.id, id)))
      ).at(0);
    },
    async editTask(parentId: string, id: string, fields: Partial<TaskFields>) {
      return (
        await db
          .update(tasks)
          .set(fields)
          .where(and(eq(tasks.parentId, parentId), eq(tasks.id, id)))
          .returning()
      ).at(0);
    },
    async deleteTask(parentId: string, id: string) {
      return (
        await db
          .delete(tasks)
          .where(and(eq(tasks.parentId, parentId), eq(tasks.id, id)))
          .returning({ id: tasks.id })
      ).at(0);
    },
    async transitionTask(
      parentId: string,
      id: string,
      status: Exclude<TaskStatus, "TODO">,
      childId?: string,
    ) {
      // Compare-and-set keeps claiming and all later transitions atomic across clients.
      const previous =
        status === "IN_PROGRESS"
          ? "TODO"
          : status === "WAIT_REVIEW"
            ? "IN_PROGRESS"
            : "WAIT_REVIEW";
      return (
        await db
          .update(tasks)
          .set({
            status,
            ...(status === "IN_PROGRESS" ? { childId } : {}),
            ...(status === "DONE" ? { completedAt: new Date() } : {}),
          })
          .where(
            and(
              eq(tasks.parentId, parentId),
              eq(tasks.id, id),
              eq(tasks.status, previous),
              status === "IN_PROGRESS"
                ? isNull(tasks.childId)
                : status === "WAIT_REVIEW" && childId
                  ? eq(tasks.childId, childId)
                  : undefined,
            ),
          )
          .returning()
      ).at(0);
    },
    async register(email: string, passwordHash: string) {
      const result = await db
        .insert(parents)
        .values({ email, passwordHash })
        .onConflictDoNothing({ target: parents.email })
        .returning();
      return result.at(0);
    },
    async parentByEmail(email: string) {
      return (await db.select().from(parents).where(eq(parents.email, email))).at(0);
    },
    async parentById(id: string) {
      return (await db.select().from(parents).where(eq(parents.id, id))).at(0);
    },
    async childById(id: string) {
      return (
        await db
          .select({ child: children, parent: parents })
          .from(children)
          .innerJoin(parents, eq(children.parentId, parents.id))
          .where(eq(children.id, id))
      ).at(0);
    },
    async listChildren(parentId: string) {
      return db
        .select({ id: children.id, name: children.name })
        .from(children)
        .where(eq(children.parentId, parentId))
        .orderBy(children.createdAt, children.id);
    },
    async addChild(parentId: string, name: string, keywordHash?: string) {
      return db.transaction(async (tx) => {
        // Serializes setup and additions for the same family, including on Postgres.
        const [parent] = await tx
          .select()
          .from(parents)
          .where(eq(parents.id, parentId))
          .for("update");
        if (!parent) return undefined;
        const existing = await tx
          .select({ id: children.id })
          .from(children)
          .where(eq(children.parentId, parentId))
          .limit(1);
        if (keywordHash !== undefined) {
          if (existing.length) return undefined;
          await tx.update(parents).set({ keyword: keywordHash }).where(eq(parents.id, parentId));
        } else if (!existing.length || !parent.keyword) return undefined;
        const [child] = await tx
          .insert(children)
          .values({ parentId, name })
          .returning({ id: children.id, name: children.name });
        return child;
      });
    },
  };
}
export type AuthRepository = ReturnType<typeof createRepository>;
