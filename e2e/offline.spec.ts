import { expect, test } from "@playwright/test";

for (const trigger of ["reconnect", "refresh"] as const) {
  test(`only completion queues and synchronizes both tabs on ${trigger}`, async ({
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
    await context.setOffline(true);
    await task.getByRole("button", { name: "はじめる" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByText(/未送信の操作:/)).toHaveCount(0);
    await expect(task.getByRole("button", { name: "はじめる" })).toBeEnabled();
    await context.setOffline(false);
    await task.getByRole("button", { name: "はじめる" }).click();
    await expect(task.getByRole("button", { name: "できた!" })).toBeEnabled();
    const other = await context.newPage();
    await other.goto(page.url());
    const otherTask = other.getByRole("article", { name: "オフラインのお手伝い" });
    await expect(otherTask.getByRole("button", { name: "できた!" })).toBeEnabled();
    await context.setOffline(true);
    const cachedResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/tasks" &&
        response.headers()["x-ctrl-y-offline"] === "1",
    );
    await page.getByRole("button", { name: "一覧を更新" }).click();
    expect((await cachedResponse).ok()).toBe(true);
    await expect(task).toBeVisible();
    await expect(page.getByText(/オフライン表示中/)).toBeVisible();
    if (trigger === "refresh") {
      await context.setOffline(false);
      // Fail only the API write while the browser remains online.
      await page.evaluate(() => {
        const originalFetch = window.fetch;
        window.fetch = (input, init) => {
          if (init?.method === "PATCH" && typeof input === "string" && input.endsWith("/status")) {
            window.fetch = originalFetch;
            return Promise.reject(new TypeError("Temporary network failure"));
          }
          return originalFetch(input, init);
        };
      });
    }
    await task.getByRole("button", { name: "できた!" }).click();
    await expect(page.getByText("オフラインのため送信待ちです")).toBeVisible();
    await expect(page.getByText("未送信の操作: 1件")).toBeVisible();
    await expect(task.getByRole("button", { name: "できた!" })).toBeDisabled();
    await expect(otherTask.getByRole("button", { name: "できた!" })).toBeDisabled();
    if (trigger === "refresh") {
      // The other tab drains the queue; the original tab must observe its storage changes.
      // Trigger the button without bringing the tab forward (which would also retry).
      await other.getByRole("button", { name: "一覧を更新" }).evaluate((button) => {
        if (!(button instanceof HTMLButtonElement)) throw new Error("Expected refresh button");
        button.click();
      });
    } else {
      await context.setOffline(false);
    }
    await expect(page.getByText(/未送信の操作:/)).toHaveCount(0);
    await expect(otherTask.getByRole("button", { name: "まってね" })).toBeDisabled();
    await expect(task.getByRole("button", { name: "まってね" })).toBeDisabled();
    await page.reload();
    await expect(task.getByRole("button", { name: "まってね" })).toBeDisabled();
  });
}
