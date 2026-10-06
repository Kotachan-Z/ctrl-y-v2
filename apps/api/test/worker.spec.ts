import { buildPushPayload } from "@block65/webcrypto-web-push";
import { beforeEach, expect, test, vi } from "vitest";

import type { createApp } from "../src/server.js";
import type { Env } from "../src/worker.js";
import { vapidEnv } from "./vapid-fixture.js";

vi.mock("@block65/webcrypto-web-push", () => ({ buildPushPayload: vi.fn() }));

const mocks = vi.hoisted(() => ({
  database: vi.fn(),
  repository: vi.fn(),
  app: vi.fn(),
  handle: vi.fn(),
}));
vi.mock("@ctrl-y/database/production", () => ({ createProductionDatabase: mocks.database }));
vi.mock("../src/repository.js", () => ({ createRepository: mocks.repository }));
vi.mock("../src/server.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server.js")>();
  return {
    createApp: (options: Parameters<typeof createApp>[0]) => {
      mocks.app(options);
      actual.createApp(options); // Exercise the real fail-fast JWT/VAPID validation.
      return { fetch: (request: Request) => mocks.handle(options, request) };
    },
  };
});

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  mocks.repository.mockImplementation((db) => db);
  mocks.handle.mockResolvedValue(new Response("ok"));
});

function bindings() {
  return {
    ...vapidEnv,
    JWT_SECRET: "test-worker-secret-at-least-32-bytes",
    ASSETS: {
      fetch: vi.fn<Fetcher["fetch"]>().mockResolvedValue(new Response("asset")),
      connect: () => {
        throw new Error("Unexpected asset socket connection");
      },
    },
    HYPERDRIVE: {
      connectionString: "postgres://test:test@localhost/test",
      host: "localhost",
      port: 5432,
      user: "test",
      password: "test",
      database: "test",
      connect: () => {
        throw new Error("Unexpected Hyperdrive socket connection");
      },
    },
  } satisfies Env;
}
function context() {
  const pending: Promise<unknown>[] = [];
  class NoopSpan implements Span {
    readonly isTraced = false;
    setAttribute() {}
    end() {}
  }
  const enterSpan: Tracing["enterSpan"] = (_name, callback, ...args) =>
    callback(new NoopSpan(), ...args);
  return {
    pending,
    ctx: {
      waitUntil: (task: Promise<unknown>) => pending.push(task),
      passThroughOnException: () => {},
      props: {},
      tracing: { enterSpan, startActiveSpan: enterSpan, Span: NoopSpan },
    } satisfies ExecutionContext,
  };
}
const request = () => new Request("https://example.test/api/health");

test("assets bypass the API and never create a database", async () => {
  const { default: worker } = await import("../src/worker.js");
  const env = bindings();
  const result = await worker.fetch(new Request("https://example.test/top"), env, context().ctx);
  expect(await result.text()).toBe("asset");
  expect(mocks.app).not.toHaveBeenCalled();
  expect(mocks.database).not.toHaveBeenCalled();
});

