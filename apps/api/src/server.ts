import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import { authenticate, type AuthEnv } from "./auth.js";
import { errorHandler } from "./middleware/error-handler.js";
import type { ResetMailConfig } from "./password-reset.js";
import { readVapidConfig, validateVapidConfig, type VapidConfig } from "./push.js";
import { createFailureLimiter } from "./rate-limit.js";
import type { AuthRepository } from "./repository.js";
import { registerAuthRoutes, registerSessionRoutes } from "./routes/auth.js";
import { registerChildRoutes } from "./routes/children.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerParentRoutes } from "./routes/parents.js";
import { registerPayrollRoutes } from "./routes/payroll.js";
import { registerPushSubscriptionRoutes } from "./routes/push-subscription.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import type { RouteDeps } from "./routes/types.js";

export function createApp(options: {
  repository: AuthRepository | (() => AuthRepository);
  jwtSecret: string;
  vapid?: VapidConfig;
  resetMail?: ResetMailConfig;
  resetLimit?: ReturnType<typeof createFailureLimiter>;
  backgroundTask?: (task: Promise<void>) => void;
  failureLimiter?: ReturnType<typeof createFailureLimiter>;
}) {
  if (new TextEncoder().encode(options.jwtSecret).length < 32)
    throw new Error("JWT_SECRET must be at least 32 bytes");
  const vapid = validateVapidConfig(options.vapid ?? readVapidConfig());
  const repo = () =>
    typeof options.repository === "function" ? options.repository() : options.repository;
  const auth = authenticate(options.jwtSecret, repo);
  const app = new Hono<AuthEnv>();
  const limit = options.failureLimiter ?? createFailureLimiter();
  const resetLimit = options.resetLimit ?? createFailureLimiter(true);
  app.onError(errorHandler);
  app.use(
    "/api/*",
    bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: "入力が大きすぎます" }, 413) }),
  );
  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  const deps: RouteDeps = {
    repo,
    auth,
    limit,
    resetLimit,
    vapid,
    jwtSecret: options.jwtSecret,
    resetMail: options.resetMail,
    backgroundTask: options.backgroundTask,
  };
  registerHealthRoutes(app);
  registerPushSubscriptionRoutes(app, deps);
  registerAuthRoutes(app, deps);
  registerParentRoutes(app, deps);
  registerChildRoutes(app, deps);
  registerPayrollRoutes(app, deps);
  registerTaskRoutes(app, deps);
  registerSessionRoutes(app, deps);
  return app;
}
