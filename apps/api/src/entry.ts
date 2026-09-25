import { createLocalDatabase } from "@ctrl-y/database/local";

import { createRepository } from "./repository.js";
import { createApp } from "./server.js";
const { db } = createLocalDatabase();
const app = createApp({
  repository: createRepository(db),
  jwtSecret: process.env.JWT_SECRET ?? "",
});
export default {
  hostname: "127.0.0.1",
  port: Number(process.env.API_PORT ?? 3000),
  fetch: app.fetch,
};
