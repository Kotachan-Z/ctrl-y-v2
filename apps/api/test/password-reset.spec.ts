import { parents } from "@ctrl-y/database";
import { hash } from "bcryptjs";
import { eq } from "drizzle-orm";
import { sign, verify } from "hono/jwt";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";

import { issueToken } from "../src/auth.js";
import { issueResetToken, sendResetEmail, tokenDigest } from "../src/password-reset.js";
import { createApp } from "../src/server.js";
import { secret, testApp } from "./helpers.js";

let fixture: Awaited<ReturnType<typeof testApp>>;
beforeAll(async () => {
  fixture = await testApp();
}, 30_000);
afterAll(async () => {
  await fixture?.client.close();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function app() {
  return createApp({
    repository: fixture.repository,
    jwtSecret: secret,
    resetMail: { local: true, webOrigin: "http://127.0.0.1:5173" },
  });
}
function post(api: ReturnType<typeof app>, action: string, body: unknown) {
  return api.request(`/api/parents/password-reset/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
async function parent() {
  return (await fixture.repository.register(
    `${crypto.randomUUID()}@example.test`,
    await hash("old-password", 4),
  ))!;
}
async function savedToken(id: string) {
  const { token, expiresAt } = await issueResetToken(id, secret);
  await fixture.repository.savePasswordReset(id, await tokenDigest(token), expiresAt);
  return token;
}
test("normalized requests conceal existence, log locally, replace old links and limit successes", async () => {
  const p = await parent();
  const api = app();
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  const result = await post(api, "request", { email: ` ${p.email.toUpperCase()} ` });
  const missing = await post(api, "request", { email: "missing@example.test" });
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual(await missing.json());
  expect(log).toHaveBeenCalledTimes(1);
  const link = String(log.mock.calls[0][1]);
  const token = new URL(link).pathname.split("/").at(-1)!;
  const claims = await verify(token, secret, "HS256");
  expect(claims).toMatchObject({ role: "parent", purpose: "reset", aud: "ctrl-y-password-reset" });
  expect(Number(claims.exp) - Number(claims.iat)).toBe(900);
  expect((await fixture.repository.parentById(p.id))?.passwordResetHash).toBe(
    await tokenDigest(token),
  );
  expect(
    (await api.request("/api/session", { headers: { Authorization: `Bearer ${token}` } })).status,
  ).toBe(401);
  await post(api, "request", { email: p.email });
  expect((await post(api, "confirm", { token, password: "new-password" })).status).toBe(401);
  for (let i = 0; i < 3; i++)
    expect((await post(api, "request", { email: p.email })).status).toBe(200);
  expect((await post(api, "request", { email: p.email })).status).toBe(429);
});
test("only one concurrent confirmation succeeds and only new password logs in", async () => {
  const p = await parent();
  const token = await savedToken(p.id);
  const api = app();
  const responses = await Promise.all([
    post(api, "confirm", { token, password: "new-password" }),
    post(api, "confirm", { token, password: "new-password" }),
  ]);
  expect(responses.map((r) => r.status)).toEqual(expect.arrayContaining([200, 401]));
  expect((await fixture.repository.parentById(p.id))?.passwordResetHash).toBeNull();
  for (const [password, status] of [
    ["old-password", 401],
    ["new-password", 200],
  ] as const) {
    const result = await api.request("/api/parents/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: p.email, password }),
    });
    expect(result.status).toBe(status);
  }
});
test("access, tampered, expired and invalid claims cannot reset passwords", async () => {
  const p = await parent();
  const token = await savedToken(p.id);
  const claims = await verify(token, secret, "HS256");
  const variants = [await issueToken({ role: "parent", id: p.id }, secret), `${token}x`];
  for (const change of [
    { exp: 1 },
    { purpose: "access" },
    { role: "child" },
    { iss: "other" },
    { aud: "ctrl-y-api" },
    { jti: "bad" },
    { iat: Math.floor(Date.now() / 1000) + 60 },
  ])
    variants.push(await sign({ ...claims, ...change }, secret, "HS256"));
  for (const invalid of variants)
    expect(
      (await post(app(), "confirm", { token: invalid, password: "new-password" })).status,
    ).toBe(401);
  await fixture.db
    .update(parents)
    .set({ passwordResetExpiresAt: new Date(0) })
    .where(eq(parents.id, p.id));
  expect((await post(app(), "confirm", { token, password: "new-password" })).status).toBe(401);
});
test("validation and confirmation rate limits apply even to malformed input", async () => {
  const api = app();
  expect((await post(api, "request", { email: "bad" })).status).toBe(400);
  for (let i = 0; i < 5; i++)
    expect((await post(api, "confirm", { token: "bad", password: "short" })).status).toBe(400);
  expect((await post(api, "confirm", { token: "bad", password: "new-password" })).status).toBe(429);
  for (let i = 0; i < 5; i++)
    expect((await post(api, "confirm", { password: "new-password" })).status).toBe(401);
  expect((await post(api, "confirm", { token: 123, password: "new-password" })).status).toBe(429);
  const p = await parent();
  const token = await savedToken(p.id);
  expect((await post(api, "confirm", { token, password: "あ".repeat(25) })).status).toBe(400);
  expect((await post(api, "confirm", { token, password: "new-password" })).status).toBe(200);
});
test("exhausting one valid token does not block another family", async () => {
  const first = await parent();
  const second = await parent();
  const firstToken = await savedToken(first.id);
  const secondToken = await savedToken(second.id);
  const api = app();
  for (let i = 0; i < 5; i++)
    expect((await post(api, "confirm", { token: firstToken, password: "short" })).status).toBe(400);
  expect((await post(api, "confirm", { token: firstToken, password: "new-password" })).status).toBe(
    429,
  );
  expect(
    (await post(api, "confirm", { token: secondToken, password: "new-password" })).status,
  ).toBe(200);
});
test.each(["rejected", "timeout"])(
  "failed delivery preserves the previous link: %s",
  async (failure) => {
    const p = await parent();
    const token = await savedToken(p.id);
    const before = await fixture.repository.parentById(p.id);
    const fetchMock = vi.fn<typeof fetch>();
    if (failure === "rejected") fetchMock.mockResolvedValue(new Response("", { status: 500 }));
    else fetchMock.mockRejectedValue(new DOMException("Timed out", "TimeoutError"));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const api = createApp({
      repository: fixture.repository,
      jwtSecret: secret,
      resetMail: {
        apiKey: "test-key",
        from: "reset@example.test",
        webOrigin: "https://example.test",
      },
    });
    expect((await post(api, "request", { email: p.email })).status).toBe(200);
    const after = await fixture.repository.parentById(p.id);
    expect(after?.passwordResetHash).toBe(before?.passwordResetHash);
    expect(after?.passwordResetExpiresAt).toEqual(before?.passwordResetExpiresAt);
    expect((await post(api, "confirm", { token, password: "new-password" })).status).toBe(200);
  },
);
test("background delivery responds before sending finishes and then saves the token", async () => {
  const p = await parent();
  const previousToken = await savedToken(p.id);
  let finish!: (response: Response) => void;
  const delivery = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockReturnValue(delivery));
  const pending: Promise<void>[] = [];
  const api = createApp({
    repository: fixture.repository,
    jwtSecret: secret,
    resetMail: {
      apiKey: "test-key",
      from: "reset@example.test",
      webOrigin: "https://example.test",
    },
    backgroundTask: (task) => {
      pending.push(task);
    },
  });
  try {
    const existing = await post(api, "request", { email: p.email });
    const missing = await post(api, "request", { email: "background-missing@example.test" });
    expect(existing.status).toBe(200);
    expect(await existing.json()).toEqual(await missing.json());
    expect((await fixture.repository.parentById(p.id))?.passwordResetHash).toBe(
      await tokenDigest(previousToken),
    );
  } finally {
    finish(new Response("{}", { status: 200 }));
    await Promise.all(pending);
  }
  expect((await fixture.repository.parentById(p.id))?.passwordResetHash).not.toBe(
    await tokenDigest(previousToken),
  );
});
test("Resend HTTP request and failures never expose account existence", async () => {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const config = {
    apiKey: "test-key",
    from: "reset@example.test",
    webOrigin: "https://example.test",
  };
  await sendResetEmail("parent@example.test", "token", config);
  expect(fetchMock).toHaveBeenCalledWith(
    "https://api.resend.com/emails",
    expect.objectContaining({
      method: "POST",
      headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
      body: expect.stringContaining("https://example.test/reset-password/token"),
    }),
  );
  fetchMock.mockResolvedValue(new Response("provider-secret", { status: 500 }));
  vi.spyOn(console, "error").mockImplementation(() => {});
  const p = await parent();
  const api = createApp({ repository: fixture.repository, jwtSecret: secret, resetMail: config });
  const result = await post(api, "request", { email: p.email });
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual(
    await (await post(api, "request", { email: "absent@example.test" })).json(),
  );
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  await expect(
    sendResetEmail(p.email, "secret-token", { webOrigin: "https://example.test" }),
  ).rejects.toThrow("Missing RESEND");
  expect(log).not.toHaveBeenCalled();
  await expect(
    sendResetEmail(p.email, "token", { ...config, webOrigin: "http://evil.test" }),
  ).rejects.toThrow("Invalid WEB_ORIGIN");
});
