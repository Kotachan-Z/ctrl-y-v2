import { AsyncLocalStorage } from "node:async_hooks";

import { createProductionDatabase } from "@ctrl-y/database/production";

import { createFailureLimiter } from "./rate-limit.js";
import { createRepository, type AuthRepository } from "./repository.js";
import { createApp } from "./server.js";

export interface Env {
  ASSETS: Fetcher;
  AUTH_RATE_LIMITER?: RateLimit;
  HYPERDRIVE: Hyperdrive;
  JWT_SECRET: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_SUBJECT: string;
}

// Retain identifier counters across requests in this isolate.
const failureLimiter = createFailureLimiter();

const requests = new AsyncLocalStorage<{
  repository: AuthRepository;
  pending: Promise<void>[];
}>();
function currentRequest() {
  const request = requests.getStore();
  if (!request) throw new Error("Repository accessed outside a Worker request");
  return request;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname !== "/api" && !pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    // Keep in sync with the three limit() routes in server.ts. One IP budget
    // spans all authentication routes, independent of identifiers and outcomes.
    const isAuthRequest =
      request.method === "POST" &&
      (pathname === "/api/parents" ||
        pathname === "/api/parents/login" ||
        /^\/api\/children\/[^/]+\/login$/.test(pathname));
    const ip = request.headers.get("CF-Connecting-IP");
    if (isAuthRequest && env.AUTH_RATE_LIMITER && ip) {
      const { success } = await env.AUTH_RATE_LIMITER.limit({ key: ip });
      if (!success) {
        return Response.json(
          { error: "試行回数が多すぎます。60秒後に再試行してください" },
          { status: 429, headers: { "Retry-After": "60", "Cache-Control": "no-store" } },
        );
      }
    }

    const app = createApp({
      failureLimiter,
      jwtSecret: env.JWT_SECRET ?? "",
      vapid: {
        publicKey: env.VAPID_PUBLIC_KEY ?? "",
        privateKey: env.VAPID_PRIVATE_KEY ?? "",
        subject: env.VAPID_SUBJECT ?? "",
      },
      repository: () => currentRequest().repository,
      backgroundTask: (task) => currentRequest().pending.push(task),
    });

    // Each request owns its connection and reads the current secret bindings.
    const { db, sql } = createProductionDatabase(env.HYPERDRIVE);
    const pending: Promise<void>[] = [];
    try {
      return await requests.run({ repository: createRepository(db), pending }, () =>
        app.fetch(request),
      );
    } finally {
      // Push rejection cleanup can still use the DB after the response is ready.
      ctx.waitUntil(Promise.allSettled(pending).then(() => sql.end()));
    }
  },
};
