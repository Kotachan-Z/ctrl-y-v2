import { app } from "./server.js";
export default {
  hostname: "127.0.0.1",
  port: Number(process.env.API_PORT ?? 3000),
  fetch: app.fetch,
};
