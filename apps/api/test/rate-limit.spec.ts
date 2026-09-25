import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";

import { createApp } from "../src/server.js";
import { secret, testApp } from "./helpers.js";

let fixture: Awaited<ReturnType<typeof testApp>>;
beforeAll(async () => {
  fixture = await testApp();
}, 30_000);
afterAll(async () => {
  await fixture?.client.close();
});
afterEach(() => vi.restoreAllMocks());

const password = "password-123";
const keyword = "secret-word";

test.each(["register", "parent", "child"])(
  "%s blocks the sixth failure, isolates identifiers, and unlocks after 60 seconds",
  async (kind) => {
    const app = createApp({ repository: fixture.repository, jwtSecret: secret });
    const post = (path: string, data: unknown, token?: string) =>
      app.request(`/api${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(data),
      });
    const email = `${randomUUID()}@example.test`;
    const registration = await post("/parents", { email, password });
    const { token } = await registration.json();
    const setup = await post("/setup", { name: "はな", keyword }, token);
    const { child } = await setup.json();
    const path =
      kind === "register"
        ? "/parents"
        : kind === "parent"
          ? "/parents/login"
          : `/children/${child.id}/login`;
    const data =
      kind === "child" ? { keyword: "wrong-word" } : { email, password: "wrong-password" };
    const failure = kind === "register" ? 409 : 401;
    const start = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    for (let i = 0; i < 5; i += 1) {
      clock.mockReturnValue(start + i * 1000);
      expect((await post(path, data)).status).toBe(failure);
    }
    expect((await post(path, data)).status).toBe(429);
    // Even correct credentials remain blocked during lockout.
    expect((await post(path, kind === "child" ? { keyword } : { email, password })).status).toBe(
      429,
    );
    const other =
      kind === "child"
        ? await post(`/children/${randomUUID()}/login`, data)
        : await post(path, { email: `${randomUUID()}@example.test`, password });
    expect(other.status).toBe(kind === "register" ? 201 : 401);
    clock.mockReturnValue(start + 63_999);
    expect((await post(path, data)).status).toBe(429);
    clock.mockReturnValue(start + 64_000);
    expect((await post(path, data)).status).toBe(failure);
  },
  20_000,
);

test.each(["register", "parent", "child"])(
  "%s clears failures on success and expires incomplete failure windows",
  async (kind) => {
    const app = createApp({ repository: fixture.repository, jwtSecret: secret });
    const post = (path: string, data: unknown, token?: string) =>
      app.request(`/api${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(data),
      });
    const email = `${randomUUID()}@example.test`;
    const { token } = await (await post("/parents", { email, password })).json();
    const { child } = await (await post("/setup", { name: "はな", keyword }, token)).json();
    // Simulate a resolved registration conflict without deleting the fixture family.
    const register = vi.spyOn(fixture.repository, "register");
    const path =
      kind === "register"
        ? "/parents"
        : kind === "parent"
          ? "/parents/login"
          : `/children/${child.id}/login`;
    const data =
      kind === "child" ? { keyword: "wrong-word" } : { email, password: "wrong-password" };
    const failure = kind === "register" ? 409 : 401;
    const start = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    for (let i = 0; i < 4; i += 1) expect((await post(path, data)).status).toBe(failure);
    if (kind === "register")
      register.mockResolvedValueOnce(await fixture.repository.parentByEmail(email));
    expect((await post(path, kind === "child" ? { keyword } : { email, password })).status).toBe(
      kind === "register" ? 201 : 200,
    );
    for (let i = 0; i < 4; i += 1) expect((await post(path, data)).status).toBe(failure);
    clock.mockReturnValue(start + 60_000);
    for (let i = 0; i < 5; i += 1) expect((await post(path, data)).status).toBe(failure);
    expect((await post(path, data)).status).toBe(429);
  },
  20_000,
);
