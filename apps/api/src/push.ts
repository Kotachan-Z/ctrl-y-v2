import { buildPushPayload, type PushMessage } from "@block65/webcrypto-web-push";

import type { AuthRepository, PushSubscription } from "./repository.js";

export type VapidConfig = { publicKey: string; privateKey: string; subject: string };

export function readVapidConfig(env: NodeJS.ProcessEnv = process.env): VapidConfig {
  return validateVapidConfig({
    publicKey: env.VAPID_PUBLIC_KEY ?? "",
    privateKey: env.VAPID_PRIVATE_KEY ?? "",
    subject: env.VAPID_SUBJECT ?? "",
  });
}

const key = (value: string, bytes: number) =>
  /^[A-Za-z0-9_-]+$/.test(value) &&
  Buffer.from(value, "base64url").length === bytes &&
  Buffer.from(value, "base64url").toString("base64url") === value;

export function validateVapidConfig(config: VapidConfig): VapidConfig {
  if (!key(config.publicKey, 65) || Buffer.from(config.publicKey, "base64url")[0] !== 4)
    throw new Error("VAPID_PUBLIC_KEY must be a base64url-encoded 65-byte uncompressed P-256 key");
  if (!key(config.privateKey, 32))
    throw new Error("VAPID_PRIVATE_KEY must be a base64url-encoded 32-byte private key");
  let contact: URL;
  try {
    contact = new URL(config.subject);
  } catch {
    throw new Error("VAPID_SUBJECT must be a mailto: or https: contact URI");
  }
  if (
    /\s/.test(config.subject) ||
    !(
      (contact.protocol === "https:" &&
        contact.hostname &&
        !contact.username &&
        !contact.password) ||
      (contact.protocol === "mailto:" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contact.pathname))
    )
  )
    throw new Error("VAPID_SUBJECT must be a mailto: or https: contact URI");
  return config;
}

const retryDelays = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000];
type Delivery = { retry: false } | { retry: true; error: string };

async function deliverReview(
  repository: AuthRepository,
  vapid: VapidConfig,
  parentId: string,
  taskName: string,
): Promise<Delivery> {
  const subscription: PushSubscription | null | undefined = (await repository.parentById(parentId))
    ?.pushSubscription;
  if (!subscription) return { retry: false };
  const message: PushMessage = {
    data: JSON.stringify({ title: "レビュー待ち", body: `${taskName} が完了報告されました` }),
    options: { ttl: 2419200, urgency: "normal" },
  };
  let payload;
  try {
    payload = await buildPushPayload(message, { ...subscription, expirationTime: null }, vapid);
  } catch {
    console.warn("Push payload construction failed");
    return { retry: false };
  }
  let response: Response;
  try {
    response = await fetch(subscription.endpoint, {
      ...payload,
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return { retry: true, error: "network_or_timeout" };
  }
  // Do not retain provider bodies, URLs, keys or exception messages.
  await response.body?.cancel().catch(() => {
    // The HTTP status still determines delivery when stream cleanup fails.
  });
  if (response.ok) return { retry: false };
  if (response.status === 404 || response.status === 410) {
    await repository.clearPushSubscriptionIfUnchanged(parentId, subscription);
    return { retry: false };
  }
  console.warn("Push delivery failed", response.status);
  return response.status === 408 ||
    response.status === 429 ||
    (response.status >= 500 && response.status <= 599)
    ? { retry: true, error: `http_${response.status}` }
    : { retry: false };
}

// Initial delivery remains background best-effort, including database failures.
export async function notifyReview(
  repository: AuthRepository,
  vapid: VapidConfig,
  parentId: string,
  taskName: string,
): Promise<void> {
  try {
    const result = await deliverReview(repository, vapid, parentId, taskName);
    if (result.retry)
      await repository.enqueuePushRetry(
        parentId,
        taskName,
        result.error,
        new Date(Date.now() + retryDelays[0]),
      );
  } catch {
    console.warn("Push delivery or queue persistence failed");
  }
}

export async function processPushRetries(
  repository: AuthRepository,
  vapid: VapidConfig,
): Promise<void> {
  const jobs = await repository.claimPushRetries(new Date());
  for (const job of jobs) {
    try {
      if (job.attempts > retryDelays.length) {
        await repository.finishPushRetry(job.id, job.attempts);
        continue;
      }
      const result = await deliverReview(repository, vapid, job.parentId, job.taskName);
      await repository.finishPushRetry(
        job.id,
        job.attempts,
        result.retry && job.attempts < retryDelays.length
          ? {
              nextAttemptAt: new Date(Date.now() + retryDelays[job.attempts]),
              lastError: result.error,
            }
          : undefined,
      );
    } catch {
      // Lease expiry makes database failures recoverable; attempts remain bounded.
      console.warn("Push retry processing failed");
    }
  }
}
