import { test, expect } from "@playwright/test";

// These tests expect a freshly seeded local store: the Playwright web server
// runs `quant serve --memory` with the fixtures in quant/kv-fixtures/ (eight
// projects, four active, two planned and two complete). Each test removes
// what it creates.
const shot = (page, name) =>
  page.screenshot({
    path: `.local/screenshots/${name}.png`,
    fullPage: true,
    animations: "disabled",
  });
const desktop = { width: 1440, height: 1080 };
const phone = { width: 390, height: 844 };
const conflictCopy =
  "Someone else changed this project. Reload it to see their change.";
const duplicateCopy = "A project with this name already exists.";
// The owner key that the web server seeds with --seed-key.
const accessKey = "0123456789abcdef".repeat(4);
async function enterKey(page) {
  await page.getByLabel("Access key", { exact: true }).fill(accessKey);
  await page.getByRole("button", { name: "Open workspace" }).click();
}
async function signIn(page, size = desktop) {
  await page.setViewportSize(size);
  await page.goto("/app");
  await enterKey(page);
  await expect(page.locator("#loading")).toBeHidden();
  await expect(page.locator("#stat-total")).toHaveText("8");
}
const noOverflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
async function createProject(page, name, fields = {}) {
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await page.getByLabel("Project name", { exact: true }).fill(name);
  if (fields.status)
    await page.getByLabel("Status", { exact: true }).selectOption(fields.status);
  await page.getByRole("button", { name: "Save project" }).click();
  await expect(page.locator("#project-dialog")).not.toBeVisible();
}
async function openProject(page, name) {
  await page.locator('[data-view="projects"]').click();
  await page.getByRole("searchbox").fill(name);
  await page
    .getByRole("button", { name: `Edit ${name}`, exact: true })
    .click();
  await expect(page.locator("#project-dialog")).toBeVisible();
}
async function deleteProject(page, name) {
  await openProject(page, name);
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Delete project", exact: true })
    .click();
  await expect(page.locator("#project-dialog")).not.toBeVisible();
}

test("desktop: sign in, create, edit, filter, settings, delete and sign out", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize(desktop);
  await page.goto("/app");
  await shot(page, "login-desktop");
  await signIn(page);
  await expect(page.locator("#nav-count")).toHaveText("8");
  await expect(page.locator("#stat-active")).toHaveText("4");
  await expect(page.locator("#stat-complete")).toHaveText("2");
  await expect(page.locator("#overview-scope")).toHaveCount(0);
  await shot(page, "dashboard-desktop");
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await shot(page, "project-dialog");
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
  await openProject(page, "Browser test <project>");
  await page.getByLabel("Status", { exact: true }).selectOption("complete");
  await page.getByRole("button", { name: "Save project" }).click();
  await expect(page.locator("#projects-table")).toContainText("Complete");
  await expect(page.locator("#projects-table")).toContainText("100%");
  await expect(page.locator("#nav-count")).toHaveText("9");
  await page.locator('[data-view="overview"]').click();
  await expect(page.locator("#stat-complete")).toHaveText("3");
  await page.locator('[data-view="settings"]').click();
  await expect(page.locator("#settings-view")).toBeVisible();
  await shot(page, "settings-desktop");
  // Two saves in a row: the second uses the version from the first.
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
  await expect(page.locator("#settings-error")).toBeEmpty();
  await deleteProject(page, "Browser test <project>");
  await expect(page.locator("#projects-table tbody tr")).toHaveCount(0);
  await expect(page.locator("#nav-count")).toHaveText("8");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.locator("#login")).toBeVisible();
  await page.reload();
  await expect(page.locator("#login")).toBeVisible();
  await page.goto("/");
  await shot(page, "home-desktop");
  expect(errors).toEqual([]);
});

