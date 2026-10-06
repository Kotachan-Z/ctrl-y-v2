import { sign, verify } from "hono/jwt";

import { isUuid } from "./auth.js";

export type ResetMailConfig = {
  apiKey?: string;
  from?: string;
  webOrigin: string;
  local?: boolean;
};
export async function tokenDigest(token: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export async function issueResetToken(parentId: string, secret: string) {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 15 * 60;
  const token = await sign(
    {
      sub: parentId,
      role: "parent",
      purpose: "reset",
      iss: "ctrl-y",
      aud: "ctrl-y-password-reset",
      jti: crypto.randomUUID(),
      iat: now,
      exp,
    },
    secret,
    "HS256",
  );
  return { token, expiresAt: new Date(exp * 1000) };
}
export async function readResetToken(token: unknown, secret: string) {
  if (typeof token !== "string" || token.length > 2048) return undefined;
  try {
    const p = await verify(token, secret, "HS256");
    const now = Math.floor(Date.now() / 1000);
    if (
      p.purpose !== "reset" ||
      p.role !== "parent" ||
      p.iss !== "ctrl-y" ||
      p.aud !== "ctrl-y-password-reset" ||
      !isUuid(p.sub) ||
      !isUuid(p.jti) ||
      typeof p.iat !== "number" ||
      !Number.isFinite(p.iat) ||
      p.iat > now ||
      typeof p.exp !== "number" ||
      !Number.isFinite(p.exp) ||
      p.exp <= now ||
      p.exp <= p.iat ||
      p.exp - p.iat > 900
    )
      return undefined;
    return p.sub;
  } catch {
    return undefined;
  }
}
export async function sendResetEmail(email: string, token: string, config?: ResetMailConfig) {
  if (!config) throw new Error("Password reset mail is not configured");
  const origin = new URL(config.webOrigin);
  if (
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    (origin.protocol !== "https:" &&
      !(
        config.local &&
        origin.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(origin.hostname)
      ))
  )
    throw new Error("Invalid WEB_ORIGIN");
  const link = new URL(`/reset-password/${token}`, origin).href;
  if (!config.apiKey && config.local) {
    console.info("Password reset link (local only):", link);
    return;
  }
  if (!config.apiKey || !config.from)
    throw new Error("Missing RESEND_API_KEY or RESEND_FROM_EMAIL");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: config.from,
      to: [email],
      subject: "ご褒美ポケット パスワードの再設定",
      text: `以下のリンクから15分以内にパスワードを再設定してください。\n${link}\n心当たりがない場合は、このメールを無視してください。`,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("Password reset email rejected");
}
