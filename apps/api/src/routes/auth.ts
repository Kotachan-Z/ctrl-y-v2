import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import type { AuthEnv } from "../auth.js";
import { hashRefreshToken, newRefreshToken, issueToken } from "../auth.js";
import { body } from "../lib/request.js";
import type { RouteDeps } from "./types.js";

export function registerAuthRoutes(app: Hono<AuthEnv>, deps: RouteDeps): void {
  const { repo, limit, jwtSecret } = deps;
  const refreshHash = async (request: Request) => {
    const { refreshToken } = await body(request);
    if (typeof refreshToken !== "string" || !refreshToken.length || refreshToken.length > 1024)
      throw new HTTPException(400, { message: "refresh tokenを確認してください" });
    return hashRefreshToken(refreshToken);
  };
  app.post("/api/auth/refresh", async (c) => {
    const tokenHash = await refreshHash(c.req.raw);
    return limit(`refresh:${tokenHash}`, async () => {
      const refresh = await newRefreshToken();
      const identity = await repo().rotateRefreshToken(tokenHash, refresh);
      if (!identity) return c.json({ error: "ログインし直してください" }, 401);
      return c.json({
        token: await issueToken(identity, jwtSecret),
        refreshToken: refresh.token,
      });
    });
  });
  app.post("/api/auth/logout", async (c) => {
    await repo().revokeRefreshToken(await refreshHash(c.req.raw));
    return c.json({ success: true });
  });
}

export function registerSessionRoutes(app: Hono<AuthEnv>, deps: RouteDeps): void {
  const { auth } = deps;
  // Used by guards to validate expiration, identity, and family membership server-side.
  app.get("/api/session", auth, (c) => c.json({ identity: c.get("identity") }));
}