test("mobile: usable navigation, dialog, no horizontal page overflow", async ({
  page,
}) => {
  await signIn(page, phone);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await shot(page, "dashboard-mobile");
  expect(await noOverflow(page)).toBe(true);
  // Each project is a card: every cell, the status chip too, is in view.
  const hidden = await page.evaluate(() => {
    const box = document.querySelector("#overview-table").getBoundingClientRect();
    return [...document.querySelectorAll("#overview-table td, #overview-table .status")]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return !r.width || r.left < box.left || r.right > box.right + 0.5;
      })
      .map((el) => el.textContent);
  });
  expect(hidden).toEqual([]);
  await expect(
    page.locator('#overview-table td[data-label="Owner"]').first(),
  ).toBeVisible();
  await page.setViewportSize({ width: 320, height: 844 });
  expect(await noOverflow(page)).toBe(true);
  await page.setViewportSize(phone);
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await expect(page.getByLabel("Project name", { exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#project-dialog")).not.toBeVisible();
  await page.locator('[data-view="projects"]').click();
  await page
    .getByRole("combobox", { name: "Filter by status" })
    .selectOption("complete");
  await expect(page.locator("#projects-table tbody tr")).toHaveCount(2);
  expect(await noOverflow(page)).toBe(true);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "A little less busywork",
  );
  expect(await noOverflow(page)).toBe(true);
  await shot(page, "home-mobile");
});

test("a failed save keeps the dialog and user input available for retry", async ({
  page,
}) => {
  await signIn(page);
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

test("filters by status and owner use the API and reset paging", async ({
  page,
}) => {
  // Make the unfiltered first page say that more exist.
  await page.route(/\/api\/projects$/, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: { ...body, hasMore: true, cursor: "next-page" },
    });
  });
  await signIn(page);
  await page.locator('[data-view="projects"]').click();
  await expect(page.locator("#load-more")).toBeVisible();
  await expect(page.locator("#result-count")).toHaveText(
    "8 projects loaded · more to load",
  );
  const owner = page.getByRole("combobox", { name: "Filter by owner" });
  const status = page.getByRole("combobox", { name: "Filter by status" });
  await expect(owner.locator("option")).toHaveText([
    "Anyone",
    "Alex Morgan",
    "Jamie Chen",
    "Sam Rivera",
    "Taylor Brooks",
  ]);
  const query = page.waitForRequest((r) =>
    r.url().includes("/api/projects?owner=jamie+chen"),
  );
  await owner.selectOption({ label: "Jamie Chen" });
  expect((await query).url()).not.toContain("cursor");
  await expect(page.locator("#projects-table tbody tr")).toHaveCount(2);
  await expect(page.locator("#load-more")).toBeHidden();
  await expect(page.locator("#result-count")).toHaveText("2 projects");
  await status.selectOption("active");
  await expect(page.locator("#projects-table tbody tr")).toHaveCount(1);
  await expect(page.locator("#projects-table")).toContainText(
    "Customer onboarding",
  );
  // The other owners stay in the list while one owner is chosen.
  await expect(owner.locator("option")).toHaveCount(5);
  await shot(page, "filtered-desktop");
  await page.setViewportSize(phone);
  expect(await noOverflow(page)).toBe(true);
  await shot(page, "filtered-mobile");
  await owner.selectOption({ label: "Anyone" });
  await expect(page.locator("#projects-table tbody tr")).toHaveCount(4);
  await status.selectOption("all");
  await expect(page.locator("#projects-table tbody tr")).toHaveCount(8);
});

test("summary counts follow a create and a delete", async ({ page }) => {
  await signIn(page);
  await createProject(page, "Counted project", { status: "active" });
  await expect(page.locator("#stat-total")).toHaveText("9");
  await expect(page.locator("#stat-active")).toHaveText("5");
  await expect(page.locator("#nav-count")).toHaveText("9");
  await deleteProject(page, "Counted project");
  await page.locator('[data-view="overview"]').click();
  await expect(page.locator("#stat-total")).toHaveText("8");
  await expect(page.locator("#stat-active")).toHaveText("4");
  await expect(page.locator("#nav-count")).toHaveText("8");
});

