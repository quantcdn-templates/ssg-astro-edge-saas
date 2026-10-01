import { test, expect } from "@playwright/test";

test("desktop: sign in, create, edit, filter, settings, delete and sign out", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.goto("/app");
  await page.screenshot({
    path: ".local/screenshots/login-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Enter demo workspace" }).click();
  await expect(page.locator("#stat-total")).toHaveText("8");
  await expect(page.locator("#loading")).toBeHidden();
  await page.screenshot({
    path: ".local/screenshots/dashboard-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await page.screenshot({
    path: ".local/screenshots/project-dialog.png",
    fullPage: true,
    animations: "disabled",
  });
  await page
    .getByLabel("Project name", { exact: true })
    .fill("Browser test <project>");
  await page
    .getByLabel("Description", { exact: true })
    .last()
    .fill("Persisted through the edge function.");
  await page.getByRole("button", { name: "Save project" }).click();
  await expect(page.locator("#project-dialog")).not.toBeVisible();
  await expect(page.locator("#stat-total")).toHaveText("9");
  await page.reload();
  await expect(page.locator("#stat-total")).toHaveText("9");
  await page.locator('[data-view="projects"]').click();
  await page.getByRole("searchbox").fill("Browser test");
  await expect(page.locator("#projects-table tbody tr")).toHaveCount(1);
  await expect(page.locator("#projects-table")).toContainText(
    "Browser test <project>",
  );
  await page
    .getByRole("button", { name: "Edit Browser test <project>", exact: true })
    .click();
  await page.getByLabel("Status", { exact: true }).selectOption("complete");
  await page.getByRole("button", { name: "Save project" }).click();
  await expect(page.locator("#projects-table")).toContainText("Complete");
  await expect(page.locator("#projects-table")).toContainText("100%");
  await page.locator('[data-view="activity"]').click();
  await page.screenshot({
    path: ".local/screenshots/activity-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.locator('[data-view="settings"]').click();
  await page.screenshot({
    path: ".local/screenshots/settings-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  await page
    .getByLabel("Workspace name", { exact: true })
    .fill("Browser checked workspace");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.locator("#workspace-name")).toHaveText(
    "Browser checked workspace",
  );
  await page
    .getByLabel("Workspace name", { exact: true })
    .fill("Studio workspace");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.locator("#workspace-name")).toHaveText("Studio workspace");
  await page.locator('[data-view="projects"]').click();
  await page
    .getByRole("button", { name: "Edit Browser test <project>", exact: true })
    .click();
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Delete project", exact: true })
    .click();
  await expect(page.locator("#projects-table tbody tr")).toHaveCount(0);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.locator("#login")).toBeVisible();
  await page.reload();
  await expect(page.locator("#login")).toBeVisible();
  await page.goto("/");
  await page.screenshot({
    path: ".local/screenshots/home-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  expect(errors).toEqual([]);
});
test("mobile: usable navigation, dialog, no horizontal page overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app");
  await page.getByRole("button", { name: "Enter demo workspace" }).click();
  await expect(page.locator("#stat-total")).toHaveText("8");
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await page.screenshot({
    path: ".local/screenshots/dashboard-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await expect(page.getByLabel("Project name", { exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#project-dialog")).not.toBeVisible();
  await page.locator('[data-view="projects"]').click();
  await page
    .getByRole("combobox", { name: "Filter by status" })
    .selectOption("complete");
  await expect(page.locator("#projects-table tbody tr")).toHaveCount(2);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "A little less busywork",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: ".local/screenshots/home-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
});
test("a failed save keeps the dialog and user input available for retry", async ({
  page,
}) => {
  await page.goto("/app");
  await page.getByRole("button", { name: "Enter demo workspace" }).click();
  await expect(page.locator("#stat-total")).toHaveText("8");
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await page.getByLabel("Project name", { exact: true }).fill("Keep my input");
  await page.route("**/api/projects", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({
          status: 503,
          contentType: "application/json",
          body: '{"error":"Please try again."}',
        })
      : route.continue(),
  );
  await page.getByRole("button", { name: "Save project" }).click();
  await expect(page.locator("#project-error")).toHaveText("Please try again.");
  await expect(page.getByLabel("Project name", { exact: true })).toHaveValue(
    "Keep my input",
  );
  await expect(page.locator("#project-dialog")).toBeVisible();
});
