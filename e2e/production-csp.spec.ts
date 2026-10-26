import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

declare global {
  interface Window {
    recordCspViolation: (value: string) => Promise<void>;
  }
}

test("production pages and PWA load without CSP violations", async ({ page }) => {
  const violations: string[] = [];
  await page.exposeFunction("recordCspViolation", (violation: string) =>
    violations.push(violation),
  );
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      void window.recordCspViolation(
        `${event.documentURI}: ${event.violatedDirective} ${event.blockedURI}`,
      );
    });
  });
  const rules = await readFile(new URL("../apps/web/public/_headers", import.meta.url), "utf8");
  const csp = rules.match(/Content-Security-Policy: (.+)/)?.[1];
  expect(csp).toBeTruthy();
  const response = await page.goto("/");
  expect(response?.headers()["content-security-policy"]).toBe(csp);
  await expect(page.getByRole("heading", { name: "親ログイン", exact: true })).toBeVisible();
  await page.goto("/signup");
  await page.getByLabel("メールアドレス").fill(`csp-${crypto.randomUUID()}@example.test`);
  await page.getByLabel("パスワード").fill("test-password-123");
  await page.getByRole("button", { name: "登録する" }).click();
  await page.getByLabel("子供の名前").fill("はな");
  await page.getByLabel("あいことば").fill("ひみつのことば");
  await page.getByRole("button", { name: "子供を作成する" }).click();
  await page.getByRole("link", { name: "親のトップへ" }).click();
  await page.getByRole("tab", { name: "タスクを追加" }).click();
  await page.getByLabel("タスク名").fill("CSP確認");
  await page.getByLabel("報酬（円）").fill("100");
  await page.getByLabel("期限").fill("2027-01-01T18:00");
  await page.getByRole("button", { name: "タスクを作成", exact: true }).click();
  await expect(page.getByRole("article", { name: "CSP確認", exact: true })).toBeVisible();
  await page.goto("/settings/notifications");
  await expect(page.getByRole("heading", { name: "通知設定", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "通知を有効にする" })).toBeEnabled();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration();
        return registration?.active?.scriptURL;
      }),
    )
    .toBe("http://127.0.0.1:4173/sw.js");
  const metadata = await page.evaluate(async () =>
    Promise.all(["/manifest.webmanifest", "/icon.svg"].map(async (path) => (await fetch(path)).ok)),
  );
  expect(metadata).toEqual([true, true]);
  await page.reload();
  await expect(page.getByRole("heading", { name: "通知設定", exact: true })).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(violations).toEqual([]);
});