test("a duplicate name keeps the dialog open and marks the name field", async ({
  page,
}) => {
  await signIn(page);
  await page.getByRole("button", { name: "New project", exact: true }).click();
  const name = page.getByLabel("Project name", { exact: true });
  await name.fill(" website REFRESH ");
  await page.getByRole("button", { name: "Save project" }).click();
  await expect(page.locator("#project-name-error")).toHaveText(duplicateCopy);
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(name).toBeFocused();
  await expect(name).toHaveValue(" website REFRESH ");
  await expect(page.locator("#project-dialog")).toBeVisible();
  await expect(page.locator("#load-latest")).toBeHidden();
  await shot(page, "duplicate-desktop");
  await page.setViewportSize(phone);
  await shot(page, "duplicate-mobile");
  await page.keyboard.press("Escape");
  await expect(page.locator("#stat-total")).toHaveText("8");
});

test("two people edit one project: the second sees the conflict and loads the latest version", async ({
  browser,
}) => {
  const first = await (await browser.newContext()).newPage();
  const second = await (await browser.newContext()).newPage();
  await signIn(first);
  await signIn(second);
  await createProject(first, "Conflict test");
  await second.reload();
  await expect(second.locator("#stat-total")).toHaveText("9");
  await openProject(second, "Conflict test");
  await openProject(first, "Conflict test");
  await first.getByLabel("Progress (%)").fill("40");
  await first.getByRole("button", { name: "Save project" }).click();
  await expect(first.locator("#project-dialog")).not.toBeVisible();
  await second
    .getByLabel("Description", { exact: true })
    .last()
    .fill("My change");
  await second.getByRole("button", { name: "Save project" }).click();
  await expect(second.locator("#project-error")).toHaveText(conflictCopy);
  await expect(second.locator("#project-dialog")).toBeVisible();
  await expect(
    second.getByLabel("Description", { exact: true }).last(),
  ).toHaveValue("My change");
  const latest = second.getByRole("button", {
    name: "Load the latest version",
  });
  await expect(latest).toBeVisible();
  await shot(second, "conflict-desktop");
  await second.setViewportSize(phone);
  expect(await noOverflow(second)).toBe(true);
  await shot(second, "conflict-mobile");
  await second.setViewportSize(desktop);
  await latest.click();
  await expect(second.getByLabel("Progress (%)")).toHaveValue("40");
  await expect(second.locator("#project-note")).toContainText(
    "latest version",
  );
  await expect(latest).toBeHidden();
  await second.getByLabel("Progress (%)").fill("60");
  await second.getByRole("button", { name: "Save project" }).click();
  await expect(second.locator("#project-dialog")).not.toBeVisible();
  await expect(second.locator("#projects-table")).toContainText("60%");
  // A delete from the stale page is refused in the same way.
  await openProject(first, "Conflict test");
  first.once("dialog", (dialog) => dialog.accept());
  await first
    .getByRole("button", { name: "Delete project", exact: true })
    .click();
  await expect(first.locator("#project-dialog")).toBeVisible();
  await expect(first.locator("#project-error")).toHaveText(conflictCopy);
  await first.getByRole("button", { name: "Load the latest version" }).click();
  await expect(first.getByLabel("Progress (%)")).toHaveValue("60");
  first.once("dialog", (dialog) => dialog.accept());
  await first
    .getByRole("button", { name: "Delete project", exact: true })
    .click();
  await expect(first.locator("#project-dialog")).not.toBeVisible();
  await expect(first.locator("#nav-count")).toHaveText("8");
  await first.context().close();
  await second.context().close();
});

