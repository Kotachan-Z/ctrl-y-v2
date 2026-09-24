import { HTTPException } from "hono/http-exception";

// Per process only: multiple Functions instances do not share these counters.
export function createFailureLimiter() {
  const entries = new Map<string, { failures: number; expiresAt: number }>();
  const duration = 60_000;
  return async function limit<T extends Response>(key: string, attempt: () => Promise<T>) {
    const now = Date.now();
    // Remove expired identifiers so inactive accounts do not accumulate forever.
    for (const [id, entry] of entries) {
      if (entry.expiresAt <= now) entries.delete(id);
    }
    const entry = entries.get(key);
    if (entry && entry.failures >= 5) {
      throw new HTTPException(429, { message: "試行回数が多すぎます。60秒後に再試行してください" });
    }
    const response = await attempt();
    if (response.ok) entries.delete(key);
    else if (response.status === 401 || response.status === 409) {
      const finishedAt = Date.now();
      const current = entries.get(key);
      const next =
        current && current.expiresAt > finishedAt
          ? current
          : { failures: 0, expiresAt: finishedAt + duration };
      next.failures += 1;
      if (next.failures === 5) next.expiresAt = finishedAt + duration;
      entries.set(key, next);
    }
    return response;
  };
}
