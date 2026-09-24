import { Hono } from "hono";
export const app = new Hono().get("/health", (c) => c.json({ status: "ok" }));
