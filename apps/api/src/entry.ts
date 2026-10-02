import { createLocalDatabase } from "@ctrl-y/database/local";

import { createRepository } from "./repository.js";
import { createApp } from "./server.js";
const { db } = createLocalDatabase();
const app = createApp({
  repository: createRepository(db),
  resetMail: {
    apiKey: process.env.RESEND_API_KEY,
    from: process.env.RESEND_FROM_EMAIL,
    webOrigin: process.env.WEB_ORIGIN ?? "http://127.0.0.1:5173",
    local: true,
  },
  jwtSecret: process.env.JWT_SECRET ?? "",
});
export default {
  hostname: "127.0.0.1",
  port: Number(process.env.API_PORT ?? 3000),
  fetch: app.fetch,
};
