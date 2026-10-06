import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { api, logout, tokens } from "../../web/src/api.js";

const jwt = (role: "parent" | "child", sub: string, version = "old", parentId = "family") =>
  `header.${Buffer.from(JSON.stringify({ role, sub, ...(role === "child" ? { parentId } : {}), jti: version })).toString("base64url")}.signature`;
const oldParent = jwt("parent", "parent");
const newParent = jwt("parent", "parent", "new");
const oldChild = jwt("child", "child");
const fetchMock = vi.fn<typeof fetch>();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  tokens.set("parent", oldParent, "refresh-parent");
  tokens.set("child", oldChild, "refresh-child");
});
afterEach(() => vi.unstubAllGlobals());

test("401 refreshes the requested role and retries the original method/body once", async () => {
  const sessionId = tokens.getSessionId("parent");
  fetchMock
    .mockResolvedValueOnce(json({ error: "expired" }, 401))
    .mockResolvedValueOnce(json({ token: newParent, refreshToken: "next-parent" }))
    .mockResolvedValueOnce(json({ success: true }));
  await expect(
    api("/tasks/task", { role: "parent", method: "PATCH", body: { name: "edited" } }),
  ).resolves.toEqual({ success: true });
  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    "/api/auth/refresh",
    expect.objectContaining({
      body: JSON.stringify({ refreshToken: "refresh-parent" }),
      headers: { "Content-Type": "application/json" },
    }),
  );
  expect(fetchMock).toHaveBeenNthCalledWith(
    3,
    "/api/tasks/task",
    expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ name: "edited" }),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${newParent}` },
    }),
  );
  expect(tokens.getSessionId("parent")).toBe(sessionId);
  expect(tokens.getRefresh("parent")).toBe("next-parent");
  expect(tokens.get("child")).toBe(oldChild);
  expect(tokens.getRefresh("child")).toBe("refresh-child");
});

test("parallel 401s share a single refresh", async () => {
  let finish!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  fetchMock.mockImplementation(async (path, init) => {
    if (path === "/api/auth/refresh") return pending;
    return new Headers(init?.headers).get("Authorization") === `Bearer ${newParent}`
      ? json({ success: true })
      : json({ error: "expired" }, 401);
  });
  const first = api("/session", { role: "parent" });
  const second = api("/children", { role: "parent" });
  await vi.waitFor(() =>
    expect(fetchMock.mock.calls.filter(([path]) => path === "/api/auth/refresh")).toHaveLength(1),
  );
  finish(json({ token: newParent, refreshToken: "next-parent" }));
  await Promise.all([first, second]);
  expect(fetchMock.mock.calls.filter(([path]) => path === "/api/auth/refresh")).toHaveLength(1);
});

test.each([401, 429, 500, 503])(
  "refresh failure %s clears credentials only for 401 and returns the original error",
  async (status) => {
    fetchMock
      .mockResolvedValueOnce(json({ error: "expired" }, 401))
      .mockResolvedValueOnce(json({ error: "failed" }, status));
    await expect(api("/session", { role: "child" })).rejects.toMatchObject({
      status: 401,
      message: "expired",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(tokens.get("child")).toBe(status === 401 ? null : oldChild);
    expect(tokens.getRefresh("child")).toBe(status === 401 ? null : "refresh-child");
    expect(tokens.getRefresh("parent")).toBe("refresh-parent");
  },
);

test("a failed retry cannot trigger another refresh", async () => {
  fetchMock
    .mockResolvedValueOnce(json({ error: "expired" }, 401))
    .mockResolvedValueOnce(json({ token: newParent, refreshToken: "next-parent" }))
    .mockResolvedValueOnce(json({ error: "invalid" }, 401));
  await expect(api("/session", { role: "parent" })).rejects.toMatchObject({ status: 401 });
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(tokens.getRefresh("parent")).toBeNull();
});

test("old sessions without refresh credentials fail normally", async () => {
  localStorage.removeItem("ctrl-y.parent-refresh-token");
  fetchMock.mockResolvedValueOnce(json({ error: "expired" }, 401));
  await expect(api("/session", { role: "parent" })).rejects.toMatchObject({ status: 401 });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(tokens.get("parent")).toBeNull();
});

test("logout waits for server revocation before removing local credentials", async () => {
  fetchMock.mockImplementation(async () => {
    expect(tokens.getRefresh("parent")).toBe("refresh-parent");
    return json({ success: true });
  });
  await logout("parent");
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/auth/logout",
    expect.objectContaining({ body: JSON.stringify({ refreshToken: "refresh-parent" }) }),
  );
  expect(tokens.get("parent")).toBeNull();
  expect(tokens.getRefresh("parent")).toBeNull();
  expect(tokens.getRefresh("child")).toBe("refresh-child");
});

test("failed logout retains credentials so server revocation can be retried", async () => {
  fetchMock.mockRejectedValueOnce(new Error("offline"));
  await expect(logout("parent")).rejects.toThrow("offline");
  expect(tokens.getRefresh("parent")).toBe("refresh-parent");
});

test.each([
  ["parent", jwt("parent", "other")],
  ["child", jwt("child", "other")],
  ["child", jwt("child", "child", "new", "other-family")],
  ["parent", "malformed"],
] as const)("%s does not retry a mutation after its owner changes", async (role, replacement) => {
  fetchMock.mockImplementationOnce(async () => {
    tokens.set(role, replacement, "replacement-refresh");
    return json({ error: "original expired" }, 401);
  });
  await expect(api("/tasks", { role, body: { name: "original task" } })).rejects.toMatchObject({
    status: 401,
    message: "original expired",
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(tokens.get(role)).toBe(replacement);
});

test("an already refreshed token with the same owner retries without another refresh", async () => {
  fetchMock
    .mockImplementationOnce(async () => {
      tokens.set("parent", newParent, "next-parent", false);
      return json({ error: "expired" }, 401);
    })
    .mockResolvedValueOnce(json({ success: true }));
  await expect(api("/tasks", { role: "parent", body: { name: "task" } })).resolves.toEqual({
    success: true,
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[1][1]?.headers).toMatchObject({
    Authorization: `Bearer ${newParent}`,
  });
});

test("shared refresh cannot retry pending mutations under a newly logged-in owner", async () => {
  let finish!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  fetchMock.mockImplementation(async (path) =>
    path === "/api/auth/refresh" ? pending : json({ error: "expired" }, 401),
  );
  const first = expect(
    api("/tasks", { role: "parent", body: { name: "first" } }),
  ).rejects.toMatchObject({ status: 401 });
  const second = expect(
    api("/tasks", { role: "parent", body: { name: "second" } }),
  ).rejects.toMatchObject({ status: 401 });
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  const replacement = jwt("parent", "other");
  tokens.set("parent", replacement, "other-refresh");
  finish(json({ token: newParent, refreshToken: "next-parent" }));
  await Promise.all([first, second]);
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(tokens.get("parent")).toBe(replacement);
  expect(tokens.getRefresh("parent")).toBe("other-refresh");
});

test("logout preserves a login that completed while server revocation was pending", async () => {
  fetchMock.mockImplementationOnce(async () => {
    tokens.set("parent", newParent, "new-login-refresh");
    return json({ success: true });
  });
  await logout("parent");
  expect(tokens.get("parent")).toBe(newParent);
  expect(tokens.getRefresh("parent")).toBe("new-login-refresh");
});

test("network failure retains credentials and a later request can refresh", async () => {
  fetchMock
    .mockResolvedValueOnce(json({ error: "expired" }, 401))
    .mockRejectedValueOnce(new Error("offline"));
  await expect(api("/session", { role: "parent" })).rejects.toMatchObject({
    status: 401,
    message: "expired",
  });
  expect(tokens.get("parent")).toBe(oldParent);
  expect(tokens.getRefresh("parent")).toBe("refresh-parent");
  fetchMock
    .mockResolvedValueOnce(json({ error: "expired" }, 401))
    .mockResolvedValueOnce(json({ token: newParent, refreshToken: "next-parent" }))
    .mockResolvedValueOnce(json({ success: true }));
  await expect(api("/session", { role: "parent" })).resolves.toEqual({ success: true });
  expect(tokens.getRefresh("parent")).toBe("next-parent");
});
