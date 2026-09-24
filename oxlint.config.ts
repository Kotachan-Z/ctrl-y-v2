import { defineConfig } from "oxlint";
export default defineConfig({
  categories: { correctness: "error", suspicious: "error" },
  rules: { "eslint/no-unused-vars": "error" },
  options: { typeAware: true, typeCheck: true },
  ignorePatterns: ["**/dist/**", "**/migrations/**", "playwright-report/**", "test-results/**"],
});
