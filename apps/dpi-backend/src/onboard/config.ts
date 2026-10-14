// Onboard configuration: everything comes from env so the fork holds no personal paths or hosts.
//
//   PI_SETUP_DIR        the pi setup checkout (skills, experts, playbook, memory CLI); default ~/.pi
//   DPI_MEMORY          local | ssh | off — where the memory CLI runs (default local)
//   DPI_MEMORY_HOST     ssh alias of the memory host when DPI_MEMORY=ssh (e.g. memory-host)
//   DPI_SKILLS_EXCLUDE  comma list of skills not offered to durable agents
import { homedir } from "node:os";
import { join } from "node:path";

export interface OnboardOptions {
  setupDir: string;
  memory: "local" | "ssh" | "off";
  memoryHost: string;
  skillsExclude: string[];
}

/** Skills that drive pi-only machinery (Herdr, worktree workers, pi's own handoff). */
export const DEFAULT_SKILLS_EXCLUDE = ["herdr", "spawn-worker", "handoff"];

export function onboardOptionsFromEnv(env = process.env): OnboardOptions {
  const memory = env.DPI_MEMORY ?? "local";
  if (memory !== "local" && memory !== "ssh" && memory !== "off")
    throw Error(`DPI_MEMORY must be local, ssh, or off; got ${memory}`);
  const memoryHost = env.DPI_MEMORY_HOST ?? "";
  if (memory === "ssh" && !memoryHost) throw Error("DPI_MEMORY=ssh needs DPI_MEMORY_HOST (an ssh alias)");
  const expand = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
  return {
    setupDir: expand(env.PI_SETUP_DIR ?? "~/.pi"),
    memory,
    memoryHost,
    skillsExclude: (env.DPI_SKILLS_EXCLUDE ?? DEFAULT_SKILLS_EXCLUDE.join(","))
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
