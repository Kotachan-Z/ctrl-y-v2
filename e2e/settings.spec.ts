import { expect, test } from "@playwright/test";

test("parent changes payday and cutoff-day settings from the settings hub", async ({ page }) => {
  await page.goto("/signup");
  await page.getByLabel("メールアドレス").fill(`settings-${crypto.randomUUID()}@example.test`);
  await page.getByLabel("パスワード").fill("test-password-123");
  await page.getByRole("button", { name: "登録する" }).click();
  await page.getByLabel("子供の名前").fill("はな");
  await page.getByLabel("あいことば").fill("ひみつのことば");
  await page.getByRole("button", { name: "子供を作成する" }).click();
  await page.getByRole("link", { name: "親のトップへ" }).click();

  await page.getByRole("link", { name: "設定" }).click();
  await expect(page.getByRole("heading", { name: "設定", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "給与設定" }).click();
  await expect(page.getByRole("heading", { name: "給与設定", exact: true })).toBeVisible();

  await expect(page.getByLabel("給料日")).toHaveValue("end");
  await expect(page.getByLabel("締め日")).toHaveValue("end");
  await page.getByLabel("給料日").selectOption("15");
  await page.getByLabel("締め日").selectOption("15");
  await expect(page.getByLabel("給料日")).toHaveValue("15");
  await expect(page.getByLabel("締め日")).toHaveValue("15");

  await page.reload();
  await expect(page.getByLabel("給料日")).toHaveValue("15");
  await expect(page.getByLabel("締め日")).toHaveValue("15");
});
