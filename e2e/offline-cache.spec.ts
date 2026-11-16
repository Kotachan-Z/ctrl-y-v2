import { expect, test } from "@playwright/test";

test("logging out drops the offline API cache for that credential", async ({ page }) => {
  await page.goto("/signup");
  await page.getByLabel("メールアドレス").fill(`cache-${crypto.randomUUID()}@example.test`);
  await page.getByLabel("パスワード").fill("test-password-123");
  await page.getByRole("button", { name: "登録する" }).click();
  await page.getByLabel("子供の名前").fill("はな");
  await page.getByLabel("あいことば").fill("ひみつのことば");
  await page.getByRole("button", { name: "子供を作成する" }).click();
  await page.getByRole("link", { name: "親のトップへ" }).click();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  const cachedApiEntries = () =>
    page.evaluate(async () => (await (await caches.open("ctrl-y-api-v1")).keys()).length);
  // Reload under the controlling worker so the task list goes through the API cache.
  await page.reload();
  await expect(page.getByRole("tab", { name: "タスクを追加" })).toBeVisible();
  await expect.poll(cachedApiEntries).toBeGreaterThan(0);
  await page.getByRole("button", { name: "ログアウト" }).click();
  await expect(page.getByRole("heading", { name: "親ログイン", exact: true })).toBeVisible();
  await expect.poll(cachedApiEntries).toBe(0);
});
