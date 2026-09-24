import { defineConfig } from "oxfmt";
export default defineConfig({
  printWidth: 100,
  semi: true,
  singleQuote: false,
  sortImports: {},
  trailingComma: "all",
  useTabs: false,
  ignorePatterns: [
    "**/dist/**",
    "**/migrations/**",
    "bun.lock",
    "playwright-report/**",
    "test-results/**",
  ],
});
