import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  api,
  type Role,
  pendingOperations,
  replayOfflineOperations,
  startOfflineReplay,
  tokens,
} from "../../web/src/api";

const jwt = (role: Role = "child", id: string = role, version = "old", parentId = "family") =>
  `header.${Buffer.from(JSON.stringify({ role, sub: id, parentId, jti: version })).toString("base64url")}.signature`;
const childToken = jwt();

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
    vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    tokens.set("child", childToken, "refresh-child");
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
    expect(await pendingOperations()).toHaveLength(1);
    await replayOfflineOperations();
    expect(await pendingOperations()).toHaveLength(1);
    fetchMock.mockResolvedValue(Response.json({ ok: true }));
    await replayOfflineOperations();
    expect(await pendingOperations()).toHaveLength(0);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/tasks/task-id/status",
      expect.objectContaining({
        method: "PATCH",
        headers: expect.objectContaining({ Authorization: `Bearer ${childToken}` }),
        body: JSON.stringify({ status: "WAIT_REVIEW" }),
      }),
    );
  });
  it.each([400, 404, 409, 500])(
    "discards HTTP %s on replay and notifies failure",
    async (status) => {
      fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
      await change();
      const listener = vi.fn();
      window.addEventListener("ctrl-y-offline", listener);
      fetchMock.mockResolvedValue(new Response("not JSON", { status }));
      await replayOfflineOperations();
      expect(await pendingOperations()).toHaveLength(0);
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ detail: expect.stringContaining(`HTTP ${status}`) }),
      );
    },
  );
  it("stores only an identity digest and replays with a rotated current token", async () => {
    fetchMock.mockRejectedValue(new TypeError("offline"));
    await change();
    const entry = (await pendingOperations())[0];
    const stored = localStorage.getItem(`ctrl-y.offline-status.${entry.id}`)!;
    expect(JSON.parse(stored)).toMatchObject({
      ownerFingerprint: createHash("sha256").update("child:child:family").digest("hex"),
    });
    expect(stored).not.toContain(childToken);
    expect(JSON.parse(stored)).not.toHaveProperty("token");
    expect(JSON.parse(stored)).not.toHaveProperty("owner");
    expect(stored).not.toContain("family");
    const rotated = jwt("child", "child", "new");
    tokens.set("child", rotated, "new-refresh");
    expect(await pendingOperations("child")).toHaveLength(1);
    expect(await pendingOperations("parent")).toHaveLength(0);
    fetchMock.mockResolvedValue(Response.json({ ok: true }));
    await replayOfflineOperations();
    expect(fetchMock.mock.lastCall?.[1]?.headers).toMatchObject({
      Authorization: `Bearer ${rotated}`,
    });
    expect(await pendingOperations()).toHaveLength(0);
  });
  it.each([200, 401, 500])("replay refreshes once and handles retry HTTP %s", async (status) => {
    fetchMock.mockRejectedValue(new TypeError("offline"));
    await change();
    fetchMock.mockReset();
    const rotated = jwt("child", "child", "new");
    fetchMock
      .mockResolvedValueOnce(Response.json({}, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ token: rotated, refreshToken: "new-refresh" }))
      .mockResolvedValueOnce(Response.json({}, { status }));
    await replayOfflineOperations();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.lastCall?.[1]?.headers).toMatchObject({
      Authorization: `Bearer ${rotated}`,
    });
    expect(await pendingOperations()).toHaveLength(status === 200 ? 0 : 1);
  });
  it.each([401, 503])("retains queued work when refresh fails with %s", async (status) => {
    fetchMock.mockRejectedValue(new TypeError("offline"));
    await change();
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(Response.json({}, { status: 401 }))
      .mockResolvedValueOnce(Response.json({}, { status }));
    await replayOfflineOperations();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await pendingOperations()).toHaveLength(1);
  });
  it("queues a network failure after a successful refresh", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({}, { status: 401 }))
      .mockResolvedValueOnce(
        Response.json({ token: jwt("child", "child", "new"), refreshToken: "new-refresh" }),
      )
      .mockRejectedValueOnce(new TypeError("offline"));
    expect(await change()).toEqual({ queued: true });
    expect(await pendingOperations()).toHaveLength(1);
  });
  it("rejects unidentifiable tokens", async () => {
    tokens.set("child", "malformed", "refresh");
    fetchMock.mockRejectedValue(new TypeError("offline"));
    await expect(change()).rejects.toThrow("offline");
    expect(await pendingOperations()).toHaveLength(0);
  });
  it("does not retry under a different family after refresh", async () => {
    fetchMock.mockRejectedValue(new TypeError("offline"));
    await change();
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(Response.json({}, { status: 401 }))
      .mockImplementationOnce(async () => {
        tokens.set("child", jwt("child", "child", "new", "another-family"), "another-refresh");
        return Response.json({ token: jwt("child", "child", "new"), refreshToken: "new-refresh" });
      });
    await replayOfflineOperations();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await pendingOperations()).toHaveLength(0);
    tokens.set("child", childToken, "refresh-child");
    expect(await pendingOperations()).toHaveLength(1);
  });
  it("logout after rotation removes only that owner's queued work and both credentials", async () => {
    fetchMock.mockRejectedValue(new TypeError("offline"));
    await change();
    tokens.set("child", jwt("child", "another"), "another-refresh");
    await change();
    tokens.set("child", jwt("child", "child", "new"), "new-refresh");
    await tokens.remove("child");
    expect(tokens.get("child")).toBeNull();
    expect(tokens.getRefresh("child")).toBeNull();
    tokens.set("child", childToken, "refresh-child");
    expect(await pendingOperations()).toHaveLength(0);
    tokens.set("child", jwt("child", "another"), "another-refresh");
    expect(await pendingOperations()).toHaveLength(1);
  });
  it("rejects invalid fingerprints and legacy identity/bearer entries", async () => {
    for (const [index, ownerFingerprint] of [
      null,
      "",
      123,
      {},
      { role: "child", id: "" },
      { role: "child", id: "child", parentId: 1 },
      { role: "parent", id: "child" },
    ].entries()) {
      localStorage.setItem(
        `ctrl-y.offline-status.invalid-${index}`,
        JSON.stringify({
          id: `invalid-${index}`,
          ownerFingerprint,
          owner: { role: "child", id: "child", parentId: "family" },
          role: "child",
          path: "/tasks/task-id/status",
          body: JSON.stringify({ status: "WAIT_REVIEW" }),
          created: 1,
        }),
      );
    }
    localStorage.setItem(
      "ctrl-y.offline-status.legacy",
      JSON.stringify({
        id: "legacy",
        token: childToken,
        role: "child",
        path: "/tasks/task-id/status",
        body: JSON.stringify({ status: "WAIT_REVIEW" }),
        created: 1,
      }),
    );
    expect(await pendingOperations()).toHaveLength(0);
  });
  it("dispatches cache notifications for successful cached responses", async () => {
    const listener = vi.fn();
    window.addEventListener("ctrl-y-cached", listener);
    fetchMock.mockResolvedValue(
      Response.json({ tasks: [] }, { headers: { "X-Ctrl-Y-Offline": "1" } }),
    );
    await expect(api("/tasks", { role: "child" })).resolves.toEqual({ tasks: [] });
    expect(listener).toHaveBeenCalledTimes(1);
  });
  it("does not queue direct HTTP errors or other writes", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: "conflict" }, { status: 409 }));
    await expect(change()).rejects.toThrow("conflict");
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(api("/tasks", { role: "child", method: "POST", body: {} })).rejects.toThrow();
    expect(await pendingOperations()).toHaveLength(0);
  });
  it.each<[Role, string]>([
    ["child", "IN_PROGRESS"],
    ["child", "DONE"],
    ["parent", "DONE"],
    ["parent", "WAIT_REVIEW"],
  ])("does not queue %s transitions to %s", async (role, status) => {
    tokens.set(role, jwt(role), "refresh");
    fetchMock.mockRejectedValue(new TypeError("offline"));
    await expect(
      api("/tasks/task-id/status", {
        role,
        method: "PATCH",
        body: { status },
      }),
    ).rejects.toThrow("offline");
    expect(await pendingOperations()).toHaveLength(0);
  });
  it.each(["logout", "switch"])("does not save a pending request after %s", async (action) => {
    let rejectFetch!: (reason: Error) => void;
    fetchMock.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectFetch = reject;
        }),
    );
    const request = change();
    const assertion = expect(request).rejects.toThrow("offline");
    if (action === "logout") await tokens.remove("child");
    else tokens.set("child", jwt("child", "other"), "refresh-other");
    rejectFetch(new TypeError("offline"));
    await assertion;
    tokens.set("child", childToken, "refresh-child");
    expect(await pendingOperations()).toHaveLength(0);
  });
  it("discards legacy approvals, reopenings and starts without sending them", async () => {
    tokens.set("parent", jwt("parent"), "refresh-parent");
    for (const [id, role, status] of [
      ["approval", "parent", "DONE"],
      ["reopening", "parent", "WAIT_REVIEW"],
      ["start", "child", "IN_PROGRESS"],
    ]) {
      localStorage.setItem(
        `ctrl-y.offline-status.${id}`,
        JSON.stringify({
          id,
          role,
          ownerFingerprint: createHash("sha256")
            .update(`${role}:${role}:${role === "child" ? "family" : ""}`)
            .digest("hex"),
          path: "/tasks/task-id/status",
          body: JSON.stringify({ status }),
          created: 1,
        }),
      );
    }
    await replayOfflineOperations();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await pendingOperations()).toHaveLength(0);
  });
  it("retries when visible and removes the visibility listener on cleanup", async () => {
    const stop = startOfflineReplay();
    await replayOfflineOperations();
    fetchMock.mockRejectedValue(new TypeError("offline"));
    await change();
    fetchMock.mockResolvedValue(Response.json({ ok: true }));
    const calls = fetchMock.mock.calls.length;
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(fetchMock).toHaveBeenCalledTimes(calls);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await replayOfflineOperations();
    expect(fetchMock).toHaveBeenCalledTimes(calls + 1);
    expect(await pendingOperations()).toHaveLength(0);
    fetchMock.mockRejectedValue(new TypeError("offline"));
    await change();
    fetchMock.mockResolvedValue(Response.json({ ok: true }));
    const beforeCleanup = fetchMock.mock.calls.length;
    stop();
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("online"));
    expect(fetchMock).toHaveBeenCalledTimes(beforeCleanup);
    expect(await pendingOperations()).toHaveLength(1);
  });
  it("automatically replays at startup and online events, serializing concurrent triggers", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await change();
    fetchMock.mockResolvedValue(Response.json({ ok: true }));
    const stop = startOfflineReplay();
    await replayOfflineOperations();
    expect(await pendingOperations()).toHaveLength(0);
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await change();
    fetchMock.mockResolvedValue(Response.json({ ok: true }));
    const calls = fetchMock.mock.calls.length;
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("online"));
    await replayOfflineOperations();
    expect(fetchMock).toHaveBeenCalledTimes(calls + 1);
    expect(await pendingOperations()).toHaveLength(0);
    stop();
  });
  it("reports storage failure instead of claiming an operation was queued", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("Storage full");
    });
    await expect(change()).rejects.toThrow("Storage full");
    expect(await pendingOperations()).toHaveLength(0);
  });
  it("never replays another token's operations and removes pending work on logout", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await change();
    tokens.set("child", jwt("child", "another"), "refresh-another");
    fetchMock.mockClear();
    await replayOfflineOperations();
    expect(fetchMock).not.toHaveBeenCalled();
    tokens.set("child", childToken, "refresh-child");
    expect(await pendingOperations()).toHaveLength(1);
    await tokens.remove("child");
    tokens.set("child", childToken, "refresh-child");
    expect(await pendingOperations()).toHaveLength(0);
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
    return { fetchMock, request, responses, cache };
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
  it.each([200, 401])("serializes same-key requests and writes before HTTP %s", async (status) => {
    const { fetchMock, request, cache } = worker();
    let finishWrite!: () => void;
    const originalPut = cache.put;
    const put = vi.spyOn(cache, "put").mockImplementationOnce(async (key, response) => {
      await new Promise<void>((resolve) => {
        finishWrite = resolve;
      });
      await originalPut(key, response);
    });
    fetchMock.mockResolvedValueOnce(Response.json({ version: 1 }));
    const first = request("/api/tasks");
    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    const second = request("/api/tasks");
    // A different key can finish while this key's first cache write is blocked.
    fetchMock.mockResolvedValueOnce(Response.json({ independent: true }));
    await request("/api/children");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ version: 2 }), { status }));
    finishWrite();
    await first;
    await second;
    fetchMock.mockRejectedValue(new TypeError("offline"));
    const cached = (await request("/api/tasks"))!;
    if (status === 401) expect(cached.type).toBe("error");
    else expect(await cached.json()).toEqual({ version: 2 });
  });
  it("continues after a failed cache write", async () => {
    const { fetchMock, request, cache } = worker();
    vi.spyOn(cache, "put").mockRejectedValueOnce(new Error("storage unavailable"));
    fetchMock.mockResolvedValue(Response.json({ version: 1 }));
    expect((await request("/api/tasks"))!.ok).toBe(true);
    fetchMock.mockResolvedValue(Response.json({ version: 2 }));
    await request("/api/tasks");
    fetchMock.mockRejectedValue(new TypeError("offline"));
    expect(await (await request("/api/tasks"))!.json()).toEqual({ version: 2 });
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
