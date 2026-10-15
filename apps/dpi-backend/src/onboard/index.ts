import type { Registry, Extension } from "@earendil-works/pi-durable";
import { createExpertsExtension } from "./experts.js";
import { createMemoryClient } from "./memory-client.js";
import { createMemoryExtension } from "./memory.js";
import type { OnboardOptions } from "./config.js";
import { createPlaybookExtension } from "./playbook.js";
import { createSkillsExtension } from "./skills.js";
import { createWebExtension } from "./web.js";
import { createTicketsExtension } from "./tickets.js";
import { createRemindExtension } from "./remind.js";
import type { TicketStateHost } from "./tickets.js";

export interface OnboardInstallContext {
  /** Core capabilities that expert children need in addition to memory, skills, and web. */
  childBaseExtensions: readonly Extension[];
  /** Device-wide persisted App State; tickets use it as the single queue for this device. */
  shared: TicketStateHost;
  device: string;
  nameConversation: (conversationId: number, name: string) => void;
  abortTask: (taskId: number) => Promise<unknown>;
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
      nameConversation: context.nameConversation,
    }),
    createTicketsExtension(context.shared, {
      device: context.device,
      childExtensionNames: [...context.childBaseExtensions, memory, skills, web].map((extension) => extension.name),
      memory: client,
      schedulerEnabled: options.ticketScheduler,
      nameConversation: context.nameConversation,
    }),
    createRemindExtension({ abortTask: context.abortTask }),
  ];
  for (const extension of extensions) registry.install(extension);
  return extensions;
}
