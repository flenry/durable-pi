import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const { chromium, expect } = require("@playwright/test");
const root = resolve(import.meta.dirname, "../apps/dpi-playground-fe");
const fixture = resolve(import.meta.dirname, "guard-approval.html");
const transcriptFixture = resolve(
  import.meta.dirname,
  "./fixtures/real-blocked-transcript.json",
);
const vite = await createServer({
  configFile: resolve(root, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 0, strictPort: false },
  plugins: [
    {
      name: "guard-approval-test-fixture",
      configureServer(server) {
        server.middlewares.use("/__guard_approval_fixture", async (_req, res, next) => {
          try {
            const { readFile } = await import("node:fs/promises");
            res.statusCode = 200;
            res.setHeader("content-type", "application/json; charset=utf-8");
            res.end(await readFile(transcriptFixture, "utf8"));
          } catch (error) {
            next(error);
          }
        });
        server.middlewares.use("/__guard_approval_test", async (_req, res, next) => {
          try {
            const { readFile } = await import("node:fs/promises");
            res.statusCode = 200;
            res.setHeader("content-type", "text/html; charset=utf-8");
            res.end(
              await server.transformIndexHtml(
                "/__guard_approval_test",
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
  const hash = "527e6747ce5a7156cea93abc30891efc199ee75b99fc2540bd86c7f341f3cb3c";
  const requests = [];
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  await page.route(
    "**/api/devices/local/v1/sessions/approval-test/agents/1/messages",
    async (route) => {
      requests.push(JSON.parse(route.request().postData() ?? "{}"));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ submissionId: 1, status: "queued" }),
      });
    },
  );

  await page.goto(`http://127.0.0.1:${address.port}/__guard_approval_test`);
  await expect(page.getByText("Destructive command blocked")).toBeVisible();
  await expect(page.getByText("rm -rf", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Recursive force-delete — can wipe directories irrecoverably.", { exact: true }),
  ).toBeVisible();
  const toolCall = page.locator(".tool-call");
  await expect(toolCall).toHaveAttribute("open", "");
  const approve = toolCall.getByRole("button", { name: "Approve once" });
  await expect(approve).toBeVisible();
  await approve.focus();
  await approve.press("Enter");
  const sent = page.getByRole("button", { name: "Approval sent" });
  await expect(sent).toBeDisabled();
  await expect(page.getByText("Approval message sent to the root agent.")).toBeVisible();
  await sent.evaluate((button) => button.click());
  await page.waitForTimeout(25);
  assert.equal(requests.length, 1, "the sent button cannot submit a second time");
  assert.equal(requests[0].content, `approve ${hash}`);
  assert.equal(requests[0].whenBusy, "followUp");
  assert.ok(requests[0].requestId, "the approval submission has a fresh request ID");
  assert.ok((await sent.boundingBox())?.width <= 375, "the action fits a phone-width viewport");
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    "the approval card does not cause horizontal overflow on mobile",
  );
  assert.deepEqual(browserErrors, [], "the approval UI has no browser errors");
  console.log(
    "PASS guard approval UI: accessible action, exact message, sent state and mobile width",
  );
} finally {
  await browser?.close();
  await vite.close();
}
