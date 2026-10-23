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
  /** Core capabilities that expert children need in addition to memory, skills, web, and durable guards. */
  childBaseExtensions: readonly Extension[];
  /** Host-created guard instance shared by roots, forks, delegated children and ticket workers. */
  guards: Extension;
  /** Device-wide persisted App State; tickets use it as the single queue for this device. */
  shared: TicketStateHost;
  device: string;
  nameConversation: (conversationId: number, name: string) => void;
  abortTask: (taskId: number) => Promise<unknown>;
  afterReminderWakeSubmit?: (reminderId: string) => void | Promise<void>;
  autoCloseConversation?: (conversationId: number, key: string) => Promise<void>;
}

/** Install the opt-in onboarding extensions and configure the exact base tools delegated experts inherit. */
export function installOnboard(registry: Registry, options: OnboardOptions, context: OnboardInstallContext): Extension[] {
  const client = createMemoryClient(options);
  const skills = createSkillsExtension(options);
  const memory = createMemoryExtension(client);
  const web = createWebExtension();
  const extensions: Extension[] = [
    context.guards,
    skills,
    memory,
    web,
    createPlaybookExtension(options.setupDir),
    createExpertsExtension(client, {
      maxChildren: options.maxChildren,
      delegateModel: options.delegateModel,
      childExtensions: [...context.childBaseExtensions, context.guards, memory, skills, web],
      nameConversation: context.nameConversation,
      autoCloseConversation: context.autoCloseConversation,
    }),
    createTicketsExtension(context.shared, {
      device: context.device,
      delegateModel: options.delegateModel,
      childExtensionNames: [...context.childBaseExtensions, context.guards, memory, skills, web].map((extension) => extension.name),
      memory: client,
      schedulerEnabled: options.ticketScheduler,
      nameConversation: context.nameConversation,
      autoCloseConversation: context.autoCloseConversation,
    }),
    createRemindExtension({ abortTask: context.abortTask, afterWakeSubmit: context.afterReminderWakeSubmit }),
  ];
  for (const extension of extensions) registry.install(extension);
  return extensions;
}