test.each(["JWT_SECRET", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"] as const)(
  "invalid %s fails before opening the database without process.env fallback",
  async (name) => {
    const { default: worker } = await import("../src/worker.js");
    const env = bindings();
    env[name] = "";
    await expect(worker.fetch(request(), env, context().ctx)).rejects.toThrow(name);
    expect(mocks.database).not.toHaveBeenCalled();
  },
);

test("warm overlapping requests reconstruct the app and keep repositories and cleanup separate", async () => {
  const { default: worker } = await import("../src/worker.js");
  const first = { db: { id: 1 }, sql: { end: vi.fn().mockResolvedValue(undefined) } };
  const second = { db: { id: 2 }, sql: { end: vi.fn().mockResolvedValue(undefined) } };
  mocks.database.mockReturnValueOnce(first).mockReturnValueOnce(second);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  mocks.handle.mockImplementation(async (options) => {
    const before = options.repository();
    await gate;
    expect(options.repository()).toBe(before);
    return new Response(String(before.id));
  });
  const a = context();
  const b = context();
  const responses = [
    worker.fetch(request(), bindings(), a.ctx),
    worker.fetch(request(), bindings(), b.ctx),
  ];
  release();
  expect(await Promise.all((await Promise.all(responses)).map((r) => r.text()))).toEqual([
    "1",
    "2",
  ]);
  await Promise.all([...a.pending, ...b.pending]);
  expect(mocks.app).toHaveBeenCalledTimes(2);
  expect(mocks.app.mock.calls[0][0].failureLimiter).toBe(mocks.app.mock.calls[1][0].failureLimiter);
  expect(mocks.app.mock.calls[0][0].resetLimit).toBe(mocks.app.mock.calls[1][0].resetLimit);
  expect(first.sql.end).toHaveBeenCalledTimes(1);
  expect(second.sql.end).toHaveBeenCalledTimes(1);
});

test("cleanup waits for background work even if the handler rejects", async () => {
  const { default: worker } = await import("../src/worker.js");
  const end = vi.fn().mockResolvedValue(undefined);
  mocks.database.mockReturnValue({ db: {}, sql: { end } });
  let release!: () => void;
  const notification = new Promise<void>((resolve) => {
    release = resolve;
  });
  mocks.handle.mockImplementation((options) => {
    options.backgroundTask(notification);
    throw new Error("handler failed");
  });
  const { ctx, pending } = context();
  await expect(worker.fetch(request(), bindings(), ctx)).rejects.toThrow("handler failed");
  expect(end).not.toHaveBeenCalled();
  release();
  await Promise.all(pending);
  expect(end).toHaveBeenCalledTimes(1);
});

test("scheduled delivery deletes successful jobs and closes its database", async () => {
  const { default: worker } = await import("../src/worker.js");
  const finishPushRetry = vi.fn().mockResolvedValue(undefined);
  const end = vi.fn().mockResolvedValue(undefined);
  const repository = {
    claimPushRetries: vi
      .fn()
      .mockResolvedValue([{ id: "job", parentId: "parent", taskName: "task", attempts: 1 }]),
    ownsPushRetry: vi.fn().mockResolvedValue(true),
    parentById: vi.fn().mockResolvedValue({
      pushSubscription: {
        endpoint: "https://push.example.test/sub",
        keys: { p256dh: "key", auth: "auth" },
      },
    }),
    finishPushRetry,
  };
  mocks.database.mockReturnValue({ db: repository, sql: { end } });
  vi.mocked(buildPushPayload).mockResolvedValue({
    method: "post",
    headers: {
      authorization: "vapid test",
      ttl: "2419200",
      "content-encoding": "aes128gcm",
      "content-length": "0",
      "content-type": "application/octet-stream",
    },
    body: new Uint8Array(),
  });
  const send = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
  vi.stubGlobal("fetch", send);
  try {
    await worker.scheduled(
      { cron: "*/5 * * * *", scheduledTime: Date.now(), noRetry() {} },
      bindings(),
    );
    expect(send).toHaveBeenCalledOnce();
  } finally {
    vi.unstubAllGlobals();
  }
  expect(finishPushRetry).toHaveBeenCalledWith("job", 1, undefined);
  expect(end).toHaveBeenCalledOnce();
});
test("scheduled claim failure still closes its connection", async () => {
  const { default: worker } = await import("../src/worker.js");
  const end = vi.fn().mockResolvedValue(undefined);
  mocks.database.mockReturnValue({
    db: { claimPushRetries: vi.fn().mockRejectedValue(new Error("db failed")) },
    sql: { end },
  });
  await expect(
    worker.scheduled({ cron: "*/5 * * * *", scheduledTime: Date.now(), noRetry() {} }, bindings()),
  ).rejects.toThrow("db failed");
  expect(end).toHaveBeenCalledOnce();
});
