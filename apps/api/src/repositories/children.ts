import { children, parents } from "@ctrl-y/database";
import { eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

export function createChildrenRepository<
  T extends PgQueryResultHKT,
  S extends Record<string, unknown>,
>(db: PgDatabase<T, S>) {
  return {
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
