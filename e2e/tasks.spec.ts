import { expect, test } from "@playwright/test";

test("parent creates and edits; child starts and submits; parent approves and deletes", async ({
  page,
}) => {
  await page.goto("/signup");
  await page.getByLabel("メールアドレス").fill(`tasks-${crypto.randomUUID()}@example.test`);
  await page.getByLabel("パスワード").fill("test-password-123");
  await page.getByRole("button", { name: "登録する" }).click();
  await page.getByLabel("子供の名前").fill("はな");
  await page.getByLabel("あいことば").fill("ひみつのことば");
  await page.getByRole("button", { name: "子供を作成する" }).click();
  const link = page.locator('a[href*="/child/login/"]').first();
  await expect(link).toBeVisible();
  const childUrl = await link.getAttribute("href");
  await page.getByRole("link", { name: "親のトップへ" }).click();
  await page.getByRole("tab", { name: "タスクを追加" }).click();
  await page.getByLabel("タスク名").fill("玄関そうじ");
  await page.getByLabel("メモ").fill("くつをそろえる");
  await page.getByLabel("報酬（円）").fill("100");
  await page.getByLabel("期限").fill("2027-01-01T18:00");
  await page.getByRole("button", { name: "タスクを作成", exact: true }).click();
  let task = page.getByRole("article", { name: "玄関そうじ", exact: true });
  await task.getByRole("button", { name: "編集" }).click();
  await task.getByLabel("報酬（円）").fill("150");
  await task.getByRole("button", { name: "保存する" }).click();
  await expect(task).toContainText("150円");
  await page.goto(childUrl!);
  await page.getByLabel("あいことば").fill("ひみつのことば");
  await page.getByRole("button", { name: "ログイン", exact: true }).click();
  task = page.getByRole("article", { name: "玄関そうじ", exact: true });
  await task.getByRole("button", { name: "はじめる" }).click();
  await task.getByRole("button", { name: "できた!" }).click();
  await expect(task.getByRole("button", { name: "まってね" })).toBeDisabled();
  await page.goto("/top");
  await task.getByRole("button", { name: "承認", exact: true }).click();
  await expect(page.getByRole("region", { name: "完了", exact: true })).toContainText("玄関そうじ");
  await page.reload();
  await expect(page.getByRole("region", { name: "完了", exact: true })).toContainText("玄関そうじ");
  page.once("dialog", (dialog) => dialog.accept());
  await task.getByRole("button", { name: "削除" }).click();
  await expect(task).toHaveCount(0);
});