test("activity lists each change with its actor, action and project", async ({
  page,
}) => {
  await signIn(page);
  await createProject(page, "Activity test");
  await openProject(page, "Activity test");
  await page.getByLabel("Progress (%)").fill("30");
  await page.getByRole("button", { name: "Save project" }).click();
  await expect(page.locator("#project-dialog")).not.toBeVisible();
  await deleteProject(page, "Activity test");
  await page.locator('[data-view="activity"]').click();
  await expect(page.locator("#activity-view")).toBeVisible();
  const rows = page.locator("#activity-list .activity-row");
  await expect(rows.nth(0)).toContainText("Alex Morgan deleted Activity test");
  await expect(rows.nth(1)).toContainText("Alex Morgan updated Activity test");
  await expect(rows.nth(1)).toContainText("30% complete");
  await expect(rows.nth(2)).toContainText("Alex Morgan created Activity test");
  await expect(rows.nth(2)).toContainText("Planned · 0% complete");
  await shot(page, "activity-desktop");
  await page.setViewportSize(phone);
  expect(await noOverflow(page)).toBe(true);
  await shot(page, "activity-mobile");
});

test("a create is sent again once with the same request ID after a network failure; an edit is not", async ({
  page,
}) => {
  await signIn(page);
  const ids = [];
  await page.route("**/api/projects", (route) => {
    if (route.request().method() !== "POST") return route.continue();
    ids.push(route.request().headers()["x-request-id"]);
    return ids.length === 1 ? route.abort("failed") : route.continue();
  });
  await createProject(page, "Retry test");
  expect(ids).toHaveLength(2);
  expect(ids[0]).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  expect(ids[1]).toBe(ids[0]);
  await expect(page.locator("#stat-total")).toHaveText("9");
  let patches = 0;
  await page.route("**/api/projects/*", (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    patches += 1;
    return route.abort("failed");
  });
  await openProject(page, "Retry test");
  await page.getByRole("button", { name: "Save project" }).click();
  await expect(page.locator("#project-error")).toContainText(
    "Reload the page to check",
  );
  expect(patches).toBe(1);
  await page.keyboard.press("Escape");
  await deleteProject(page, "Retry test");
  await expect(page.locator("#nav-count")).toHaveText("8");
});

test("settings: a stale save shows the conflict and loads the latest settings", async ({
  browser,
}) => {
  const first = await (await browser.newContext()).newPage();
  const second = await (await browser.newContext()).newPage();
  for (const page of [first, second]) {
    await signIn(page);
    await page.locator('[data-view="settings"]').click();
  }
  const save = (page) =>
    page.getByRole("button", { name: "Save changes", exact: true }).click();
  await first
    .locator("#settings-description")
    .fill("Changed by the first person.");
  await save(first);
  await expect(first.locator("#notice")).toHaveText("Workspace details saved.");
  await second.getByLabel("Workspace name", { exact: true }).fill("Second name");
  await save(second);
  await expect(second.locator("#settings-error")).toHaveText(
    "Someone else changed these settings. Reload them to see their change.",
  );
  await expect(second.getByLabel("Workspace name", { exact: true })).toHaveValue(
    "Second name",
  );
  await second
    .getByRole("button", { name: "Load the latest version" })
    .click();
  await expect(second.locator("#settings-description")).toHaveValue(
    "Changed by the first person.",
  );
  await expect(second.locator("#settings-note")).toContainText("latest");
  await second
    .locator("#settings-description")
    .fill("A little space for our next big thing.");
  await save(second);
  await expect(second.locator("#notice")).toHaveText("Workspace details saved.");
  await expect(second.locator("#settings-error")).toBeEmpty();
  await first.context().close();
  await second.context().close();
});

test("activity loads more entries with the cursor", async ({ page }) => {
  const older = {
    id: "0000000000001-abcdef01",
    at: "2026-01-01T09:00:00.000Z",
    actor: "Jamie Chen",
    action: "created",
    project: {
      id: "f".repeat(32),
      name: "An older project",
      status: "planned",
      progress: 0,
      priority: "low",
    },
  };
  await page.route("**/api/activity**", async (route) => {
    if (new URL(route.request().url()).searchParams.get("cursor") === "older")
      return route.fulfill({
        json: { activity: [older], cursor: null, hasMore: false },
      });
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: { ...body, hasMore: true, cursor: "older" },
    });
  });
  await signIn(page);
  await page.locator('[data-view="activity"]').click();
  const more = page.getByRole("button", { name: "Load more activity" });
  await expect(more).toBeVisible();
  await more.click();
  await expect(page.locator("#activity-list .activity-row").last()).toContainText(
    "Jamie Chen created An older project",
  );
  await expect(more).toBeHidden();
});

