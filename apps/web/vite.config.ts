import { readFileSync } from "node:fs";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
function productionHeaders() {
  const lines = readFileSync(new URL("./public/_headers", import.meta.url), "utf8")
    .trim()
    .split("\n");
  if (lines.shift() !== "/*") throw new Error("_headers の全体ルールが必要です");
  return Object.fromEntries(
    lines.map((line) => {
      const match = /^\s+([^:]+):\s*(.+)$/.exec(line);
      if (!match) throw new Error("_headers の形式に対応していません");
      return [match[1], match[2]];
    }),
  );
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  preview: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    headers: productionHeaders(),
    proxy: { "/api": `http://127.0.0.1:${process.env.API_PORT ?? 3000}` },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/api": `http://127.0.0.1:${process.env.API_PORT ?? 3000}` },
  },
});
