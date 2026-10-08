import { HTTPException } from "hono/http-exception";

import type { PayrollSettings, TaskFields, TaskStatus } from "../repository.js";

export function credentials(data: Record<string, unknown>) {
  const email = typeof data.email === "string" ? data.email.trim().toLowerCase() : "";
  if (email.includes("\u0000") || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new HTTPException(400, { message: "メールアドレスを確認してください" });
  return { email, password: secretText(data.password, 8, "パスワード") };
}
export function secretText(value: unknown, min: number, label: string) {
  if (
    typeof value !== "string" ||
    value.includes("\u0000") ||
    Array.from(value).length < min ||
    !value.trim() ||
    new TextEncoder().encode(value).length > 72
  )
    throw new HTTPException(400, {
      message: `${label}は${min}文字以上・UTF-8で72バイト以内にしてください`,
    });
  return value;
}
export function childName(value: unknown) {
  if (
    typeof value !== "string" ||
    value.includes("\u0000") ||
    !value.trim() ||
    Array.from(value.trim()).length > 50
  )
    throw new HTTPException(400, { message: "名前は1〜50文字にしてください" });
  return value.trim();
}
export function payrollSettingsFields(data: Record<string, unknown>): Partial<PayrollSettings> {
  if (
    !Object.keys(data).length ||
    Object.keys(data).some((key) => !["payDay", "cutoffDay"].includes(key))
  )
    throw new HTTPException(400, { message: "設定項目を確認してください" });
  const result: Partial<PayrollSettings> = {};
  if ("payDay" in data) {
    if (typeof data.payDay !== "boolean")
      throw new HTTPException(400, { message: "給料日の値が不正です" });
    result.payDay = data.payDay;
  }
  if ("cutoffDay" in data) {
    if (typeof data.cutoffDay !== "boolean")
      throw new HTTPException(400, { message: "締め日の値が不正です" });
    result.cutoffDay = data.cutoffDay;
  }
  return result;
}
export function taskStatus(value: unknown): value is TaskStatus {
  return value === "TODO" || value === "IN_PROGRESS" || value === "WAIT_REVIEW" || value === "DONE";
}
export function taskFields(data: Record<string, unknown>, partial = false): Partial<TaskFields> {
  const fail = () => {
    throw new HTTPException(400, { message: "タスクの入力を確認してください" });
  };
  if (
    !Object.keys(data).length ||
    Object.keys(data).some((key) => !["name", "memo", "reward", "deadline"].includes(key))
  )
    fail();
  const result: Partial<TaskFields> = {};
  if (!partial || "name" in data) {
    if (
      typeof data.name !== "string" ||
      !data.name.trim() ||
      data.name.includes("\u0000") ||
      Array.from(data.name.trim()).length > 100
    )
      return fail();
    result.name = data.name.trim();
  }
  if ("memo" in data) {
    if (
      data.memo !== null &&
      (typeof data.memo !== "string" ||
        data.memo.includes("\u0000") ||
        Array.from(data.memo).length > 2000)
    )
      return fail();
    result.memo = data.memo;
  }
  if (!partial || "reward" in data) {
    if (
      typeof data.reward !== "number" ||
      !Number.isInteger(data.reward) ||
      data.reward < 0 ||
      data.reward > 1000000
    )
      return fail();
    result.reward = data.reward;
  }
  if (!partial || "deadline" in data) {
    if (
      typeof data.deadline !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
        data.deadline,
      ) ||
      !Number.isFinite(Date.parse(data.deadline))
    )
      return fail();
    const date = data.deadline.slice(0, 10);
    if (new Date(date).toISOString().slice(0, 10) !== date) return fail();
    result.deadline = new Date(data.deadline);
  }
  return result;
}
