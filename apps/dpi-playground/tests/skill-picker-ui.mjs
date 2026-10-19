import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const { chromium, expect } = require("@playwright/test");
const root = resolve(import.meta.dirname, "../apps/dpi-playground-fe");
const fixture = resolve(import.meta.dirname, "skill-picker.html");
const catalogFixture = resolve(import.meta.dirname, "./fixtures/real-skill-catalog.json");
const vite = await createServer({
  configFile: resolve(root, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 0, strictPort: false },
  plugins: [
    {
      name: "skill-picker-test-fixture",
      configureServer(server) {
        server.middlewares.use("/__skill_picker_test", async (_req, res, next) => {
          try {
            res.statusCode = 200;
            res.setHeader("content-type", "text/html; charset=utf-8");
            res.end(
              await server.transformIndexHtml(
                "/__skill_picker_test",
                await readFile(fixture, "utf8"),
              ),
            );
          } catch (error) {
            next(error);
          }
        });
      },
    },
  ],
});

let browser;
try {
  await vite.listen();
  const address = vite.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("Vite did not bind a local port");
  const catalog = await readFile(catalogFixture, "utf8");
  const requests = [];
  const browserErrors = [];
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
  await page.emulateMedia({ colorScheme: "dark" });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  await page.route("**/api/devices/local/v1/skills", async (route) => {
    requests.push(route.request().url());
    await route.fulfill({ status: 200, contentType: "application/json", body: catalog });
  });
  await page.route(
    "**/api/devices/local/v1/sessions/skill-test/agents/1/messages",
    async (route) => {
      requests.push(JSON.parse(route.request().postData() ?? "{}"));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          submissionId: requests.filter((x) => typeof x === "object").length,
          status: "queued",
        }),
      });
    },
  );

  await page.goto(`http://127.0.0.1:${address.port}/__skill_picker_test`);
  const composer = page.getByRole("textbox", { name: "Message your agent" });
  const options = page.getByRole("option");
  await composer.fill("/");
  await expect(page.getByRole("listbox", { name: "Slash commands" })).toBeVisible();
  await expect(options.filter({ hasText: "/compact" })).toHaveCount(1);
  await expect(options.filter({ hasText: "/frontend-design" })).toHaveCount(1);
  await expect(page.getByText("command", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("skill", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("prompt", { exact: true })).toBeVisible();
  assert.equal(requests.filter((request) => typeof request === "string").length, 1);
  await composer.press("ArrowDown");
  await expect(options.nth(0)).toHaveAttribute("aria-selected", "false");
  await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
  await composer.press("ArrowUp");
  await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(options.nth(1)).toHaveAttribute("aria-selected", "false");
  assert.equal(
    await page.locator(".slash-menu").evaluate((menu) => getComputedStyle(menu).backgroundColor),
    "rgb(37, 26, 27)",
  );
  await composer.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    "the skill menu fits a phone-width viewport without horizontal overflow",
  );

  await composer.fill("");
  await composer.fill("/frontend-design");
  await expect(options.filter({ hasText: "/frontend-design" })).toHaveCount(1);
  await composer.press("Tab");
  await expect(composer).toHaveValue("/frontend-design ");
  await expect
    .poll(() => composer.evaluate((input) => input.selectionStart))
    .toBe("/frontend-design ".length);
  await composer.pressSequentially("design a dashboard");
  await composer.press("Enter");
  await expect.poll(() => requests.filter((request) => typeof request === "object").length).toBe(1);
  await expect(composer).toHaveValue("");
  assert.equal(
    requests.find((request) => typeof request === "object").content,
    "/frontend-design design a dashboard",
  );

  await composer.fill("/brain");
  const brainstorm = options.filter({ hasText: "/brainstorm" });
  await expect(brainstorm).toHaveCount(1);
  await brainstorm.dispatchEvent("mousedown");
  await expect(composer).toHaveValue("/brainstorm ");
  await expect
    .poll(() => composer.evaluate((input) => input.selectionStart))
    .toBe("/brainstorm ".length);

  await composer.fill("/grill");
  await expect(options.filter({ hasText: "/grill" })).toHaveCount(1);
  await composer.press("Enter");
  await expect(composer).toHaveValue("/grill ");
  assert.equal(requests.filter((request) => typeof request === "object").length, 1);
  await composer.pressSequentially("refine this workflow");
  await composer.press("Enter");
  await expect.poll(() => requests.filter((request) => typeof request === "object").length).toBe(2);
  await expect(composer).toHaveValue("");
  assert.equal(
    requests.filter((request) => typeof request === "object")[1].content,
    "/grill refine this workflow",
  );

  await composer.fill("/help");
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
  assert.equal(await page.evaluate(() => window.__skillPickerState.ui.dialog?.kind), "help");
  assert.equal(requests.filter((request) => typeof request === "object").length, 2);
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    "the composer remains within the mobile viewport",
  );
  assert.deepEqual(browserErrors, [], "the picker has no browser errors");

  const unavailablePage = await browser.newPage({ viewport: { width: 375, height: 812 } });
  const unavailableErrors = [];
  unavailablePage.on("pageerror", (error) => unavailableErrors.push(error.message));
  await unavailablePage.route("**/api/devices/local/v1/skills", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "unavailable", message: "Offline" } }),
    });
  });
  await unavailablePage.goto(`http://127.0.0.1:${address.port}/__skill_picker_test`);
  const unavailableComposer = unavailablePage.getByRole("textbox", { name: "Message your agent" });
  await unavailableComposer.fill("/");
  await expect(unavailablePage.getByRole("option").filter({ hasText: "/help" })).toHaveCount(1);
  await expect(unavailablePage.getByText("/brainstorm")).toHaveCount(0);
  await expect(unavailablePage.getByRole("alert")).toHaveCount(0);
  assert.deepEqual(unavailableErrors, [], "an unavailable catalog is silently ignored");
  await unavailablePage.close();

  console.log(
    "PASS skill picker: merged menu, keyboard/mouse completion, normal send, mobile layout and offline fallback",
  );
} finally {
  await browser?.close();
  await vite.close();
}
