import { defineConfig } from "oxlint";
export default defineConfig({
  categories: { correctness: "error", suspicious: "error" },
  rules: {
    "eslint/no-unused-vars": "error",
    // React effects return a cleanup only on some paths, and Hono middleware returns a
    // Response only when it short-circuits; both are idiomatic.
    "typescript/consistent-return": "off",
  },
  options: { typeAware: true, typeCheck: true },
  ignorePatterns: ["**/dist/**", "**/migrations/**", "playwright-report/**", "test-results/**"],
});
