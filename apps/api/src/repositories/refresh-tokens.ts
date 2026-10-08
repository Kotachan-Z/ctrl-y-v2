import { refreshTokens } from "@ctrl-y/database";
import { and, eq, isNull } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import type { Identity } from "../auth.js";

export function createRefreshTokensRepository<
  T extends PgQueryResultHKT,
  S extends Record<string, unknown>,
>(db: PgDatabase<T, S>) {
  return {
    async createRefreshToken(identity: Identity, refresh: { tokenHash: string; expiresAt: Date }) {
      const id = crypto.randomUUID();
      await db.insert(refreshTokens).values({
        id,
        rootId: id,
        role: identity.role,
        parentId: identity.role === "parent" ? identity.id : identity.parentId,
        childId: identity.role === "child" ? identity.id : null,
        tokenHash: refresh.tokenHash,
        expiresAt: refresh.expiresAt,
      });
    },
    async rotateRefreshToken(tokenHash: string, next: { tokenHash: string; expiresAt: Date }) {
      return db.transaction(async (tx): Promise<Identity | undefined> => {
        const [found] = await tx
          .select()
          .from(refreshTokens)
          .where(eq(refreshTokens.tokenHash, tokenHash));
        if (!found) return undefined;
        // Lock the stable root before re-reading: reuse, logout and descendant rotations
        // serialize across Workers/processes, not just within one JavaScript isolate.
        await tx
          .select()
          .from(refreshTokens)
          .where(eq(refreshTokens.id, found.rootId))
          .for("update");
        const [current] = await tx
          .select()
          .from(refreshTokens)
          .where(eq(refreshTokens.id, found.id));
        if (!current) return undefined;
        const now = new Date(Date.now());
        if (current.revokedAt) {
          await tx
            .update(refreshTokens)
            .set({ revokedAt: now })
            .where(and(eq(refreshTokens.rootId, current.rootId), isNull(refreshTokens.revokedAt)));
          return undefined;
        }
        if (current.expiresAt <= now) return undefined;
        await tx
          .update(refreshTokens)
          .set({ revokedAt: now })
          .where(eq(refreshTokens.id, current.id));
        await tx.insert(refreshTokens).values({
          id: crypto.randomUUID(),
          rootId: current.rootId,
          previousId: current.id,
          role: current.role,
          parentId: current.parentId,
          childId: current.childId,
          tokenHash: next.tokenHash,
          expiresAt: next.expiresAt,
        });
        return current.role === "parent"
          ? { role: "parent", id: current.parentId }
          : { role: "child", id: current.childId!, parentId: current.parentId };
      });
    },
    async revokeRefreshToken(tokenHash: string) {
      await db.transaction(async (tx) => {
        const [found] = await tx
          .select()
          .from(refreshTokens)
          .where(eq(refreshTokens.tokenHash, tokenHash));
        if (!found) return;
        await tx
          .select()
          .from(refreshTokens)
          .where(eq(refreshTokens.id, found.rootId))
          .for("update");
        await tx
          .update(refreshTokens)
          .set({ revokedAt: new Date(Date.now()) })
          .where(and(eq(refreshTokens.rootId, found.rootId), isNull(refreshTokens.revokedAt)));
      });
    },
  };
}
