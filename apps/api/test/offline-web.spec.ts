import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  api,
  pendingOperations,
  replayOfflineOperations,
  startOfflineReplay,
  tokens,
} from "../../web/src/api";

// Exercise the browser client with the existing Vitest runner; no DOM rendering is needed.
describe("offline status queue", () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      get length() {
        return storage.size;
      },
      key: (index: number) => [...storage.keys()][index] ?? null,
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    tokens.set("child", "child-token");
  });
  afterEach(() => vi.unstubAllGlobals());
  const change = () =>
    api<{ queued?: boolean }>("/tasks/task-id/status", {
      role: "child",
      method: "PATCH",
      body: { status: "WAIT_REVIEW" },
    });
  it("persists network failures, retains them on network retry failure and removes successes", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await change()).toEqual({ queued: true });
    expect(pendingOperations()).toHaveLength(1);
    await replayOfflineOperations();
    expect(pendingOperations()).toHaveLength(1);
    fetchMock.mockResolvedValue(Response.json({ ok: true }));
    await replayOfflineOperations();
    expect(pendingOperations()).toHaveLength(0);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/tasks/task-id/status",
      expect.objectContaining({
        method: "PATCH",
        headers: expect.objectContaining({ Authorization: "Bearer child-token" }),
        body: JSON.stringify({ status: "WAIT_REVIEW" }),
      }),
    );
  });
  it.each([400, 401, 404, 409, 500])(
    "discards HTTP %s on replay and notifies failure",
    async (status) => {
      fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
      await change();
      const listener = vi.fn();
      window.addEventListener("ctrl-y-offline", listener);
      fetchMock.mockResolvedValue(new Response("not JSON", { status }));
      await replayOfflineOperations();
      expect(pendingOperations()).toHaveLength(0);
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ detail: expect.stringContaining(`HTTP ${status}`) }),
      );
    },
  );
  it("does not queue direct HTTP errors or other writes", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: "conflict" }, { status: 409 }));
    await expect(change()).rejects.toThrow("conflict");
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(api("/tasks", { role: "child", method: "POST", body: {} })).rejects.toThrow();
    expect(pendingOperations()).toHaveLength(0);
  });
  it("automatically replays at startup and online events, serializing concurrent triggers", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await change();
    fetchMock.mockResolvedValue(Response.json({ ok: true }));
    const stop = startOfflineReplay();
    await replayOfflineOperations();
    expect(pendingOperations()).toHaveLength(0);
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await change();
    fetchMock.mockResolvedValue(Response.json({ ok: true }));
    const calls = fetchMock.mock.calls.length;
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("online"));
    await replayOfflineOperations();
    expect(fetchMock).toHaveBeenCalledTimes(calls + 1);
    expect(pendingOperations()).toHaveLength(0);
    stop();
  });
  it("reports storage failure instead of claiming an operation was queued", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("Storage full");
    });
    await expect(change()).rejects.toThrow("Storage full");
    expect(pendingOperations()).toHaveLength(0);
  });
  it("never replays another token's operations and removes pending work on logout", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await change();
    tokens.set("child", "another-token");
    fetchMock.mockClear();
    await replayOfflineOperations();
    expect(fetchMock).not.toHaveBeenCalled();
    tokens.set("child", "child-token");
    expect(pendingOperations()).toHaveLength(1);
    tokens.remove("child");
    tokens.set("child", "child-token");
    expect(pendingOperations()).toHaveLength(0);
  });
});

describe("service worker API cache", () => {
  function worker() {
    const responses = new Map<string, Response>();
    const fetchMock = vi.fn<typeof fetch>();
    const handlers = new Map<
      string,
      (event: { request: Request; respondWith: (response: Promise<Response>) => void }) => void
    >();
    const cache = {
      match: async (key: string) => responses.get(key)?.clone(),
      put: async (key: string, response: Response) => {
        responses.set(key, response);
      },
      delete: async (key: string) => responses.delete(key),
    };
    runInNewContext(readFileSync(new URL("../../web/public/sw.js", import.meta.url), "utf8"), {
      self: {
        location: { origin: "https://app.test" },
        addEventListener: (
          name: string,
          handler: typeof handlers extends Map<string, infer H> ? H : never,
        ) => handlers.set(name, handler),
      },
      caches: { open: async () => cache },
      fetch: fetchMock,
      crypto,
      TextEncoder,
      URL,
      Response,
      Headers,
    });
    const request = (path: string, token = "parent", method = "GET") => {
      let result: Promise<Response> | undefined;
      handlers.get("fetch")!({
        request: new Request(`https://app.test${path}`, {
          method,
          headers: { Authorization: `Bearer ${token}` },
        }),
        respondWith: (response) => {
          result = response;
        },
      });
      return result;
    };
    return { fetchMock, request, responses };
  }
  it.each([
    "/api/tasks",
    "/api/tasks/id",
    "/api/payroll",
    "/api/children/id/payroll",
    "/api/children",
    "/api/settings/payroll",
    "/api/session",
  ])("refreshes %s online and falls back only on network failure", async (path) => {
    const { fetchMock, request } = worker();
    fetchMock.mockResolvedValue(Response.json({ version: 1 }));
    expect(await (await request(path))!.json()).toEqual({ version: 1 });
    fetchMock.mockResolvedValue(Response.json({ version: 2 }));
    await request(path);
    fetchMock.mockRejectedValue(new TypeError("offline"));
    const cached = (await request(path))!;
    expect(cached.headers.get("X-Ctrl-Y-Offline")).toBe("1");
    expect(await cached.json()).toEqual({ version: 2 });
    expect((await request(path, "child"))!.type).toBe("error");
    expect((await request(`${path}?different=1`))!.type).toBe("error");
  });
  it("does not intercept out-of-scope paths or writes; returns HTTP failures directly", async () => {
    const { fetchMock, request } = worker();
    expect(request("/api/health")).toBeUndefined();
    expect(request("/api/tasks/id/status")).toBeUndefined();
    expect(request("/api/tasks", "parent", "PATCH")).toBeUndefined();
    fetchMock.mockResolvedValue(Response.json({ tasks: [] }));
    await request("/api/tasks");
    fetchMock.mockResolvedValue(new Response("unauthorized", { status: 401 }));
    expect((await request("/api/tasks"))!.status).toBe(401);
    fetchMock.mockRejectedValue(new TypeError("offline"));
    expect((await request("/api/tasks"))!.type).toBe("error");
  });
});
