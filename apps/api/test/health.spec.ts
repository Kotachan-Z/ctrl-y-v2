import { expect, test } from "vitest";

import { createApp } from "../src/server.js";
import { secret } from "./helpers.js";

test("health returns ok without opening a database", async () => {
  const app = createApp({
    jwtSecret: secret,
    repository: () => {
      throw new Error("Health must not access DB");
    },
  });
  const response = await app.request("/api/health");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ok" });
  expect((await app.request("/health")).status).toBe(404);
});
