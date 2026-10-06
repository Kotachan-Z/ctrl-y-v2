import { HTTPException } from "hono/http-exception";

// Bound attacker-controlled identifiers while allowing normal per-process traffic.
export const FAILURE_LIMITER_MAX_ENTRIES = 10_000;

// Per isolate only: multiple Workers isolates do not share these counters.
export function createFailureLimiter(countAll = false) {
  const entries = new Map<string, { failures: number; inFlight: number; expiresAt: number }>();
  // Insertion order tracks when entries became idle; eviction also checks lockout expiry.
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
        let victim: string | undefined;
        let fewestFailures = 5;
        for (const candidate of idle) {
          const idleEntry = entries.get(candidate)!;
          if (idleEntry.expiresAt <= now) {
            victim = candidate;
            break;
          }
          // Preserve accumulated failures over one-off throwaway identifiers.
          // Ties use the oldest idle entry.
          if (idleEntry.failures < fewestFailures) {
            victim = candidate;
            fewestFailures = idleEntry.failures;
          }
        }
        // Availability wins when every entry is locked (or still in flight).
        victim ??= idle.values().next().value ?? entries.keys().next().value;
        if (victim !== undefined) {
          idle.delete(victim);
          entries.delete(victim);
        }
      }
      entry = { failures: 0, inFlight: 0, expiresAt: now + duration };
      entries.set(key, entry);
    }
    // Expire on access; capacity pressure may release locks early.
    if (entry.expiresAt <= now) {
      entry.failures = 0;
      entry.expiresAt = now + duration;
    }
    if (entry.failures + (countAll ? 0 : entry.inFlight) >= 5) return reject();
    idle.delete(key);
    entry.inFlight += 1;
    if (countAll) entry.failures += 1;
    try {
      const response = await attempt();
      if (countAll) return response;
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
      if (entry.inFlight === 0 && entries.get(key) === entry) {
        if (entry.failures === 0) entries.delete(key);
        else idle.add(key);
      }
    }
  };
  return Object.assign(limit, { stateSizeForTesting: () => entries.size });
}
