import { HTTPException } from "hono/http-exception";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export async function body(request: Request): Promise<Record<string, unknown>> {
  // Let stream errors reach bodyLimit; only JSON parsing failures are a 400.
  const text = await request.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new HTTPException(400, { message: "JSONを送信してください" });
  }
  if (!isRecord(data)) throw new HTTPException(400, { message: "入力形式が不正です" });
  return data;
}
