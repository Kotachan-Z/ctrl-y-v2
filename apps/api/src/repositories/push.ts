import { parents, pushRetryQueue } from "@ctrl-y/database";
import { and, eq, lte } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import type { PushSubscription } from "./types.js";

export function createPushRepository<T extends PgQueryResultHKT, S extends Record<string, unknown>>(
  db: PgDatabase<T, S>,
) {
  return {
    async enqueuePushRetry(
      parentId: string,
      taskName: string,
      lastError: string,
      nextAttemptAt: Date,
    ) {
      await db.insert(pushRetryQueue).values({ parentId, taskName, lastError, nextAttemptAt });
    },
    async claimPushRetries(now: Date, limit = 25) {
      return db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(pushRetryQueue)
          .where(lte(pushRetryQueue.nextAttemptAt, now))
          .orderBy(pushRetryQueue.nextAttemptAt, pushRetryQueue.id)
          .limit(limit)
          .for("update", { skipLocked: true });
        const claimed = [];
        for (const row of rows) {
          const [job] = await tx
            .update(pushRetryQueue)
            .set({
              attempts: row.attempts + 1,
              // Recover abandoned work after a crash without holding locks during fetch.
              nextAttemptAt: new Date(now.getTime() + 10 * 60_000),
            })
            .where(eq(pushRetryQueue.id, row.id))
            .returning();
          claimed.push(job);
        }
        return claimed;
      });
    },
    async ownsPushRetry(id: string, attempts: number) {
      const rows = await db
        .select({ id: pushRetryQueue.id })
        .from(pushRetryQueue)
        .where(and(eq(pushRetryQueue.id, id), eq(pushRetryQueue.attempts, attempts)))
        .limit(1);
      return rows.length > 0;
    },
    async finishPushRetry(
      id: string,
      attempts: number,
      retry?: { nextAttemptAt: Date; lastError: string },
    ) {
      const owned = and(eq(pushRetryQueue.id, id), eq(pushRetryQueue.attempts, attempts));
      if (retry) await db.update(pushRetryQueue).set(retry).where(owned);
      else await db.delete(pushRetryQueue).where(owned);
    },
    async setPushSubscription(parentId: string, subscription: PushSubscription | null) {
      await db
        .update(parents)
        .set({ pushSubscription: subscription })
        .where(eq(parents.id, parentId));
    },
    async clearPushSubscriptionIfUnchanged(parentId: string, subscription: PushSubscription) {
      // A delayed provider rejection must not erase a newer browser subscription.
      await db
        .update(parents)
        .set({ pushSubscription: null })
        .where(and(eq(parents.id, parentId), eq(parents.pushSubscription, subscription)));
    },
  };
}
