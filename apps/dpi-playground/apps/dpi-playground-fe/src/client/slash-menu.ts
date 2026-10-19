import type { SkillCatalogEntry } from "@sdk/api";
import type { SlashCommand } from "./commands";

export type SlashMenuKind = "command" | SkillCatalogEntry["kind"];
export type BuiltinSlashCommand = Pick<SlashCommand, "name" | "args" | "description">;

export interface SlashMenuItem {
  name: string;
  description: string;
  args?: string;
  kind: SlashMenuKind;
}

/** Combine local commands with the selected device's catalog; local commands take precedence. */
export function mergeSlashMenu(
  commands: readonly BuiltinSlashCommand[],
  catalog: readonly SkillCatalogEntry[],
): SlashMenuItem[] {
  const builtInNames = new Set(commands.map((command) => command.name));
  return [
    ...commands.map((command) => ({ ...command, kind: "command" as const })),
    ...catalog
      .filter((entry) => !builtInNames.has(entry.name))
      .map(({ name, description, kind }) => ({ name, description, kind })),
  ];
}

/** Filter suggestions by a slash-command name prefix. */
export function filterSlashMenu(items: readonly SlashMenuItem[], query: string): SlashMenuItem[] {
  const prefix = query.toLowerCase();
  return items.filter((item) => item.name.toLowerCase().startsWith(prefix));
}
