import { parents, pushRetryQueue, pushSubscriptions } from "@ctrl-y/database";
import { and, eq, lte, isNull, isNotNull, sql } from "drizzle-orm";
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
      subscriptionId: string,
    ) {
      await db
        .insert(pushRetryQueue)
        .values({ parentId, taskName, lastError, nextAttemptAt, subscriptionId });
    },
    async claimPushRetries(now: Date, limit = 25) {
      return db.transaction(async (tx) => {
        const legacy = await tx
          .select()
          .from(pushRetryQueue)
          .where(and(lte(pushRetryQueue.nextAttemptAt, now), isNull(pushRetryQueue.subscriptionId)))
          .limit(limit)
          .for("update", { skipLocked: true });
        for (const row of legacy) {
          await tx.execute(sql`
            INSERT INTO push_retry_queue
              (parent_id, subscription_id, task_name, attempts, next_attempt_at, last_error, created_at)
            SELECT ${row.parentId}, id, ${row.taskName}, ${row.attempts},
              ${row.nextAttemptAt.toISOString()}::timestamptz, ${row.lastError},
              ${row.createdAt.toISOString()}::timestamptz
            FROM push_subscriptions
            WHERE parent_id = ${row.parentId}
            FOR KEY SHARE
          `);
          await tx.delete(pushRetryQueue).where(eq(pushRetryQueue.id, row.id));
        }
        const rows = await tx
          .select()
          .from(pushRetryQueue)
          .where(
            and(lte(pushRetryQueue.nextAttemptAt, now), isNotNull(pushRetryQueue.subscriptionId)),
          )
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
    async pushSubscriptionsForParent(parentId: string) {
      const rows = await db
        .select()
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.parentId, parentId));
      return rows.map(({ id, endpoint, p256dh, auth }) => ({
        id,
        endpoint,
        keys: { p256dh, auth },
      }));
    },
    async pushSubscriptionById(parentId: string, id: string) {
      const [row] = await db
        .select()
        .from(pushSubscriptions)
        .where(and(eq(pushSubscriptions.parentId, parentId), eq(pushSubscriptions.id, id)));
      return row
        ? { id: row.id, endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }
        : undefined;
    },
    async setPushSubscription(parentId: string, subscription: PushSubscription) {
      return db.transaction(async (tx) => {
        // Serialize registrations for this parent so concurrent devices respect the limit.
        await tx
          .select({ id: parents.id })
          .from(parents)
          .where(eq(parents.id, parentId))
          .for("no key update");
        const rows = await tx
          .insert(pushSubscriptions)
          .values({
            parentId,
            endpoint: subscription.endpoint,
            ...subscription.keys,
          })
          .onConflictDoUpdate({
            target: pushSubscriptions.endpoint,
            set: { ...subscription.keys, updatedAt: sql`now()` },
            setWhere: eq(pushSubscriptions.parentId, parentId),
          })
          .returning();
        if (!rows.length) return false;
        const subscriptions = await tx
          .select()
          .from(pushSubscriptions)
          .where(eq(pushSubscriptions.parentId, parentId))
          .orderBy(pushSubscriptions.updatedAt, pushSubscriptions.id);
        for (const oldest of subscriptions.slice(0, Math.max(0, subscriptions.length - 10)))
          await tx.delete(pushSubscriptions).where(eq(pushSubscriptions.id, oldest.id));
        return true;
      });
    },
    async deletePushSubscriptions(parentId: string, endpoint?: string) {
      await db
        .delete(pushSubscriptions)
        .where(
          and(
            eq(pushSubscriptions.parentId, parentId),
            endpoint === undefined ? undefined : eq(pushSubscriptions.endpoint, endpoint),
          ),
        );
    },
    async clearPushSubscriptionIfUnchanged(
      parentId: string,
      subscription: PushSubscription & { id: string },
    ) {
      // A delayed rejection must not erase renewed keys or a recreated subscription.
      await db
        .delete(pushSubscriptions)
        .where(
          and(
            eq(pushSubscriptions.parentId, parentId),
            eq(pushSubscriptions.id, subscription.id),
            eq(pushSubscriptions.endpoint, subscription.endpoint),
            eq(pushSubscriptions.p256dh, subscription.keys.p256dh),
            eq(pushSubscriptions.auth, subscription.keys.auth),
          ),
        );
    },
  };
}
