import { AsyncLocalStorage } from "node:async_hooks";

import { createProductionDatabase } from "@ctrl-y/database/production";

import { createRepository, type AuthRepository } from "./repository.js";
import { createApp } from "./server.js";

export interface Env {
  ASSETS: Fetcher;
  HYPERDRIVE: Hyperdrive;
  JWT_SECRET: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_SUBJECT: string;
}

const requests = new AsyncLocalStorage<{
  repository: AuthRepository;
  pending: Promise<void>[];
}>();
function currentRequest() {
  const request = requests.getStore();
  if (!request) throw new Error("Repository accessed outside a Worker request");
  return request;
}
let app: ReturnType<typeof createApp> | undefined;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname !== "/api" && !pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    app ??= createApp({
      jwtSecret: env.JWT_SECRET ?? "",
      vapid: {
        publicKey: env.VAPID_PUBLIC_KEY ?? "",
        privateKey: env.VAPID_PRIVATE_KEY ?? "",
        subject: env.VAPID_SUBJECT ?? "",
      },
      repository: () => currentRequest().repository,
      backgroundTask: (task) => currentRequest().pending.push(task),
    });
    const handler = app;

    // Cache the app, never a connection that another request may close or use.
    const { db, sql } = createProductionDatabase(env.HYPERDRIVE);
    const pending: Promise<void>[] = [];
    try {
      return await requests.run({ repository: createRepository(db), pending }, () =>
        handler.fetch(request),
      );
    } finally {
      // Push rejection cleanup can still use the DB after the response is ready.
      ctx.waitUntil(Promise.allSettled(pending).then(() => sql.end()));
    }
  },
};