test("a failed read shows the connection copy, not the may-have-been-saved copy", async ({
  page,
}) => {
  const offline = "Could not connect. Check your connection and try again.";
  await page.setViewportSize(desktop);
  // The first page load: the session read fails.
  await page.route("**/api/session", (route) =>
    route.request().method() === "GET" ? route.abort("failed") : route.continue(),
  );
  await page.goto("/app");
  await expect(page.locator("#login-error")).toHaveText(offline);
  await page.unroute("**/api/session");
  await enterKey(page);
  await expect(page.locator("#stat-total")).toHaveText("8");
  // A filter change: the list read fails.
  await page.route(/\/api\/projects\?status=/, (route) => route.abort("failed"));
  await page.locator('[data-view="projects"]').click();
  await page
    .getByRole("combobox", { name: "Filter by status" })
    .selectOption("active");
  await expect(page.locator("#notice")).toHaveText(offline);
  await expect(page.locator("#notice")).toHaveAttribute("role", "alert");
});

test("a create that fails twice tells the person to reload and check", async ({
  page,
}) => {
  await signIn(page);
  let posts = 0;
  await page.route("**/api/projects", (route) => {
    if (route.request().method() !== "POST") return route.continue();
    posts += 1;
    return route.abort("failed");
  });
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await page.getByLabel("Project name", { exact: true }).fill("Never saved");
  await page.getByRole("button", { name: "Save project" }).click();
  await expect(page.locator("#project-error")).toHaveText(
    "Could not connect. Your project may have been created. Reload the page to check before you save it again.",
  );
  expect(posts).toBe(2);
  await expect(page.getByLabel("Project name", { exact: true })).toHaveValue(
    "Never saved",
  );
});

test("the Overview Edit button opens a project that the Projects filter leaves out", async ({
  page,
}) => {
  await signIn(page);
  // A new project is planned, and the newest, so the Overview table shows it.
  await createProject(page, "Overview edit");
  await page.locator('[data-view="projects"]').click();
  const status = page.getByRole("combobox", { name: "Filter by status" });
  await status.selectOption("active");
  await expect(page.locator("#projects-table tbody tr")).toHaveCount(4);
  await expect(page.locator("#projects-table")).not.toContainText("Overview edit");
  await page.locator('[data-view="overview"]').click();
  await page
    .locator("#overview-table")
    .getByRole("button", { name: "Edit Overview edit", exact: true })
    .click();
  await expect(page.locator("#project-dialog")).toBeVisible();
  await expect(page.locator("#dialog-title")).toHaveText("A little fine-tuning.");
  await expect(page.getByLabel("Project name", { exact: true })).toHaveValue(
    "Overview edit",
  );
  await expect(
    page.getByRole("button", { name: "Delete project", exact: true }),
  ).toBeVisible();
  await page.locator("#project-description").fill("Edited from the overview");
  await page.getByRole("button", { name: "Save project" }).click();
  await expect(page.locator("#project-dialog")).not.toBeVisible();
  await expect(page.locator("#notice")).toHaveText(
    "Project updated. A little progress, made.",
  );
  await expect(page.locator("#overview-table")).toContainText(
    "Edited from the overview",
  );
  // The saved project is still planned: it stays out of the active list.
  await page.locator('[data-view="projects"]').click();
  await expect(page.locator("#projects-table tbody tr")).toHaveCount(4);
  await status.selectOption("all");
  await expect(page.locator("#projects-table")).toContainText(
    "Edited from the overview",
  );
  await expect(page.locator("#stat-total")).toHaveText("9");
  await deleteProject(page, "Overview edit");
  await expect(page.locator("#nav-count")).toHaveText("8");
});
