import { getRequestListener } from "@hono/node-server";
import { onRequest } from "firebase-functions/v2/https";

import { app } from "./server.js";
export const api = onRequest({ region: "asia-northeast1" }, getRequestListener(app.fetch));
