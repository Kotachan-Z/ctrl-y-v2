import { expect, test } from "vitest";

import { app } from "../src/server.js";
test("health returns ok", async () => {
  const response = await app.request("/health");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ok" });
});
