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
  await page.goto("/records");
  const year = new Date().getFullYear();
  await expect(page.getByRole("cell", { name: `${year}年11月15日`, exact: true })).toBeVisible();
  await page.goto("/settings/payroll");
  await page.getByLabel("給料日").selectOption("end");
  await expect(page.getByLabel("給料日")).toHaveValue("end");
  await expect(page.getByLabel("給料日")).toBeEnabled();
  await page.goto("/records");
  await expect(page.getByRole("cell", { name: `${year}年11月30日`, exact: true })).toBeVisible();
  await expect(
    page.getByRole("cell", {
      name: `${year}年2月${new Date(Date.UTC(year, 2, 0)).getUTCDate()}日`,
      exact: true,
    }),
  ).toBeVisible();
});

test("salary records remain visible when payroll settings fail", async ({ page }) => {
  await page.goto("/signup");
  await page.getByLabel("メールアドレス").fill(`records-${crypto.randomUUID()}@example.test`);
  await page.getByLabel("パスワード").fill("test-password-123");
  await page.getByRole("button", { name: "登録する" }).click();
  await page.getByLabel("子供の名前").fill("はな");
  await page.getByLabel("あいことば").fill("ひみつのことば");
  await page.getByRole("button", { name: "子供を作成する" }).click();
  await page.getByRole("link", { name: "親のトップへ" }).click();
  await page.context().route("**/api/children/*/payroll", (route) =>
    route.fulfill({
      json: {
        payroll: [
          {
            id: "record",
            childId: "child",
            month: `${new Date().getFullYear()}-01-01`,
            completedTaskCount: 2,
            totalReward: 300,
          },
        ],
      },
    }),
  );
  await page.goto("/records");
  await expect(page.getByRole("cell", { name: "300円", exact: true })).toBeVisible();
  await page
    .context()
    .route("**/api/settings/payroll", (route) =>
      route.fulfill({ status: 500, json: { message: "給与設定を取得できません" } }),
    );
  await page.reload();
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.getByRole("cell", { name: "300円", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "2件", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "—", exact: true })).toHaveCount(12);
});
