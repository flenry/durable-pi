import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const { chromium, expect } = require("@playwright/test");
const root = resolve(import.meta.dirname, "../apps/dpi-playground-fe");
const fixture = resolve(import.meta.dirname, "agent-close.html");
const vite = await createServer({
  configFile: resolve(root, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 0, strictPort: false },
  plugins: [{
    name: "agent-close-test-fixture",
    configureServer(server) {
      server.middlewares.use("/__agent_close_test", async (_req, res, next) => {
        try {
          res.statusCode = 200;
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.end(await server.transformIndexHtml("/__agent_close_test", await readFile(fixture, "utf8")));
        } catch (error) {
          next(error);
        }
      });
    },
  }],
});

let browser;
try {
  await vite.listen();
  const address = vite.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("Vite did not bind a local port");
  const calls = [];
  let closed = false;
  let busyOnce = false;
  const tree = (includeClosed) => ({
    uid: "device-uid", name: "Local", at: Date.now(),
    sessions: [{
      id: "close-test", name: "Close test", cwd: "/tmp", model: "test", createdAt: 1,
      dbPath: "/tmp/session.db", busy: false,
      agents: [
        { id: 1, name: "Main", named: false, kind: "root", busy: false, background: 0, closed: false },
        ...((includeClosed || !closed) ? [{ id: 2, name: "Worker", named: true, kind: "subagent", ownerAgentId: 1, busy: false, background: 0, closed }] : []),
        { id: 3, name: "Busy worker", named: true, kind: "subagent", ownerAgentId: 1, busy: true, background: 0, closed: false },
      ],
    }],
  });
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (entry) => {
    if (entry.type() === "error" && !entry.text().includes("409 (Conflict)")) errors.push(entry.text());
  });
  await page.route("**/api/devices/local/v1/tree**", async (route) => {
    const includeClosed = new URL(route.request().url()).searchParams.get("closed") === "1";
    calls.push({ method: "GET", closed: includeClosed });
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(tree(includeClosed)) });
  });
  await page.route("**/api/devices/local/v1/sessions/close-test/agents/2", async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: 2, name: "Worker", named: true, kind: "subagent", ownerAgentId: 1, busy: false, background: 0, closed }) });
      return;
    }
    const body = route.request().postDataJSON();
    calls.push({ method: "PATCH", ...body });
    if (body.closed && !body.abort && busyOnce) {
      busyOnce = false;
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: { code: "busy", message: "Agent is busy" } }) });
      return;
    }
    closed = body.closed;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: 2, name: "Worker", named: true, kind: "subagent", ownerAgentId: 1, busy: false, background: 0, closed }) });
  });
  await page.goto(`http://127.0.0.1:${address.port}/__agent_close_test`);
  const worker = page.getByRole("treeitem", { name: /Worker/ });
  const close = page.getByRole("button", { name: "Close agent Worker" });
  await expect(worker).toBeVisible();
  await close.click();
  await expect(worker).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__agentCloseState.selected.value.agentId)).toBe(1);
  assert.ok(calls.some((call) => call.method === "PATCH" && call.closed === true));
  assert.ok(calls.some((call) => call.method === "GET"), "the tree refreshes after the successful PATCH");

  // Recreate a live child to exercise the busy confirmation, then the abort retry.
  closed = false;
  await page.getByLabel("Show closed").check();
  await expect(page.getByRole("button", { name: "Reopen agent Worker" })).toBeVisible();
  await page.getByRole("button", { name: "Reopen agent Worker" }).click();
  await expect(page.getByRole("button", { name: "Close agent Worker" })).toBeVisible({ timeout: 10000 });
  busyOnce = true;
  await page.getByRole("button", { name: "Close agent Worker" }).click();
  await expect(page.getByRole("dialog", { name: "Stop and close?" })).toBeVisible();
  await page.getByRole("button", { name: "Stop and close" }).click();
  await expect(page.getByRole("treeitem", { name: /Worker/ })).toHaveCount(1);
  assert.ok(calls.some((call) => call.method === "PATCH" && call.closed === true && call.abort === true));

  // Closed children stay dimmed and actionable when the inclusive listing is enabled.
  await expect(page.getByRole("button", { name: "Reopen agent Worker" })).toBeVisible();
  assert.ok(await page.getByRole("treeitem", { name: /Worker/ }).evaluate((row) => Number(getComputedStyle(row).opacity) < 1));
  assert.ok(calls.some((call) => call.method === "GET" && call.closed));
  await page.getByRole("button", { name: "Reopen agent Worker" }).click();
  await expect(page.getByRole("button", { name: "Close agent Worker" })).toBeVisible();
  assert.ok(calls.some((call) => call.method === "PATCH" && call.closed === false));

  const bulkClose = page.getByRole("button", { name: "Close 1 finished" });
  await expect(bulkClose).toBeVisible();
  await bulkClose.click();
  await expect.poll(() => page.evaluate(() => window.__agentCloseState.ui.error)).toBe("");
  await expect(page.getByRole("button", { name: "Reopen agent Worker" })).toBeVisible();
  await expect(page.getByRole("treeitem", { name: /Busy worker/ })).toBeVisible();
  assert.ok(calls.some((call) => call.method === "PATCH" && call.closed === true && !call.abort));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "agent actions fit phone width");
  assert.deepEqual(errors, []);
  console.log("PASS agent close: idle, busy abort confirmation, reopen, bulk close skips busy, phone width");
} finally {
  await browser?.close();
  await vite.close();
}
