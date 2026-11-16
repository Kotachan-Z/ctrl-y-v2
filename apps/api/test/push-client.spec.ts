import { afterEach, expect, test, vi } from "vitest";

import { logout, tokens } from "../../web/src/api.js";

afterEach(() => vi.unstubAllGlobals());

test.each(["success", "delete", "unsubscribe", "lookup"])(
  "parent logout continues after push cleanup: %s",
  async (failure) => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      get length() {
        return storage.size;
      },
      key: (index: number) => [...storage.keys()][index],
    });
    vi.stubGlobal("window", { dispatchEvent: vi.fn() });
    const unsubscribe = vi.fn(async () => {
      if (failure === "unsubscribe") throw new Error("unavailable");
      return true;
    });
    vi.stubGlobal("navigator", {
      serviceWorker: {
        getRegistration: async () => {
          if (failure === "lookup") throw new Error("unavailable");
          return {
            pushManager: {
              getSubscription: async () => ({
                endpoint: "https://push.example.test/device",
                unsubscribe,
              }),
            },
          };
        },
      },
    });
    const send = vi.fn(async (path: string) => {
      if (path.endsWith("push-subscription") && failure === "delete")
        throw new TypeError("offline");
      return Response.json({ success: true });
    });
    vi.stubGlobal("fetch", send);
    tokens.set("parent", "parent-token", "refresh-token");
    await expect(logout("parent")).resolves.toBeUndefined();
    expect(tokens.get("parent")).toBeNull();
    expect(send).toHaveBeenCalledWith("/api/auth/logout", expect.anything());
    if (failure !== "lookup") {
      expect(unsubscribe).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledWith(
        "/api/parents/push-subscription",
        expect.objectContaining({
          method: "DELETE",
          body: JSON.stringify({ endpoint: "https://push.example.test/device" }),
        }),
      );
    }
  },
);

test("parent logout skips push cleanup when the subscription lock stays busy", async () => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    get length() {
      return storage.size;
    },
    key: (index: number) => [...storage.keys()][index],
  });
  vi.stubGlobal("window", { dispatchEvent: vi.fn() });
  const getRegistration = vi.fn();
  vi.stubGlobal("navigator", {
    serviceWorker: { getRegistration },
    locks: {
      // Another tab holds the subscription lock forever; the session lock is free.
      request: (
        name: string,
        options: { signal?: AbortSignal } | (() => Promise<unknown>),
        action?: () => Promise<unknown>,
      ) => {
        if (typeof options === "function") return options();
        if (name !== "ctrl-y.push-subscription") return action!();
        return new Promise((_resolve, reject) =>
          options.signal?.addEventListener("abort", () => reject(options.signal?.reason)),
        );
      },
    },
  });
  // Expire the wait immediately instead of after 10 seconds.
  vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
    const controller = new AbortController();
    queueMicrotask(() => controller.abort(new DOMException("Timed out", "TimeoutError")));
    return controller.signal;
  });
  const send = vi.fn(async () => Response.json({ success: true }));
  vi.stubGlobal("fetch", send);
  tokens.set("parent", "parent-token", "refresh-token");
  await expect(logout("parent")).resolves.toBeUndefined();
  expect(tokens.get("parent")).toBeNull();
  expect(send).toHaveBeenCalledWith("/api/auth/logout", expect.anything());
  expect(getRegistration).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});
