import type { Registry, Extension } from "@earendil-works/pi-durable";
import { createMemoryClient } from "./memory-client.js";
import { createMemoryExtension } from "./memory.js";
import type { OnboardOptions } from "./config.js";
import { createPlaybookExtension } from "./playbook.js";
import { createSkillsExtension } from "./skills.js";
import { createWebExtension } from "./web.js";

/** Install the Phase 1 onboarding extensions into one device's registry. The caller owns rollout selection. */
export function installOnboard(registry: Registry, options: OnboardOptions): Extension[] {
  const extensions: Extension[] = [
    createSkillsExtension(options),
    createMemoryExtension(createMemoryClient(options)),
    createWebExtension(),
    createPlaybookExtension(options.setupDir),
  ];
  for (const extension of extensions) registry.install(extension);
  return extensions;
}
