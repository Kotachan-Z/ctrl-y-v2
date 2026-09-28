const CACHE_NAME = "ctrl-y-static-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      // Vite's built HTML names the hashed JS/CSS; cache them on the first visit too.
      const cache = await caches.open(CACHE_NAME);
      const shell = await fetch("/", { cache: "reload" });
      if (!shell.ok) throw new Error("App shell unavailable");
      const html = await shell.clone().text();
      const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)].map(
        (match) => match[1],
      );
      await cache.addAll([...new Set(["/icon.svg", "/manifest.webmanifest", ...assets])]);
      await cache.put("/", shell);
      await self.skipWaiting();
    })(),
  );
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith("ctrl-y-static-") && name !== CACHE_NAME)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname === "/api" ||
    url.pathname.startsWith("/api/")
  )
    return;
  const navigation = request.mode === "navigate";
  const asset = url.pathname.startsWith("/assets/");
  const metadata = ["/icon.svg", "/manifest.webmanifest"].includes(url.pathname);
  if (!navigation && !asset && !metadata) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // All routes share the same public SPA shell; no API data is stored here.
      const key = navigation ? "/" : request;
      if (asset && !navigation) {
        const cached = await cache.match(key);
        if (cached) return cached;
      }
      try {
        const response = await fetch(request, metadata ? { cache: "no-cache" } : undefined);
        if (response.ok) {
          // Storage failures must not turn a successful network response into an error.
          try {
            await cache.put(key, response.clone());
          } catch {
            /* Cache is best-effort. */
          }
        }
        return response;
      } catch {
        return (await cache.match(key)) ?? Response.error();
      }
    })(),
  );
});
self.addEventListener("push", (event) => {
  let payload;
  try {
    payload = event.data?.json();
  } catch {
    // Missing or malformed payloads still produce a useful notification.
  }
  const title = typeof payload?.title === "string" ? payload.title : "ご褒美ポケット";
  const body = typeof payload?.body === "string" ? payload.body : "タスクを確認してください";
  event.waitUntil(self.registration.showNotification(title, { body, icon: "/icon.svg" }));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const client = windows.find((window) => new URL(window.url).origin === self.location.origin);
      if (client) await client.focus();
      else await self.clients.openWindow("/");
    })(),
  );
});
