import type { Registry, Extension } from "@earendil-works/pi-durable";
import { createExpertsExtension } from "./experts.js";
import { createMemoryClient } from "./memory-client.js";
import { createMemoryExtension } from "./memory.js";
import type { OnboardOptions } from "./config.js";
import { createPlaybookExtension } from "./playbook.js";
import { createSkillsExtension } from "./skills.js";
import { createWebExtension } from "./web.js";

export interface OnboardInstallContext {
  /** Core capabilities that expert children need in addition to memory, skills, and web. */
  childBaseExtensions: readonly Extension[];
  /** Canonical writer-tool names used to enforce read-only expert profiles. */
  writeTools: ReadonlySet<string>;
}

/** Install the opt-in onboarding extensions and configure the exact base tools delegated experts inherit. */
export function installOnboard(registry: Registry, options: OnboardOptions, context: OnboardInstallContext): Extension[] {
  const client = createMemoryClient(options);
  const skills = createSkillsExtension(options);
  const memory = createMemoryExtension(client);
  const web = createWebExtension();
  const extensions: Extension[] = [
    skills,
    memory,
    web,
    createPlaybookExtension(options.setupDir),
    createExpertsExtension(client, {
      maxChildren: options.maxChildren,
      childExtensions: [...context.childBaseExtensions, memory, skills, web],
      writeTools: context.writeTools,
    }),
  ];
  for (const extension of extensions) registry.install(extension);
  return extensions;
}
