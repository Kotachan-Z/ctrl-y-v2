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
  const completed = Array.from({ length: 21 }, (_, i) => ({
    id: crypto.randomUUID(),
    name: `完了タスク${i + 1}`,
    memo: null,
    reward: 100,
    deadline: "2027-01-01T00:00:00Z",
    status: "DONE",
    childId: null,
  }));
  await page.context().route("**/api/tasks?*", async (route) => {
    const query = new URL(route.request().url()).searchParams;
    const done = query.get("status") === "DONE";
    const offset = query.has("cursor") ? 20 : 0;
    const end = offset + Number(query.get("limit"));
    await route.fulfill({
      json: {
        tasks: done ? completed.slice(offset, end) : [],
        ...(done ? { nextCursor: end >= completed.length ? null : "next-page" } : {}),
      },
    });
  });
  for (const url of ["/top", childUrl!.replace("/login/", "/top/")]) {
    await page.goto(url);
    const done = page.getByRole("region", { name: "完了", exact: true });
    await expect(done.getByRole("article")).toHaveCount(20);
    await done.getByRole("button", { name: "もっと見る" }).click();
    await expect(done.getByRole("article")).toHaveCount(21);
    await expect(done.getByRole("button", { name: "もっと見る" })).toHaveCount(0);
    if (url === "/top") {
      const last = done.getByRole("article", { name: "完了タスク21", exact: true });
      await last.getByRole("button", { name: "編集" }).click();
      await last.getByLabel("メモ").fill("入力途中");
      const refreshed = page.waitForResponse((response) =>
        response.url().includes("status=DONE&limit=20&cursor="),
      );
      await page.evaluate(() => window.dispatchEvent(new Event("ctrl-y-synced")));
      await refreshed;
      await expect(last.getByLabel("メモ")).toHaveValue("入力途中");
    }
    await page.getByRole("button", { name: "一覧を更新" }).click();
    await expect(done.getByRole("article")).toHaveCount(21);
  }
  await page.goto("/top");
  const done = page.getByRole("region", { name: "完了", exact: true });
  await expect(done.getByRole("article")).toHaveCount(20);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.context().route("**/api/tasks?*cursor=*", async (route) => {
    started();
    await gate;
    await route.fulfill({ json: { tasks: completed.slice(20), nextCursor: null } });
  });
  await done.getByRole("button", { name: "もっと見る" }).click();
  await requested;
  const refreshed = page.waitForResponse(
    (response) =>
      response.url().includes("status=DONE&limit=20") && !response.url().includes("cursor"),
  );
  await page.evaluate(() => window.dispatchEvent(new Event("ctrl-y-synced")));
  await refreshed;
  await expect(done.getByRole("button", { name: "もっと見る" })).toBeEnabled();
  const stale = page.waitForResponse((response) => response.url().includes("cursor="));
  release();
  await stale;
  // Wait for the client to consume the response before asserting it was discarded.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await expect(done.getByRole("article")).toHaveCount(20);
  await expect(done.getByRole("button", { name: "もっと見る" })).toBeEnabled();
});
