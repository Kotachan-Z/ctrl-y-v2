import { beforeEach, expect, test, vi } from "vitest";

import type { createApp } from "../src/server.js";
import type { Env } from "../src/worker.js";
import { vapidEnv } from "./vapid-fixture.js";

const mocks = vi.hoisted(() => ({
  database: vi.fn(),
  repository: vi.fn(),
  app: vi.fn(),
  handle: vi.fn(),
  useRealApp: false,
}));
vi.mock("@ctrl-y/database/production", () => ({ createProductionDatabase: mocks.database }));
vi.mock("../src/repository.js", () => ({ createRepository: mocks.repository }));
vi.mock("../src/server.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server.js")>();
  return {
    createApp: (options: Parameters<typeof createApp>[0]) => {
      mocks.app(options);
      const app = actual.createApp(options); // Exercise the real fail-fast JWT/VAPID validation.
      if (mocks.useRealApp) return app;
      return { fetch: (request: Request) => mocks.handle(options, request) };
    },
  };
});

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  mocks.useRealApp = false;
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

const clientIp = "192.0.2.1";
const childId = "00000000-0000-4000-8000-000000000001";
const authPaths = ["/api/parents", "/api/parents/login", `/api/children/${childId}/login`];
function authRequest(path: string, ip: string | undefined = clientIp) {
  return new Request(`https://example.test${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(ip ? { "CF-Connecting-IP": ip } : {}),
    },
    body: JSON.stringify({ email: "worker@example.test", password: "password123" }),
  });
}
function mockDatabase() {
  const end = vi.fn().mockResolvedValue(undefined);
  mocks.database.mockReturnValue({ db: {}, sql: { end } });
  return end;
}

test("all authentication routes consume the same IP budget", async () => {
  const { default: worker } = await import("../src/worker.js");
  mockDatabase();
  const counts = new Map<string, number>();
  const limit = vi.fn<RateLimit["limit"]>(async ({ key }) => {
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    return { success: count <= 3 };
  });
  const env = { ...bindings(), AUTH_RATE_LIMITER: { limit } };
  const { ctx, pending } = context();
  for (const path of authPaths) {
    expect((await worker.fetch(authRequest(path), env, ctx)).status).toBe(200);
  }
  for (const path of authPaths) {
    expect((await worker.fetch(authRequest(path), env, ctx)).status).toBe(429);
  }
  expect(limit.mock.calls).toEqual(Array.from({ length: 6 }, () => [{ key: clientIp }]));
  expect(mocks.database).toHaveBeenCalledTimes(3);
  expect((await worker.fetch(authRequest(authPaths[0], "192.0.2.2"), env, ctx)).status).toBe(200);
  await Promise.all(pending);
});

test.each([
  ...authPaths,
  "/api/parents/%6cogin",
  "/api/%70arents",
  "/%61pi/parents/login",
  `/api/children/${childId}/%6cogin`,
  // Hono tolerates malformed escapes and still matches this dynamic segment.
  "/api/children/%ZZ/%6cogin",
])("IP rejection blocks %s before app or database creation", async (path) => {
  const { default: worker } = await import("../src/worker.js");
  const limit = vi.fn<RateLimit["limit"]>().mockResolvedValue({ success: false });
  const env = { ...bindings(), AUTH_RATE_LIMITER: { limit } };
  const response = await worker.fetch(authRequest(path), env, context().ctx);
  expect(response.status).toBe(429);
  expect(response.headers.get("Retry-After")).toBe("60");
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(limit).toHaveBeenCalledExactlyOnceWith({ key: clientIp });
  expect(mocks.app).not.toHaveBeenCalled();
  expect(mocks.database).not.toHaveBeenCalled();
  expect(mocks.repository).not.toHaveBeenCalled();
  expect(mocks.handle).not.toHaveBeenCalled();
});

test.each(["binding", "IP"])("missing %s skips the IP limiter", async (missing) => {
  const { default: worker } = await import("../src/worker.js");
  const end = mockDatabase();
  const limit = vi.fn<RateLimit["limit"]>().mockResolvedValue({ success: false });
  const env: Env = bindings();
  if (missing !== "binding") env.AUTH_RATE_LIMITER = { limit };
  const { ctx, pending } = context();
  const response = await worker.fetch(
    authRequest("/api/parents/login", missing === "IP" ? "" : clientIp),
    env,
    ctx,
  );
  expect(response.status).toBe(200);
  expect(limit).not.toHaveBeenCalled();
  expect(mocks.database).toHaveBeenCalledTimes(1);
  expect(mocks.repository).toHaveBeenCalledTimes(1);
  expect(mocks.handle).toHaveBeenCalledTimes(1);
  await Promise.all(pending);
  expect(end).toHaveBeenCalledTimes(1);
});

test("identifier failures persist across real app instances in one isolate", async () => {
  const { default: worker } = await import("../src/worker.js");
  mocks.useRealApp = true;
  mockDatabase();
  const parentByEmail = vi.fn().mockResolvedValue(null);
  mocks.repository.mockReturnValue({ parentByEmail });
  const limit = vi.fn<RateLimit["limit"]>().mockResolvedValue({ success: true });
  const env = { ...bindings(), AUTH_RATE_LIMITER: { limit } };
  const { ctx, pending } = context();
  for (let i = 0; i < 6; i += 1) {
    const path = i % 2 === 0 ? "/api/parents/login" : "/api/parents/%6cogin";
    const response = await worker.fetch(authRequest(path), env, ctx);
    expect(response.status).toBe(i < 5 ? 401 : 429);
  }
  expect(parentByEmail).toHaveBeenCalledTimes(5);
  expect(mocks.app).toHaveBeenCalledTimes(6);
  expect(limit).toHaveBeenCalledTimes(6);
  await Promise.all(pending);
});
