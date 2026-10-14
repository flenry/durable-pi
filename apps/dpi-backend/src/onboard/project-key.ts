// Project identity, same rules as the pi setup: a repo is keyed by its git remote
// (host/owner/repo), so every clone and worktree on every device shares one memory; a repo
// without a remote is local/<name>. Computed on the device that has the checkout.
import { execFileSync } from "node:child_process";
import { basename, dirname } from "node:path";

const kebab = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";

/** git@github.com:o/r.git, https://user@github.com/o/r → github.com/o/r */
export function normalizeRemote(url: string): string | undefined {
  const u = url.trim();
  const std = /^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(u);
  const scp = /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)(.+)$/.exec(u);
  const m = std ?? scp;
  if (!m) return undefined;
  const parts = m[2]
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
    .split("/")
    .filter(Boolean)
    .map(kebab);
  return parts.length ? [m[1].toLowerCase(), ...parts].join("/") : undefined;
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

export function projectKeyFor(cwd: string): string {
  const remotes = git(cwd, ["remote"])?.split("\n") ?? [];
  const remote = remotes.includes("origin") ? "origin" : remotes[0];
  const url = remote ? git(cwd, ["remote", "get-url", remote]) : undefined;
  const key = url ? normalizeRemote(url) : undefined;
  if (key) return key;
  const common = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const base = common
    ? basename(common) === ".git"
      ? basename(dirname(common))
      : basename(common).replace(/\.git$/, "")
    : basename(cwd);
  return `local/${kebab(base)}`;
}
