import { HTTPException } from "hono/http-exception";

// Bound attacker-controlled identifiers while allowing normal per-process traffic.
export const FAILURE_LIMITER_MAX_ENTRIES = 10_000;

// Per process only: multiple Functions instances do not share these counters.
export function createFailureLimiter() {
  const entries = new Map<string, { failures: number; inFlight: number; expiresAt: number }>();
  // Insertion order tracks when entries became idle; active entries cannot be evicted.
  const idle = new Set<string>();
  const duration = 60_000;
  const reject = () => {
    throw new HTTPException(429, { message: "試行回数が多すぎます。60秒後に再試行してください" });
  };
  const limit = async <T extends Response>(key: string, attempt: () => Promise<T>) => {
    const now = Date.now();
    let entry = entries.get(key);
    if (!entry) {
      if (entries.size >= FAILURE_LIMITER_MAX_ENTRIES) {
        const oldest = idle.values().next();
        if (oldest.done) return reject();
        idle.delete(oldest.value);
        entries.delete(oldest.value);
      }
      entry = { failures: 0, inFlight: 0, expiresAt: now + duration };
      entries.set(key, entry);
    }
    // Expire on access, with constant-time capacity eviction instead of full scans.
    if (entry.expiresAt <= now) {
      entry.failures = 0;
      entry.expiresAt = now + duration;
    }
    if (entry.failures + entry.inFlight >= 5) return reject();
    idle.delete(key);
    entry.inFlight += 1;
    try {
      const response = await attempt();
      if (response.ok) entry.failures = 0;
      else if (response.status === 401 || response.status === 409) {
        const finishedAt = Date.now();
        if (entry.failures === 0 || entry.expiresAt <= finishedAt) {
          entry.failures = 0;
          entry.expiresAt = finishedAt + duration;
        }
        entry.failures += 1;
        if (entry.failures === 5) entry.expiresAt = finishedAt + duration;
      }
      return response;
    } finally {
      entry.inFlight -= 1;
      if (entry.inFlight === 0) {
        if (entry.failures === 0) entries.delete(key);
        else idle.add(key);
      }
    }
  };
  return Object.assign(limit, { stateSizeForTesting: () => entries.size });
}
