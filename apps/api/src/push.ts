import webPush from "web-push";

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
    await webPush.sendNotification(
      subscription,
      JSON.stringify({ title: "レビュー待ち", body: `${taskName} が完了報告されました` }),
      { vapidDetails: vapid, timeout: 5000 },
    );
  } catch (error) {
    const status =
      error !== null && typeof error === "object" && "statusCode" in error
        ? error.statusCode
        : undefined;
    if (subscription && (status === 410 || status === 404)) {
      try {
        await repository.clearPushSubscriptionIfUnchanged(parentId, subscription);
      } catch {
        console.warn("Push subscription cleanup failed");
      }
    } else console.warn("Push delivery failed", typeof status === "number" ? status : "unknown");
  }
}
