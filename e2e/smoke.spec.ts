import { expect, test } from "@playwright/test";
test("web placeholder and API health", async ({ page, request }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("Ctrl-Y v2");
  await expect(page.getByRole("heading", { name: "Ctrl-Y v2 — Coming soon" })).toBeVisible();
  const response = await request.get("/health");
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ status: "ok" });
});
