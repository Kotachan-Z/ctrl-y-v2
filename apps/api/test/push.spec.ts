import { buildPushPayload } from "@block65/webcrypto-web-push";
import { children, parents } from "@ctrl-y/database";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { issueToken } from "../src/auth.js";
import { notifyReview, readVapidConfig } from "../src/push.js";
import { secret, testApp } from "./helpers.js";
import { vapidEnv } from "./vapid-fixture.js";

vi.mock("@block65/webcrypto-web-push", () => ({ buildPushPayload: vi.fn() }));
const build = vi.mocked(buildPushPayload);
const send = vi.fn<typeof fetch>();
const payload: Awaited<ReturnType<typeof buildPushPayload>> = {
  method: "post",
  headers: {
    authorization: "vapid test",
    ttl: "2419200",
    urgency: "normal",
    "content-encoding": "aes128gcm",
    "content-length": "3",
    "content-type": "application/octet-stream",
  },
  body: new Uint8Array([1, 2, 3]),
};
const subscription = {
  endpoint: "https://push.example.test/subscription",
  keys: { p256dh: "test-browser-key", auth: "test-browser-auth" },
};
let fixture: Awaited<ReturnType<typeof testApp>>;
let parentId: string, childId: string, parent: string, child: string, otherId: string;
beforeAll(async () => {
  fixture = await testApp();
  const [p, q] = await fixture.db
    .insert(parents)
    .values([
      { email: "push@example.test", passwordHash: "unused" },
      { email: "other-push@example.test", passwordHash: "unused" },
    ])
    .returning();
  parentId = p.id;
  otherId = q.id;
  const [c] = await fixture.db.insert(children).values({ parentId, name: "子供" }).returning();
  childId = c.id;
  parent = await issueToken({ role: "parent", id: parentId }, secret);
  child = await issueToken({ role: "child", id: childId, parentId }, secret);
}, 30000);
afterAll(async () => {
  await fixture?.client.close();
});
beforeEach(async () => {
  build.mockReset();
  build.mockResolvedValue(payload);
  send.mockReset();
  send.mockResolvedValue(new Response(null, { status: 201 }));
  vi.stubGlobal("fetch", send);
  await fixture.repository.setPushSubscription(parentId, null);
});
afterEach(() => {
  vi.unstubAllGlobals();
});
function request(path: string, method = "GET", token = parent, data?: unknown) {
  return fixture.app.request(`/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
}
const stored = async () => (await fixture.repository.parentById(parentId))?.pushSubscription;
async function task() {
  const record = await fixture.repository.createTask(parentId, {
    name: "おそうじ",
    reward: 100,
    deadline: new Date("2027-01-01"),
  });
  expect(
    (await request(`/tasks/${record.id}/status`, "PATCH", child, { status: "IN_PROGRESS" })).status,
  ).toBe(200);
  return record.id;
}
const submit = (id: string, token = child) =>
  request(`/tasks/${id}/status`, "PATCH", token, { status: "WAIT_REVIEW" });

test("public key is available without authentication and never includes private configuration", async () => {
  const response = await request("/push/public-key", "GET", "");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ publicKey: vapidEnv.VAPID_PUBLIC_KEY });
});
test("subscription writes require a parent and affect only that parent", async () => {
  await fixture.repository.setPushSubscription(otherId, subscription);
  for (const method of ["PUT", "DELETE"]) {
    expect((await request("/parents/push-subscription", method, "", subscription)).status).toBe(
      401,
    );
    expect((await request("/parents/push-subscription", method, child, subscription)).status).toBe(
      403,
    );
  }
  expect(await stored()).toBeNull();
  for (const endpoint of [subscription.endpoint, `${subscription.endpoint}/replacement`]) {
    expect(
      (
        await request("/parents/push-subscription", "PUT", parent, {
          ...subscription,
          endpoint,
          expirationTime: null,
        })
      ).status,
    ).toBe(200);
    expect(await stored()).toEqual({ ...subscription, endpoint });
  }
  for (let i = 0; i < 2; i++) {
    expect((await request("/parents/push-subscription", "DELETE")).status).toBe(200);
    expect(await stored()).toBeNull();
  }
  expect((await fixture.repository.parentById(otherId))?.pushSubscription).toEqual(subscription);
});
test("invalid subscription bodies are rejected without changing storage", async () => {
  await fixture.repository.setPushSubscription(parentId, subscription);
  for (const data of [
    null,
    [],
    {},
    { endpoint: subscription.endpoint },
    { ...subscription, endpoint: 1 },
    { ...subscription, endpoint: "not a URL" },
    { ...subscription, endpoint: "http://push.example.test" },
    { ...subscription, keys: null },
    { ...subscription, keys: [] },
    { ...subscription, keys: { p256dh: "", auth: "a" } },
    { ...subscription, keys: { p256dh: "key", auth: " " } },
    { ...subscription, keys: { p256dh: 1, auth: "a" } },
    { ...subscription, keys: { p256dh: "key" } },
  ])
    expect((await request("/parents/push-subscription", "PUT", parent, data)).status).toBe(400);
  expect(
    (
      await fixture.app.request("/api/parents/push-subscription", {
        method: "PUT",
        headers: { Authorization: `Bearer ${parent}` },
        body: "{",
      })
    ).status,
  ).toBe(400);
  expect(await stored()).toEqual(subscription);
});
test("only a successful child submission sends once, not duplicate submissions or parent reopens", async () => {
  await fixture.repository.setPushSubscription(parentId, subscription);
  const id = await task();
  expect(send).not.toHaveBeenCalled();
  expect((await submit(id, parent)).status).toBe(403);
  expect((await submit(id)).status).toBe(200);
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  expect(build).toHaveBeenCalledWith(
    {
      data: JSON.stringify({ title: "レビュー待ち", body: "おそうじ が完了報告されました" }),
      options: { ttl: 2419200, urgency: "normal" },
    },
    { ...subscription, expirationTime: null },
    readVapidConfig(),
  );
  expect(send).toHaveBeenCalledWith(subscription.endpoint, {
    ...payload,
    redirect: "manual",
    signal: expect.any(AbortSignal),
  });
  expect((await submit(id)).status).toBe(409);
  expect((await request(`/tasks/${id}/status`, "PATCH", parent, { status: "DONE" })).status).toBe(
    200,
  );
  expect((await submit(id, parent)).status).toBe(200);
  expect(send).toHaveBeenCalledTimes(1);
});
test("redirect responses are not followed and preserve the subscription", async () => {
  await fixture.repository.setPushSubscription(parentId, subscription);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    // Fetch's opaque redirect response cannot be constructed with ResponseInit.
    const redirect = Response.error();
    Object.defineProperty(redirect, "type", { value: "opaqueredirect" });
    send.mockResolvedValue(redirect);
    await expect(
      notifyReview(fixture.repository, readVapidConfig(), parentId, "task"),
    ).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledExactlyOnceWith(subscription.endpoint, {
      ...payload,
      redirect: "manual",
      signal: expect.any(AbortSignal),
    });
    expect(warn).toHaveBeenCalledExactlyOnceWith("Push delivery failed", 0);
    expect(await stored()).toEqual(subscription);
  } finally {
    warn.mockRestore();
  }
});
test("no subscription means no delivery", async () => {
  expect((await submit(await task())).status).toBe(200);
  await notifyReview(fixture.repository, readVapidConfig(), parentId, "おそうじ");
  expect(send).not.toHaveBeenCalled();
});
test.each([404, 410, 429, 500])(
  "provider status %i is best-effort and only dead subscriptions are removed",
  async (statusCode) => {
    await fixture.repository.setPushSubscription(parentId, subscription);
    send.mockResolvedValue(new Response(null, { status: statusCode }));
    expect((await submit(await task())).status).toBe(200);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    if (statusCode === 404 || statusCode === 410)
      await vi.waitFor(async () => expect(await stored()).toBeNull());
    else expect(await stored()).toEqual(subscription);
  },
);
test("a pending push does not delay the response and its late response preserves a replacement", async () => {
  await fixture.repository.setPushSubscription(parentId, subscription);
  let resolve!: (response: Response) => void;
  send.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  expect((await submit(await task())).status).toBe(200);
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  const replacement = { ...subscription, keys: { ...subscription.keys, auth: "new-auth" } };
  await fixture.repository.setPushSubscription(parentId, replacement);
  const cleanup = vi.spyOn(fixture.repository, "clearPushSubscriptionIfUnchanged");
  resolve(new Response(null, { status: 410 }));
  await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
  await cleanup.mock.results[0].value;
  expect(await stored()).toEqual(replacement);
  cleanup.mockRestore();
});
test("payload construction failures never reject notification work or clear the subscription", async () => {
  await fixture.repository.setPushSubscription(parentId, subscription);
  build.mockRejectedValueOnce(new Error("invalid key"));
  await expect(
    notifyReview(fixture.repository, readVapidConfig(), parentId, "task"),
  ).resolves.toBeUndefined();
  expect(send).not.toHaveBeenCalled();
  expect(await stored()).toEqual(subscription);
});
test("network, lookup and cleanup failures never reject notification work", async () => {
  await fixture.repository.setPushSubscription(parentId, subscription);
  send.mockRejectedValue(new Error("offline"));
  await expect(
    notifyReview(fixture.repository, readVapidConfig(), parentId, "task"),
  ).resolves.toBeUndefined();
  expect(await stored()).toEqual(subscription);
  const lookup = vi
    .spyOn(fixture.repository, "parentById")
    .mockRejectedValueOnce(new Error("database unavailable"));
  await expect(
    notifyReview(fixture.repository, readVapidConfig(), parentId, "task"),
  ).resolves.toBeUndefined();
  lookup.mockRestore();
  send.mockResolvedValue(new Response(null, { status: 410 }));
  const cleanup = vi
    .spyOn(fixture.repository, "clearPushSubscriptionIfUnchanged")
    .mockRejectedValueOnce(new Error("database unavailable"));
  await expect(
    notifyReview(fixture.repository, readVapidConfig(), parentId, "task"),
  ).resolves.toBeUndefined();
  cleanup.mockRestore();
  expect(await stored()).toEqual(subscription);
});
test("VAPID configuration rejects missing and malformed secrets without fallback", () => {
  for (const name of ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"])
    for (const value of [undefined, "", "invalid"])
      expect(() => readVapidConfig({ ...vapidEnv, [name]: value })).toThrow(name);
  for (const subject of ["http://example.test", "mailto:", "mailto:not-an-email", "https://"])
    expect(() => readVapidConfig({ ...vapidEnv, VAPID_SUBJECT: subject })).toThrow("VAPID_SUBJECT");
  expect(
    readVapidConfig({ ...vapidEnv, VAPID_SUBJECT: "https://example.test/contact" }).subject,
  ).toBe("https://example.test/contact");
});

test.each([
  "127.0.0.1",
  "127.255.255.255",
  "127.1",
  "2130706433",
  "0x7f000001",
  "10.0.0.1",
  "172.16.0.1",
  "172.31.255.255",
  "192.168.1.1",
  "169.254.169.254",
  "0.0.0.0",
  "100.64.0.1",
  "192.0.2.1",
  "198.18.0.1",
  "198.51.100.1",
  "203.0.113.1",
  "224.0.0.1",
  "255.255.255.255",
  "[::]",
  "[::1]",
  "[::ffff:127.0.0.1]",
  "[::ffff:10.0.0.1]",
  "[fc00::1]",
  "[fd00::1]",
  "[fe80::1]",
  "[febf::1]",
  "[ff02::1]",
  "[2001:db8::1]",
  "[2002:7f00:1::]",
  "[2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff]",
  "[3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff]",
  "[4000::]",
  "[::ffff:8.8.8.8]",
  "[2606::4700::1111]",
  "[2606:4700:4700:0:0:0:0:0:1111]",
  "[2606:4700:4700:0:0:0:1111]",
  "[2606:4700:4700::12345]",
  "[2606:4700:4700::gggg]",
  "[2606:4700:4700:0:0:0:0::1111]",
  "[2606:4700:4700::192.0.2.999]",
  "localhost",
  "LOCALHOST.",
  "push.local",
  "push.local.",
  "push.localhost",
  "push.internal",
])("non-public push host %s is rejected without changing storage", async (host) => {
  await fixture.repository.setPushSubscription(parentId, subscription);
  expect(
    (
      await request("/parents/push-subscription", "PUT", parent, {
        ...subscription,
        endpoint: `https://${host}:8443/internal`,
      })
    ).status,
  ).toBe(400);
  expect(await stored()).toEqual(subscription);
});
test.each([
  "push.example.com",
  "8.8.8.8",
  "[2606:4700:4700::1111]",
  "[2606:4700:4700:0:0:0:0:1111]",
  "[2606:4700:4700::192.0.2.1]",
  "[2001:200::]",
  "[3fff:1000::]",
  "[3ffe:ffff:ffff:ffff:ffff:ffff:ffff:ffff]",
])("public HTTPS push host %s is accepted", async (host) => {
  const value = { ...subscription, endpoint: `https://${host}/subscription` };
  expect((await request("/parents/push-subscription", "PUT", parent, value)).status).toBe(200);
  expect(await stored()).toEqual(value);
});
