import { expect, test } from "@playwright/test";

test("cached child tasks remain readable and completion replays on reconnect", async ({
  page,
  context,
}) => {
  await page.goto("/signup");
  await page.getByLabel("メールアドレス").fill(`offline-${crypto.randomUUID()}@example.test`);
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
  await page.getByLabel("タスク名").fill("オフラインのお手伝い");
  await page.getByLabel("報酬（円）").fill("100");
  await page.getByLabel("期限").fill("2027-01-01T18:00");
  await page.getByRole("button", { name: "タスクを作成", exact: true }).click();
  await expect(page.getByRole("article", { name: "オフラインのお手伝い" })).toBeVisible();
  await page.goto(childUrl!);
  await page.getByLabel("あいことば").fill("ひみつのことば");
  await page.getByRole("button", { name: "ログイン", exact: true }).click();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  const task = page.getByRole("article", { name: "オフラインのお手伝い" });
  await task.getByRole("button", { name: "はじめる" }).click();
  await expect(task.getByRole("button", { name: "できた!" })).toBeEnabled();
  await context.setOffline(true);
  await page.getByRole("button", { name: "一覧を更新" }).click();
  await expect(task).toBeVisible();
  await expect(page.getByText(/オフライン表示中/)).toBeVisible();
  await task.getByRole("button", { name: "できた!" }).click();
  await expect(page.getByText("オフラインのため送信待ちです")).toBeVisible();
  await expect(page.getByText("未送信の操作: 1件")).toBeVisible();
  await expect(task.getByRole("button", { name: "できた!" })).toBeDisabled();
  await context.setOffline(false);
  await expect(page.getByText(/未送信の操作:/)).toHaveCount(0);
  await expect(task.getByRole("button", { name: "まってね" })).toBeDisabled();
  await page.reload();
  await expect(task.getByRole("button", { name: "まってね" })).toBeDisabled();
});
