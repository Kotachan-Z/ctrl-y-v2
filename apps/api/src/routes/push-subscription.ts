import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import type { AuthEnv } from "../auth.js";
import { familyId, parentOnly } from "../auth.js";
import { isPublicPushHost } from "../lib/push-endpoint.js";
import { body, isRecord } from "../lib/request.js";
import type { RouteDeps } from "./types.js";

export function registerPushSubscriptionRoutes(app: Hono<AuthEnv>, deps: RouteDeps): void {
  const { repo, auth, vapid } = deps;
  app.get("/api/push/public-key", (c) => c.json({ publicKey: vapid.publicKey }));
  app.put("/api/parents/push-subscription", auth, parentOnly, async (c) => {
    const data = await body(c.req.raw);
    let endpoint: URL | undefined;
    try {
      if (typeof data.endpoint === "string") endpoint = new URL(data.endpoint);
    } catch {
      /* Invalid URLs are rejected below. */
    }
    if (
      !endpoint ||
      endpoint.protocol !== "https:" ||
      !isPublicPushHost(endpoint) ||
      endpoint.username ||
      endpoint.password ||
      typeof data.endpoint !== "string" ||
      /\s/.test(data.endpoint) ||
      !isRecord(data.keys) ||
      typeof data.keys.p256dh !== "string" ||
      !data.keys.p256dh.trim() ||
      typeof data.keys.auth !== "string" ||
      !data.keys.auth.trim()
    )
      throw new HTTPException(400, { message: "通知の購読情報を確認してください" });
    await repo().setPushSubscription(familyId(c.get("identity")), {
      endpoint: data.endpoint,
      keys: { p256dh: data.keys.p256dh, auth: data.keys.auth },
    });
    return c.json({ success: true });
  });
  app.delete("/api/parents/push-subscription", auth, parentOnly, async (c) => {
    await repo().setPushSubscription(familyId(c.get("identity")), null);
    return c.json({ success: true });
  });
}
