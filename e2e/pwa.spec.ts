import { expect, test } from "@playwright/test";

test("manifest and service worker are available", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    "href",
    "/manifest.webmanifest",
  );
  const manifest = await request.get("/manifest.webmanifest");
  expect(manifest.ok()).toBeTruthy();
  expect(await manifest.json()).toMatchObject({
    name: "Ctrl-Y（ご褒美ポケット）",
    start_url: "/",
    display: "standalone",
    icons: [{ src: "/icon.svg", sizes: "any", purpose: "any maskable" }],
  });
  expect((await request.get("/icon.svg")).ok()).toBeTruthy();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration();
        return registration?.active?.scriptURL;
      }),
    )
    .toBe("http://127.0.0.1:5173/sw.js");
  await page.reload();
  await page.evaluate(async () => {
    await fetch("/api/health");
  });
  expect(
    await page.evaluate(async () => {
      const keys = await caches.keys();
      const requests = await Promise.all(keys.map(async (key) => (await caches.open(key)).keys()));
      return requests
        .flat()
        .some((cachedRequest) => new URL(cachedRequest.url).pathname.startsWith("/api/"));
    }),
  ).toBe(false);
});

test("parent can enable and disable notifications with a mocked push service", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ctrl-y.parent-token", "test-parent");
    let subscribed = false;
    const subscription = {
      toJSON: () => ({
        endpoint: "https://push.example.test/subscription",
        keys: { p256dh: "key", auth: "auth" },
      }),
      unsubscribe: () => {
        subscribed = false;
        return Promise.resolve(true);
      },
    };
    const registration = {
      pushManager: {
        getSubscription: () => Promise.resolve(subscribed ? subscription : null),
        subscribe: (options: PushSubscriptionOptionsInit) => {
          if (
            !(options.applicationServerKey instanceof Uint8Array) ||
            Array.from(options.applicationServerKey).join(",") !== "251,255,0"
          ) {
            throw new Error("Invalid base64url conversion");
          }
          subscribed = true;
          return Promise.resolve(subscription);
        },
      },
    };
    Object.defineProperty(navigator, "serviceWorker", {
      value: {
        register: () => Promise.resolve(registration),
        ready: Promise.resolve(registration),
      },
    });
    Object.defineProperty(window, "PushManager", { value: function () {} });
    Object.defineProperty(window, "Notification", {
      value: { requestPermission: () => Promise.resolve("granted") },
    });
  });
  await page.route("**/api/session", (route) =>
    route.fulfill({ json: { identity: { role: "parent", id: "parent" } } }),
  );
  await page.route("**/api/push/public-key", (route) =>
    route.fulfill({ json: { publicKey: "-_8A" } }),
  );
  const methods: string[] = [];
  await page.route("**/api/parents/push-subscription", async (route) => {
    methods.push(route.request().method());
    expect(route.request().headers().authorization).toBe("Bearer test-parent");
    if (route.request().method() === "PUT")
      expect(route.request().postDataJSON()).toEqual({
        endpoint: "https://push.example.test/subscription",
        keys: { p256dh: "key", auth: "auth" },
      });
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto("/settings/notifications");
  await page.getByRole("button", { name: "通知を有効にする" }).click();
  await expect(page.getByRole("status")).toHaveText("通知を有効にしました");
  await page.getByRole("button", { name: "通知を無効にする" }).click();
  await expect(page.getByRole("status")).toHaveText("通知を無効にしました");
  expect(methods).toEqual(["PUT", "DELETE"]);
});

test("PWA metadata refreshes online and falls back to cache offline", async ({ page, context }) => {
  await page.goto("/");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  const metadataPaths = ["/icon.svg", "/manifest.webmanifest"];
  const refreshed = await page.evaluate(async (paths) => {
    const cache = await caches.open("ctrl-y-static-v1");
    for (const path of paths) await cache.put(path, new Response("stale deployment"));
    return Promise.all(
      paths.map(async (path) => {
        const response = await fetch(path);
        return { ok: response.ok, text: await response.text() };
      }),
    );
  }, metadataPaths);
  for (const response of refreshed) {
    expect(response.ok).toBe(true);
    expect(response.text).not.toBe("stale deployment");
  }
  expect(refreshed[0].text).toContain("<svg");
  expect(JSON.parse(refreshed[1].text)).toMatchObject({ start_url: "/" });
  await context.setOffline(true);
  const offline = await page.evaluate(
    async (paths) => Promise.all(paths.map(async (path) => (await fetch(path)).text())),
    metadataPaths,
  );
  expect(offline).toEqual(refreshed.map((response) => response.text));
});
