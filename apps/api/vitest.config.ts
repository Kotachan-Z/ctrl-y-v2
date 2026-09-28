import { defineConfig } from "vitest/config";

import { vapidEnv } from "./test/vapid-fixture.js";
export default defineConfig({ test: { env: vapidEnv, include: ["test/**/*.spec.ts"] } });
