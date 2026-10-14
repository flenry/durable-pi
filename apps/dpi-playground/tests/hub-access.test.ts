import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { access, accessOptionsFromEnv, extraAllowedHosts } from "../apps/dpi-playground-hub/src/access.js";

function run(mw: ReturnType<typeof access>, req: { method?: string; path?: string; headers?: Record<string, string> }) {
  const out = { status: 200, nexted: false, body: "" };
  const res = {
    status(code: number) { out.status = code; return res; },
    type() { return res; },
    send(body: string) { out.body = body; return res; },
  };
  mw(
    { method: req.method ?? "GET", path: req.path ?? "/", headers: req.headers ?? {}, socket: { remoteAddress: "10.0.0.1" } } as never,
    res as never,
    () => { out.nexted = true; },
  );
  return out;
}

test("allowlisted identity passes; others and anonymous requests get 403 and are logged", () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-access-"));
  const logFile = join(dir, "access.log");
  const mw = access({ allowedEmails: ["me@example.com"], identityHeader: "x-exedev-email", logFile, now: () => new Date("2026-10-15T00:00:00Z") });
  assert.equal(run(mw, { path: "/api/network", headers: { "x-exedev-email": "Me@Example.com" } }).nexted, true);
  const other = run(mw, { path: "/", headers: { "x-exedev-email": "evil@example.com", "x-forwarded-for": "6.6.6.6, 1.2.3.4" } });
  assert.equal(other.status, 403);
  assert.equal(other.nexted, false);
  assert.equal(run(mw, { path: "/api/stream" }).status, 403);
  const log = readFileSync(logFile, "utf8");
  assert.match(log, /DENY evil@example\.com 1\.2\.3\.4 GET \//); // last X-Forwarded-For hop, not the spoofable first
  assert.match(log, /DENY - 10\.0\.0\.1 GET \/api\/stream/);
  rmSync(dir, { recursive: true, force: true });
});

test("writes and page loads are logged; reads and assets are not", () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-access-"));
  const logFile = join(dir, "access.log");
  const mw = access({ allowedEmails: ["me@example.com"], identityHeader: "x-exedev-email", logFile });
  const me = { "x-exedev-email": "me@example.com" };
  run(mw, { method: "PUT", path: "/api/ui-state/x", headers: me });
  run(mw, { path: "/", headers: { ...me, accept: "text/html" } });
  run(mw, { path: "/api/network", headers: me });
  run(mw, { path: "/assets/app.js", headers: { ...me, accept: "*/*" } });
  const lines = readFileSync(logFile, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /WRITE me@example\.com .* PUT \/api\/ui-state\/x/);
  assert.match(lines[1], /VISIT me@example\.com .* \//);
  rmSync(dir, { recursive: true, force: true });
});

test("no allowlist configured means no gate and no log (local laptop use stays unchanged)", () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-access-"));
  const logFile = join(dir, "access.log");
  const mw = access({ allowedEmails: [], identityHeader: "x-exedev-email", logFile });
  assert.equal(run(mw, { path: "/" }).nexted, true);
  assert.equal(run(mw, { method: "POST", path: "/api/devices" }).nexted, true);
  assert.equal(existsSync(logFile), false);
  rmSync(dir, { recursive: true, force: true });
});

test("env parsing", () => {
  assert.deepEqual(accessOptionsFromEnv({ DPI_HUB_ALLOWED_EMAILS: " A@x.com, b@y.com ," }).allowedEmails, ["a@x.com", "b@y.com"]);
  assert.equal(accessOptionsFromEnv({}).identityHeader, "x-exedev-email");
  assert.deepEqual(extraAllowedHosts({ DPI_HUB_ALLOWED_HOSTS: "Command-Center.exe.xyz" }), ["command-center.exe.xyz"]);
});
