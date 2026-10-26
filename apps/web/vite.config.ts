import { readFileSync } from "node:fs";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Serve the global `/*` rule of Cloudflare's _headers so `vite preview` matches production.
function productionHeaders() {
  const headers: Record<string, string> = {};
  let global = false;
  for (const line of readFileSync(new URL("./public/_headers", import.meta.url), "utf8").split(
    /\r?\n/,
  )) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      global = line.trim() === "/*";
      continue;
    }
    const match = /^\s+([^:]+):\s*(.+)$/.exec(line);
    if (global && match) headers[match[1].trim()] = match[2].trim();
  }
  return headers;
}

export default defineConfig(({ isPreview }) => ({
  plugins: [react(), tailwindcss()],
  preview: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    headers: isPreview ? productionHeaders() : undefined,
    proxy: { "/api": `http://127.0.0.1:${process.env.API_PORT ?? 3000}` },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/api": `http://127.0.0.1:${process.env.API_PORT ?? 3000}` },
  },
}));
