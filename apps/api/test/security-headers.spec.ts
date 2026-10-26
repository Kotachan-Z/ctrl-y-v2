import { readFile } from "node:fs/promises";

import { expect, test, vi } from "vitest";

import { createApp } from "../src/server.js";
import { secret } from "./helpers.js";

function app() {
  return createApp({
    jwtSecret: secret,
    repository: () => {
      throw new Error("Unexpected database access");
    },
  });
}

function expectHeaders(response: Response) {
  expect(response.headers.get("Content-Security-Policy")).toBe(
    "default-src 'none'; frame-ancestors 'none'",
  );
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  expect(response.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  expect(response.headers.get("Permissions-Policy")).toBe(
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  );
}

test.each([
  ["/api/health", 200],
  ["/api/missing", 404],
  ["/missing", 404],
  ["/api/session", 401],
] as const)("security headers cover %s", async (path, status) => {
  const response = await app().request(`https://example.test${path}`);
  expect(response.status).toBe(status);
  expectHeaders(response);
  expect(response.headers.get("Strict-Transport-Security")).toBe("max-age=31536000");
});

test("body limit and unexpected errors retain security headers", async () => {
  const api = app();
  const oversized = await api.request("https://example.test/api/parents", {
    method: "POST",
    body: "a".repeat(17 * 1024),
  });
  expect(oversized.status).toBe(413);
  expectHeaders(oversized);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const failed = await api.request("https://example.test/api/parents/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "headers@example.test", password: "password123" }),
    });
    expect(failed.status).toBe(500);
    expectHeaders(failed);
  } finally {
    log.mockRestore();
  }
});

test("local HTTP API does not enable HSTS", async () => {
  const response = await app().request("http://localhost/api/health");
  expectHeaders(response);
  expect(response.headers.has("Strict-Transport-Security")).toBe(false);
});

test("static assets have a global Cloudflare header rule with a restricted Web CSP", async () => {
  const rules = await readFile(new URL("../../web/public/_headers", import.meta.url), "utf8");
  expect(rules.split("\n")[0]).toBe("/*");
  const csp = rules.match(/Content-Security-Policy: (.+)/)?.[1];
  expect(csp?.split("; ")).toEqual([
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self'",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ]);
  expect(rules).toContain("Strict-Transport-Security: max-age=31536000\n");
  const response = await app().request("https://example.test/api/health");
  expect(response.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
  expect(rules).toContain("Cross-Origin-Opener-Policy: same-origin\n");
  expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
  expect(rules).toContain("Cross-Origin-Resource-Policy: same-origin\n");
  expect(response.headers.get("Origin-Agent-Cluster")).toBe("?1");
  expect(rules).toContain("Origin-Agent-Cluster: ?1\n");
  expect(response.headers.get("X-DNS-Prefetch-Control")).toBe("off");
  expect(rules).toContain("X-DNS-Prefetch-Control: off\n");
  expect(response.headers.get("X-Download-Options")).toBe("noopen");
  expect(rules).toContain("X-Download-Options: noopen\n");
  expect(response.headers.get("X-Permitted-Cross-Domain-Policies")).toBe("none");
  expect(rules).toContain("X-Permitted-Cross-Domain-Policies: none\n");
  expect(response.headers.get("X-XSS-Protection")).toBe("0");
  expect(rules).toContain("X-XSS-Protection: 0\n");
  expect(rules).toContain("X-Content-Type-Options: nosniff");
  expect(rules).toContain("X-Frame-Options: DENY");
  expect(rules).toContain("Referrer-Policy: strict-origin-when-cross-origin");
  expect(rules).toContain(
    "Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  );
});
