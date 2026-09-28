// Deliberately invalid cryptographic keys: format-only placeholders for tests
// that mock delivery. Never use these to send notifications.
export const vapidEnv = {
  VAPID_PUBLIC_KEY: Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]).toString("base64url"),
  VAPID_PRIVATE_KEY: Buffer.alloc(32).toString("base64url"),
  VAPID_SUBJECT: "mailto:push@example.test",
};
