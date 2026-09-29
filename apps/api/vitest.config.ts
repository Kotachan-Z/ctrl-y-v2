import { defineConfig } from "vitest/config";

import { vapidEnv } from "./test/vapid-fixture.js";
export default defineConfig({
  // bcrypt (cost 12) makes auth-heavy tests slow under CI's shared/loaded runners;
  // the 5000ms default has been observed to flake there even though these pass
  // comfortably (well under 10s) on a normal local machine.
  test: { env: vapidEnv, include: ["test/**/*.spec.ts"], testTimeout: 20000 },
});
