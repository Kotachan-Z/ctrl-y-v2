import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { api, logout, tokens } from "../../web/src/api.js";

const fetchMock = vi.fn<typeof fetch>();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  tokens.set("parent", "old-parent", "refresh-parent");
  tokens.set("child", "old-child", "refresh-child");
});
afterEach(() => vi.unstubAllGlobals());

test("401 refreshes the requested role and retries the original method/body once", async () => {
  fetchMock
    .mockResolvedValueOnce(json({ error: "expired" }, 401))
    .mockResolvedValueOnce(json({ token: "new-parent", refreshToken: "next-parent" }))
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
      headers: { "Content-Type": "application/json", Authorization: "Bearer new-parent" },
    }),
  );
  expect(tokens.getRefresh("parent")).toBe("next-parent");
  expect(tokens.get("child")).toBe("old-child");
  expect(tokens.getRefresh("child")).toBe("refresh-child");
});

test("parallel 401s share a single refresh", async () => {
  let finish!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  fetchMock.mockImplementation(async (path, init) => {
    if (path === "/api/auth/refresh") return pending;
    return new Headers(init?.headers).get("Authorization") === "Bearer new-parent"
      ? json({ success: true })
      : json({ error: "expired" }, 401);
  });
  const first = api("/session", { role: "parent" });
  const second = api("/children", { role: "parent" });
  await vi.waitFor(() =>
    expect(fetchMock.mock.calls.filter(([path]) => path === "/api/auth/refresh")).toHaveLength(1),
  );
  finish(json({ token: "new-parent", refreshToken: "next-parent" }));
  await Promise.all([first, second]);
  expect(fetchMock.mock.calls.filter(([path]) => path === "/api/auth/refresh")).toHaveLength(1);
});

test.each([401, 429, 500])(
  "refresh failure %s clears only the affected role and returns the original 401",
  async (status) => {
    fetchMock
      .mockResolvedValueOnce(json({ error: "expired" }, 401))
      .mockResolvedValueOnce(json({ error: "failed" }, status));
    await expect(api("/session", { role: "child" })).rejects.toMatchObject({
      status: 401,
      message: "expired",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(tokens.get("child")).toBeNull();
    expect(tokens.getRefresh("child")).toBeNull();
    expect(tokens.getRefresh("parent")).toBe("refresh-parent");
  },
);

test("a failed retry cannot trigger another refresh", async () => {
  fetchMock
    .mockResolvedValueOnce(json({ error: "expired" }, 401))
    .mockResolvedValueOnce(json({ token: "new-parent", refreshToken: "next-parent" }))
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
