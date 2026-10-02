import { expect, test } from "@playwright/test";

test("parent can request a reset and recover from an invalid link", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "パスワードを忘れた場合" }).click();
  await page.getByLabel("メールアドレス").fill("missing-reset@example.test");
  await page.getByRole("button", { name: "再設定リンクを送信" }).click();
  await expect(page.getByRole("status")).toContainText("登録されている場合");
  await page.goto("/reset-password/invalid-token");
  await page.getByLabel("新しいパスワード", { exact: true }).fill("new-password");
  await page.getByLabel("新しいパスワード（確認）", { exact: true }).fill("new-password");
  await page.getByRole("button", { name: "パスワードを変更" }).click();
  await expect(page.getByRole("alert")).toContainText("リンクが無効か期限切れ");
  await page.getByRole("link", { name: "リンクを再発行する" }).click();
  await expect(page.getByRole("button", { name: "再設定リンクを送信" })).toBeVisible();
});
