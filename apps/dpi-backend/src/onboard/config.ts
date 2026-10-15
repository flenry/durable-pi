// Onboard configuration: everything comes from env so the fork holds no personal paths or hosts.
//
//   DPI_ONBOARD         1 opts in to Phase 1 extensions; 0 or unset preserves legacy behavior
//   PI_SETUP_DIR        the pi setup checkout (skills, experts, playbook, memory CLI); default ~/.pi
//   DPI_MEMORY          local | ssh | off — where the memory CLI runs (default local)
//   DPI_MEMORY_HOST     ssh alias of the memory host when DPI_MEMORY=ssh (e.g. memory-host)
//   DPI_SKILLS_EXCLUDE  comma list of skills not offered to durable agents
//   DPI_MAX_CHILDREN    live delegate children allowed per session (default 2)
//   DPI_TICKETS         1 enables the durable hourly ticket scheduler (default 0)
import { homedir } from "node:os";
import { join } from "node:path";

export function onboardEnabledFromEnv(env = process.env): boolean {
  const enabled = env.DPI_ONBOARD ?? "0";
  if (enabled === "1") return true;
  if (enabled === "0") return false;
  throw Error(`DPI_ONBOARD must be 0 or 1; got ${enabled}`);
}

export interface OnboardOptions {
  setupDir: string;
  memory: "local" | "ssh" | "off";
  memoryHost: string;
  skillsExclude: string[];
  maxChildren: number;
  ticketScheduler?: boolean;
}

/** Skills that drive pi-only machinery (Herdr, worktree workers, pi's own handoff). */
export const DEFAULT_SKILLS_EXCLUDE = ["herdr", "spawn-worker", "handoff"];

export function onboardOptionsFromEnv(env = process.env): OnboardOptions {
  const memory = env.DPI_MEMORY ?? "local";
  if (memory !== "local" && memory !== "ssh" && memory !== "off")
    throw Error(`DPI_MEMORY must be local, ssh, or off; got ${memory}`);
  const memoryHost = env.DPI_MEMORY_HOST ?? "";
  if (memory === "ssh" && !memoryHost) throw Error("DPI_MEMORY=ssh needs DPI_MEMORY_HOST (an ssh alias)");
  const maxChildrenText = env.DPI_MAX_CHILDREN ?? "2";
  const maxChildren = Number(maxChildrenText);
  if (!/^[1-9]\d*$/.test(maxChildrenText) || !Number.isSafeInteger(maxChildren))
    throw Error(`DPI_MAX_CHILDREN must be a positive safe integer; got ${maxChildrenText}`);
  const ticketFlag = env.DPI_TICKETS ?? "0";
  if (ticketFlag !== "0" && ticketFlag !== "1") throw Error(`DPI_TICKETS must be 0 or 1; got ${ticketFlag}`);
  const setupDir = env.PI_SETUP_DIR ?? "~/.pi";
  if (!setupDir.trim()) throw Error("PI_SETUP_DIR must not be empty");
  const expand = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
  return {
    setupDir: expand(setupDir),
    memory,
    memoryHost,
    skillsExclude: (env.DPI_SKILLS_EXCLUDE ?? DEFAULT_SKILLS_EXCLUDE.join(","))
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    maxChildren,
    ticketScheduler: ticketFlag === "1",
  };
}
