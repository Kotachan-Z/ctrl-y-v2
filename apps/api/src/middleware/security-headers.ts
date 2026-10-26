import type { MiddlewareHandler } from "hono";
import { secureHeaders } from "hono/secure-headers";

const headers = secureHeaders({
  contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
  xContentTypeOptions: "nosniff",
  referrerPolicy: "strict-origin-when-cross-origin",
  xFrameOptions: "DENY",
  strictTransportSecurity: false,
  permissionsPolicy: { camera: [], microphone: [], geolocation: [], payment: [], usb: [] },
});

export const apiSecurityHeaders: MiddlewareHandler = async (c, next) => {
  await headers(c, next);
  if (new URL(c.req.url).protocol === "https:") {
    c.header("Strict-Transport-Security", "max-age=31536000");
  }
};
