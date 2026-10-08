import { parents } from "@ctrl-y/database";
import { and, eq, gt } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

export function createParentsRepository<
  T extends PgQueryResultHKT,
  S extends Record<string, unknown>,
>(db: PgDatabase<T, S>) {
  return {
    async savePasswordReset(parentId: string, tokenHash: string, expiresAt: Date) {
      await db
        .update(parents)
        .set({ passwordResetHash: tokenHash, passwordResetExpiresAt: expiresAt })
        .where(eq(parents.id, parentId));
    },
    async resetPassword(parentId: string, tokenHash: string, passwordHash: string) {
      const rows = await db
        .update(parents)
        .set({ passwordHash, passwordResetHash: null, passwordResetExpiresAt: null })
        .where(
          and(
            eq(parents.id, parentId),
            eq(parents.passwordResetHash, tokenHash),
            gt(parents.passwordResetExpiresAt, new Date()),
          ),
        )
        .returning({ id: parents.id });
      return rows.length === 1;
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
  };
}
