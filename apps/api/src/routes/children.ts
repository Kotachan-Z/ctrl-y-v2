import { compare } from "bcryptjs";
import type { Hono } from "hono";

import type { AuthEnv } from "../auth.js";
import { familyId, isUuid, issueSession, parentOnly } from "../auth.js";
import { body } from "../lib/request.js";
import { childName, secretText } from "../lib/validation.js";
import type { RouteDeps } from "./types.js";

export function registerChildRoutes(app: Hono<AuthEnv>, deps: RouteDeps): void {
  const { repo, auth, limit, jwtSecret } = deps;
  app.post("/api/children", auth, parentOnly, async (c) => {
    const data = await body(c.req.raw);
    if (Object.keys(data).some((key) => key !== "name"))
      return c.json({ error: "子供の追加では名前のみ指定してください" }, 400);
    const child = await repo().addChild(familyId(c.get("identity")), childName(data.name));
    if (!child) return c.json({ error: "先に初回セットアップを完了してください" }, 409);
    return c.json({ child }, 201);
  });
  app.get("/api/children", auth, parentOnly, async (c) =>
    c.json({ children: await repo().listChildren(familyId(c.get("identity"))) }),
  );
  app.post("/api/children/:childId/login", async (c) => {
    const id = c.req.param("childId");
    if (!isUuid(id)) return c.json({ error: "ログインURLを確認してください" }, 400);
    const keyword = secretText((await body(c.req.raw)).keyword, 4, "あいことば");
    return limit(`child:${id.toLowerCase()}`, async () => {
      const record = await repo().childById(id);
      if (!record || !record.parent.keyword || !(await compare(keyword, record.parent.keyword)))
        return c.json({ error: "ログインURLまたはあいことばが違います" }, 401);
      return c.json({
        ...(await issueSession(
          { id, role: "child", parentId: record.parent.id },
          jwtSecret,
          repo(),
        )),
        child: { id, name: record.child.name },
      });
    });
  });
}
