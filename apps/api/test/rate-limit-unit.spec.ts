import { HTTPException } from "hono/http-exception";
import { expect, test, vi } from "vitest";

import { createFailureLimiter, FAILURE_LIMITER_MAX_ENTRIES } from "../src/rate-limit.js";

const status = (error: unknown) => {
  if (error instanceof HTTPException) return error.status;
  throw error;
};
const respond401 = async () => new Response(null, { status: 401 });

test.each([401, 409])("reserves capacity before concurrent %s attempts", async (failure) => {
  const limit = createFailureLimiter();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const attempt = vi.fn(async () => {
    await gate;
    return new Response(null, { status: failure });
  });
  const pending = Promise.all(
    Array.from({ length: 20 }, () =>
      limit("same", attempt).then((response) => response.status, status),
    ),
  );
  expect(attempt).toHaveBeenCalledTimes(5);
  release();
  const results = await pending;
  expect(results.filter((value) => value === failure)).toHaveLength(5);
  expect(results.filter((value) => value === 429)).toHaveLength(15);
  await expect(limit("same", attempt)).rejects.toMatchObject({ status: 429 });
});

test("bounds stored identifiers and evicts the oldest idle entry", async () => {
  const limit = createFailureLimiter();
  for (let i = 0; i < FAILURE_LIMITER_MAX_ENTRIES + 25; i += 1) {
    await limit(String(i), async () => new Response(null, { status: 401 }));
    expect(limit.stateSizeForTesting()).toBeLessThanOrEqual(FAILURE_LIMITER_MAX_ENTRIES);
  }
  for (let i = 0; i < 5; i += 1) {
    expect((await limit("0", async () => new Response(null, { status: 401 }))).status).toBe(401);
  }
});

test("preserves an active lockout when throwaway identifiers force capacity eviction", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
  try {
    const limit = createFailureLimiter();
    const attempt = vi.fn(async () => new Response(null, { status: 401 }));
    for (let i = 0; i < 5; i += 1) {
      expect((await limit("X", attempt)).status).toBe(401);
    }
    await expect(limit("X", attempt)).rejects.toMatchObject({ status: 429 });
    for (let i = 0; i < FAILURE_LIMITER_MAX_ENTRIES + 25; i += 1) {
      expect((await limit(`throwaway-${i}`, attempt)).status).toBe(401);
    }
    expect(limit.stateSizeForTesting()).toBe(FAILURE_LIMITER_MAX_ENTRIES);
    attempt.mockClear();
    await expect(limit("X", attempt)).rejects.toMatchObject({ status: 429 });
    expect(attempt).not.toHaveBeenCalled();
  } finally {
    clock.mockRestore();
  }
});

test("admits new identifiers by evicting the oldest lock when all entries are locked", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
  try {
    const limit = createFailureLimiter();
    const attempt = vi.fn(async () => new Response(null, { status: 401 }));
    for (let i = 0; i < FAILURE_LIMITER_MAX_ENTRIES; i += 1) {
      for (let failure = 0; failure < 5; failure += 1) {
        await limit(String(i), attempt);
      }
    }
    attempt.mockClear();
    clock.mockReturnValue(60_999);
    expect((await limit("new", attempt)).status).toBe(401);
    await expect(limit("1", attempt)).rejects.toMatchObject({ status: 429 });
    expect((await limit("0", attempt)).status).toBe(401);
    expect(limit.stateSizeForTesting()).toBe(FAILURE_LIMITER_MAX_ENTRIES);
    clock.mockReturnValue(61_000);
    expect((await limit("new", attempt)).status).toBe(401);
    expect(limit.stateSizeForTesting()).toBe(FAILURE_LIMITER_MAX_ENTRIES);
  } finally {
    clock.mockRestore();
  }
});

test("releases reservations on exceptions and non-auth failures", async () => {
  const limit = createFailureLimiter();
  for (let i = 0; i < 10; i += 1) {
    await expect(
      limit("same", async () => {
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");
    await limit("same", async () => new Response(null, { status: 500 }));
  }
  expect(limit.stateSizeForTesting()).toBe(0);
});

test("keeps active reservations across success, expiration, and capacity pressure", async () => {
  const limit = createFailureLimiter();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = Array.from({ length: 4 }, () =>
    limit("active", async () => {
      await gate;
      return new Response(null, { status: 401 });
    }),
  );
  await limit("active", async () => new Response(null, { status: 200 }));
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
  try {
    for (let i = 0; i < FAILURE_LIMITER_MAX_ENTRIES + 25; i += 1) {
      await limit(String(i), async () => new Response(null, { status: 401 }));
    }
    await limit("active", async () => new Response(null, { status: 401 }));
    const attempt = vi.fn(async () => new Response());
    await expect(limit("active", attempt)).rejects.toMatchObject({ status: 429 });
    expect(attempt).not.toHaveBeenCalled();
    expect(limit.stateSizeForTesting()).toBe(FAILURE_LIMITER_MAX_ENTRIES);
  } finally {
    release();
    await Promise.all(pending);
    clock.mockRestore();
  }
});

test("preserves repeated failures below lockout during throwaway churn", async () => {
  const limit = createFailureLimiter();
  for (let i = 0; i < 4; i += 1) await limit("target", respond401);
  for (let i = 0; i < FAILURE_LIMITER_MAX_ENTRIES + 25; i += 1) {
    await limit(String(i), respond401);
  }
  await limit("target", respond401);
  await expect(limit("target", respond401)).rejects.toMatchObject({ status: 429 });
});

test.each([200, 401])(
  "evicted in-flight completion (%s) cannot mutate a replacement",
  async (code) => {
    const limit = createFailureLimiter();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = Array.from({ length: FAILURE_LIMITER_MAX_ENTRIES }, (_, i) =>
      limit(String(i), async () => {
        await gate;
        return new Response(null, { status: code });
      }),
    );
    try {
      await limit("new", respond401);
      for (let i = 0; i < 5; i += 1) await limit("0", respond401);
      expect(limit.stateSizeForTesting()).toBe(FAILURE_LIMITER_MAX_ENTRIES);
    } finally {
      release();
      await Promise.all(pending);
    }
    await expect(limit("0", respond401)).rejects.toMatchObject({ status: 429 });
    // Further eviction must not encounter stale idle keys from detached entries.
    for (let i = 0; i < FAILURE_LIMITER_MAX_ENTRIES; i += 1) await limit(`next-${i}`, respond401);
    expect(limit.stateSizeForTesting()).toBe(FAILURE_LIMITER_MAX_ENTRIES);
  },
);
