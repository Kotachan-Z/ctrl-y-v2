import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import type { AuthEnv } from "../auth.js";
import { familyId, isUuid, parentOnly } from "../auth.js";
import { body } from "../lib/request.js";
import { payrollSettingsFields } from "../lib/validation.js";
import type { RouteDeps } from "./types.js";

export function registerPayrollRoutes(app: Hono<AuthEnv>, deps: RouteDeps): void {
  const { repo, auth } = deps;
  const ownedPayrollChild = async (parentId: string, id: string) => {
    if (!isUuid(id)) throw new HTTPException(400, { message: "子供IDが不正です" });
    const record = await repo().childById(id);
    if (!record || record.parent.id !== parentId)
      throw new HTTPException(404, { message: "子供が見つかりません" });
    return record.child;
  };
  app.get("/api/payroll", auth, parentOnly, async (c) => {
    const parentId = familyId(c.get("identity"));
    const month = c.req.query("month");
    const childId = c.req.query("childId");
    if (month !== undefined && !/^(?!0000)\d{4}-(?:0[1-9]|1[0-2])-01$/.test(month))
      throw new HTTPException(400, { message: "対象月が不正です" });
    if (childId !== undefined) await ownedPayrollChild(parentId, childId);
    return c.json({ payroll: await repo().listPayroll(parentId, month, childId) });
  });
  app.get("/api/children/:childId/payroll", auth, async (c) => {
    const identity = c.get("identity");
    const child = await ownedPayrollChild(familyId(identity), c.req.param("childId"));
    if (identity.role === "child" && identity.id.toLowerCase() !== child.id)
      throw new HTTPException(403, { message: "この操作は許可されていません" });
    return c.json({ payroll: await repo().listPayroll(familyId(identity), undefined, child.id) });
  });
  app.get("/api/settings/payroll", auth, parentOnly, async (c) => {
    const settings = await repo().getPayrollSettings(familyId(c.get("identity")));
    if (!settings) throw new HTTPException(404, { message: "設定が見つかりません" });
    return c.json({ settings });
  });
  app.patch("/api/settings/payroll", auth, parentOnly, async (c) => {
    const fields = payrollSettingsFields(await body(c.req.raw));
    const settings = await repo().updatePayrollSettings(familyId(c.get("identity")), fields);
    if (!settings) throw new HTTPException(404, { message: "設定が見つかりません" });
    return c.json({ settings });
  });
}
