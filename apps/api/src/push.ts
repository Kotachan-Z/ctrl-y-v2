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

// The caller deliberately does not await this best-effort work. Catch database
// failures too, and never log endpoint credentials or provider response bodies.
export async function notifyReview(
  repository: AuthRepository,
  vapid: VapidConfig,
  parentId: string,
  taskName: string,
): Promise<void> {
  let subscription: PushSubscription | null | undefined;
  try {
    subscription = (await repository.parentById(parentId))?.pushSubscription;
    if (!subscription) return;
    const message: PushMessage = {
      data: JSON.stringify({ title: "レビュー待ち", body: `${taskName} が完了報告されました` }),
      // Preserve web-push's default four-week TTL and normal urgency.
      options: { ttl: 2419200, urgency: "normal" },
    };
    const payload = await buildPushPayload(
      message,
      { ...subscription, expirationTime: null },
      vapid,
    );
    const response = await fetch(subscription.endpoint, {
      ...payload,
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) return;
    if (response.status === 410 || response.status === 404) {
      try {
        await repository.clearPushSubscriptionIfUnchanged(parentId, subscription);
      } catch {
        console.warn("Push subscription cleanup failed");
      }
    } else console.warn("Push delivery failed", response.status);
  } catch {
    console.warn("Push delivery failed", "unknown");
  }
}
