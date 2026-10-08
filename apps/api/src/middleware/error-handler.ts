import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";

import type { AuthEnv } from "../auth.js";

// Drizzle reports driver failures as a generic "Failed query" and hides the real
// error in `cause`, which console.error does not serialize. Without unwrapping,
// a production outage looks identical whether the cause is bad credentials, a
// missing relation, or a dropped connection. Row data (`detail`) stays out of logs.
function causeChain(error: unknown): string {
  const chain: Record<string, unknown>[] = [];
  let current: unknown = error instanceof Error ? error.cause : undefined;
  while (current instanceof Error && chain.length < 5) {
    const extras: Record<string, unknown> = {};
    for (const key of ["code", "severity", "routine"]) {
      const value = Reflect.get(current, key);
      if (value !== undefined) extras[key] = value;
    }
    chain.push({ name: current.name, message: current.message, ...extras });
    current = current.cause;
  }
  return chain.length ? JSON.stringify(chain) : "none";
}

export const errorHandler: ErrorHandler<AuthEnv> = (error, c) => {
  if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
  console.error("API request failed", error, "cause:", causeChain(error));
  return c.json({ error: "サーバーエラーが発生しました" }, 500);
};
