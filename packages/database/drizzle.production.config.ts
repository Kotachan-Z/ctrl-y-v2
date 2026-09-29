import { defineConfig } from "drizzle-kit";

export default defineConfig({
  casing: "snake_case",
  dialect: "postgresql",
  dbCredentials: { url: process.env.PRODUCTION_DATABASE_URL ?? "" },
  migrations: { prefix: "timestamp" },
  out: "./migrations",
  schema: "./src/schema.ts",
});
