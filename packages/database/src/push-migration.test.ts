import assert from "node:assert/strict";
import { test } from "node:test";

import { PGlite } from "@electric-sql/pglite";

import { readMigrations } from "./migration-history";

await test("push migration copies legacy subscriptions, preserves old columns and queues", async () => {
  const client = new PGlite();
  try {
    const migrations = await readMigrations();
    const index = migrations.findIndex(
      (migration) => migration.tag === "20261026052217_multi_device_push",
    );
    assert.ok(index > 0);
    for (const migration of migrations.slice(0, index)) await client.exec(migration.sql);
    const subscription = {
      endpoint: "https://push.example.test/device",
      keys: { p256dh: "key", auth: "auth" },
    };
    await client.query(
      "INSERT INTO parents (email, password_hash, push_subscription) VALUES ($1, $2, $3), ($4, $2, $3), ($5, $2, NULL)",
      [
        "first@example.test",
        "unused",
        JSON.stringify(subscription),
        "duplicate@example.test",
        "empty@example.test",
      ],
    );
    await client.exec(
      "UPDATE parents SET created_at = '2020-01-01' WHERE email = 'first@example.test'",
    );
    for (const [i, invalid] of [
      { endpoint: "https://push.example.test/missing-keys" },
      { endpoint: "https://push.example.test/missing-auth", keys: { p256dh: "key" } },
      { endpoint: "https://push.example.test/missing-p256dh", keys: { auth: "auth" } },
      { keys: { p256dh: "key", auth: "auth" } },
    ].entries()) {
      await client.query(
        "INSERT INTO parents (email, password_hash, push_subscription) VALUES ($1, 'unused', $2)",
        [`invalid${i}@example.test`, JSON.stringify(invalid)],
      );
    }
    await client.exec(
      "INSERT INTO push_retry_queue (parent_id, task_name, next_attempt_at, last_error) SELECT id, 'task', now(), 'http_503' FROM parents",
    );
    await client.exec(migrations[index].sql);
    const rows = await client.query("SELECT endpoint, p256dh, auth FROM push_subscriptions");
    assert.deepEqual(rows.rows, [{ endpoint: subscription.endpoint, ...subscription.keys }]);
    const owner = await client.query(
      "SELECT email FROM parents JOIN push_subscriptions ON parents.id = push_subscriptions.parent_id",
    );
    assert.deepEqual(owner.rows, [{ email: "first@example.test" }]);
    const old = await client.query(
      "SELECT push_subscription FROM parents WHERE email = 'first@example.test'",
    );
    assert.deepEqual(old.rows, [{ push_subscription: subscription }]);
    const queue = await client.query("SELECT subscription_id FROM push_retry_queue");
    assert.deepEqual(queue.rows, Array(7).fill({ subscription_id: null }));
  } finally {
    await client.close();
  }
});
