import { getRequestListener } from "@hono/node-server";
import { onRequest } from "firebase-functions/v2/https";

import { createApp } from "./server.js";

// Production Postgres wiring is intentionally deferred. Never use ephemeral
// Functions storage as the account database. Health remains available.
export const api = onRequest(
  { region: "asia-northeast1", secrets: ["JWT_SECRET"] },
  (request, response) => {
    const app = createApp({
      jwtSecret: process.env.JWT_SECRET ?? "",
      repository: () => {
        throw new Error("Production database adapter is not configured");
      },
    });
    return getRequestListener(app.fetch)(request, response);
  },
);
