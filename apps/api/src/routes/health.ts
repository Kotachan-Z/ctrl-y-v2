import type { Hono } from "hono";

import type { AuthEnv } from "../auth.js";

export function registerHealthRoutes(app: Hono<AuthEnv>): void {
  app.get("/api/health", (c) => c.json({ status: "ok" }));
}
