// Access control for a hub served through an identity-aware proxy (e.g. exe.dev's private HTTPS
// proxy, which signs the user in and adds X-ExeDev-Email). Runs before everything the hub serves —
// the UI, the API, and SSE streams — so an unlisted identity sees nothing.
//
//   DPI_HUB_ALLOWED_EMAILS   comma-separated allowlist; when set, every request must carry an
//                            allowed identity header or it gets 403
//   DPI_HUB_IDENTITY_HEADER  header holding the signed-in email (default x-exedev-email)
//   DPI_HUB_ACCESS_LOG       file for the access log (default ~/.dpi/hub-access.log)
//
// With an allowlist set, the log records every denial, every write (non-GET), and every page load —
// never tokens or bodies. Without one, this middleware is a no-op.
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { RequestHandler } from "express";

export interface AccessOptions {
  allowedEmails: string[];
  identityHeader: string;
  logFile: string;
  now?: () => Date;
}

export function accessOptionsFromEnv(env = process.env): AccessOptions {
  return {
    allowedEmails: (env.DPI_HUB_ALLOWED_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
    identityHeader: (env.DPI_HUB_IDENTITY_HEADER ?? "x-exedev-email").toLowerCase(),
    logFile: env.DPI_HUB_ACCESS_LOG ?? join(homedir(), ".dpi", "hub-access.log"),
  };
}

/** Extra Host values the guard accepts, e.g. the proxy's public hostname. */
export function extraAllowedHosts(env = process.env): string[] {
  return (env.DPI_HUB_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

const isPageLoad = (method: string, path: string, accept = "") =>
  method === "GET" && !path.startsWith("/api") && accept.includes("text/html");

export function access(options: AccessOptions): RequestHandler {
  const allowed = new Set(options.allowedEmails);
  const now = options.now ?? (() => new Date());
  const log = (line: string) => {
    try {
      mkdirSync(dirname(options.logFile), { recursive: true });
      appendFileSync(options.logFile, `${now().toISOString()} ${line}\n`, { mode: 0o600 });
    } catch {
      // logging must never take the hub down
    }
  };
  // No allowlist: the hub is on a trusted machine (Dan's default laptop setup) — no gate, no log.
  if (allowed.size === 0) return (_req, _res, next) => next();
  return (req, res, next) => {
    const raw = req.headers[options.identityHeader];
    const email = (Array.isArray(raw) ? raw[0] : raw)?.trim().toLowerCase() ?? "";
    // exe.dev appends the client IP it saw; earlier entries are client-supplied and spoofable.
    const ip = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "-").split(",").pop()!.trim();
    const path = req.path;
    if (!allowed.has(email)) {
      log(`DENY ${email || "-"} ${ip} ${req.method} ${path}`);
      res.status(403).type("text/plain").send("Forbidden: this hub only serves its owner.");
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") log(`WRITE ${email || "-"} ${ip} ${req.method} ${path}`);
    else if (isPageLoad(req.method, path, req.headers.accept)) log(`VISIT ${email || "-"} ${ip} ${path}`);
    next();
  };
}
