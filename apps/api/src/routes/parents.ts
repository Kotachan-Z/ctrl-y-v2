import { compare, hash } from "bcryptjs";
import type { Hono } from "hono";

import type { AuthEnv } from "../auth.js";
import { familyId, issueSession, parentOnly } from "../auth.js";
import { body } from "../lib/request.js";
import { credentials, secretText, childName } from "../lib/validation.js";
import { issueResetToken, readResetToken, tokenDigest, sendResetEmail } from "../password-reset.js";
import type { RouteDeps } from "./types.js";

export function registerParentRoutes(app: Hono<AuthEnv>, deps: RouteDeps): void {
  const { repo, auth, limit, resetLimit, jwtSecret, resetMail, backgroundTask } = deps;
  app.post("/api/parents", async (c) => {
    const { email, password } = credentials(await body(c.req.raw));
    return limit(`register:${email}`, async () => {
      const parent = await repo().register(email, await hash(password, 12));
      if (!parent) return c.json({ error: "このメールアドレスは登録済みです" }, 409);
      return c.json(
        {
          ...(await issueSession({ id: parent.id, role: "parent" }, jwtSecret, repo())),
          parent: { id: parent.id, email: parent.email },
          needsSetup: true,
        },
        201,
      );
    });
  });
  app.post("/api/parents/login", async (c) => {
    const { email, password } = credentials(await body(c.req.raw));
    return limit(`login:${email}`, async () => {
      const parent = await repo().parentByEmail(email);
      if (!parent || !(await compare(password, parent.passwordHash)))
        return c.json({ error: "メールアドレスまたはパスワードが違います" }, 401);
      return c.json({
        ...(await issueSession({ id: parent.id, role: "parent" }, jwtSecret, repo())),
        parent: { id: parent.id, email: parent.email },
        needsSetup: (await repo().listChildren(parent.id)).length === 0,
      });
    });
  });
  app.post("/api/parents/password-reset/request", async (c) => {
    const data = await body(c.req.raw);
    const { email } = credentials({ email: data.email, password: "validation-only" });
    return resetLimit(`reset-request:${email}`, async () => {
      const delivery = async () => {
        try {
          const parent = await repo().parentByEmail(email);
          if (!parent) return;
          const { token, expiresAt } = await issueResetToken(parent.id, jwtSecret);
          await sendResetEmail(email, token, resetMail);
          await repo().savePasswordReset(parent.id, await tokenDigest(token), expiresAt);
        } catch {
          // Do not disclose account existence or log tokens/provider response bodies.
          console.error("Password reset delivery failed");
        }
      };
      const pending = delivery();
      if (backgroundTask) backgroundTask(pending);
      else await pending;
      return c.json({ message: "登録されている場合、再設定用リンクを送信しました。" });
    });
  });
  app.post("/api/parents/password-reset/confirm", async (c) => {
    const data = await body(c.req.raw);
    const digest = typeof data.token === "string" ? await tokenDigest(data.token) : "invalid";
    return resetLimit(`reset-confirm:${digest}`, async () => {
      const password = secretText(data.password, 8, "パスワード");
      const parentId = await readResetToken(data.token, jwtSecret);
      if (!parentId || typeof data.token !== "string")
        return c.json({ error: "リンクが無効か期限切れです。再発行してください" }, 401);
      const changed = await repo().resetPassword(parentId, digest, await hash(password, 12));
      if (!changed) return c.json({ error: "リンクが無効か期限切れです。再発行してください" }, 401);
      return c.json({ success: true });
    });
  });
  app.post("/api/setup", auth, parentOnly, async (c) => {
    const data = await body(c.req.raw);
    const name = childName(data.name);
    const keyword = secretText(data.keyword, 4, "あいことば");
    const child = await repo().addChild(familyId(c.get("identity")), name, await hash(keyword, 12));
    if (!child) return c.json({ error: "初回セットアップは完了しています" }, 409);
    return c.json({ child }, 201);
  });
}
