import { expect, test } from "@playwright/test";
test("parent login and API health", async ({ page, request }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("Ctrl-Y v2");
  await expect(page.getByRole("heading", { name: "親ログイン" })).toBeVisible();
  const response = await request.get("/api/health");
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ status: "ok" });
});
