// Durable memory tools and per-request project-memory context. Project paths are reduced to a
// stable key on this device; only that key crosses MemoryClient to pi-setup.
import { Type } from "@earendil-works/pi-ai";
import { ROOT_CONVERSATION_ID, defineExtension, defineTool, section, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { ExpertIdentity } from "./experts.js";
import { projectKeyFor } from "./project-key.js";
import type { MemoryClient } from "./memory-client.js";

type NoteResult = { file: string; chars: number; overCap: boolean; created: boolean };
type RewriteResult = NoteResult & { deleted: boolean };
type InboxResult = { inbox: { id: string } };
type ReadResult = { text: string };

type MemoryIdentity = { actor: "orchestrator" } | { actor: "expert"; self: string };

async function memoryIdentity(api: ToolExecutionApi, ctx: Context): Promise<MemoryIdentity> {
  if (api.conversationId === ROOT_CONVERSATION_ID) return { actor: "orchestrator" };
  const identity = await api.snapshot(ExpertIdentity, api.conversationId, ctx);
  if (typeof identity?.expert === "string" && identity.expert) return { actor: "expert", self: identity.expert };
  throw new Error("Memory writes require the root or a trusted expert identity.");
}

function response(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function currentProjectKey(cwd: string | undefined, keyFor: (cwd: string) => string): string {
  if (!cwd) throw new Error("This agent has no working directory; project memory is unavailable.");
  return keyFor(cwd);
}

function targetExpert(scope: string, expert: string | undefined, self?: string): string | undefined {
  if (scope === "project") return undefined;
  if (expert?.trim()) return expert;
  if (scope === "expert" && self) return self;
  throw new Error(`scope "${scope}" needs an expert name`);
}

export function createMemoryExtension(client: MemoryClient, projectKeyForCwd: (cwd: string) => string = projectKeyFor) {
  const keyFor = projectKeyForCwd;

  const memoryNote = defineTool({
    name: "memory_note",
    description:
      "Record one durable learning (dated, appended to a topic). scope project: facts true only for this repo (overview, conventions, worked, avoid, history). scope inbox: a candidate cross-project lesson for a named expert. scope expert: an expert's cross-project best practices. Reuse existing topics; pinned is only for a user-confirmed permanent learning.",
    parameters: Type.Object({
      scope: Type.Union([Type.Literal("project"), Type.Literal("inbox"), Type.Literal("expert")]),
      topic: Type.String({ description: "Kebab-case topic, e.g. overview, conventions, worked, avoid, or history." }),
      entry: Type.String({ description: "One concise learning (≤600 chars), including why it matters." }),
      summary: Type.Optional(Type.String({ description: "One-line topic summary (≤140 chars); required for a new topic." })),
      expert: Type.Optional(Type.String({ description: "Target expert for inbox or expert scope." })),
      pinned: Type.Optional(Type.Boolean({ description: "Keep forever; only when the user explicitly confirms." })),
    }),
    replay: "unsafe",
    execute: async (args, api, ctx) => {
      const projectKey = currentProjectKey((await api.agent(ctx)).cwd, keyFor);
      const identity = await memoryIdentity(api, ctx);
      const expert = targetExpert(args.scope, args.expert, identity.actor === "expert" ? identity.self : undefined);
      const result = await client.call<NoteResult | InboxResult>("note", {
        scope: args.scope,
        projectKey,
        ...(expert ? { expert } : {}),
        topic: args.topic,
        entry: args.entry,
        ...(args.summary === undefined ? {} : { summary: args.summary }),
        ...(args.pinned === undefined ? {} : { pinned: args.pinned }),
        ...identity,
      }, ctx);
      if ("inbox" in result) return response(`Added inbox candidate ${result.inbox.id} for ${expert} (project ${projectKey}).`);
      const status = result.created ? "Created" : "Updated";
      const overCap = result.overCap
        ? " OVER CAP: read the topic and consolidate with memory_rewrite, keeping pinned entries."
        : "";
      return response(`${status} ${args.scope} memory topic "${args.topic}" (${result.chars} chars).${overCap}`);
    },
  });

  const memoryRewrite = defineTool({
    name: "memory_rewrite",
    description:
      "Replace a topic with a consolidated version (merge duplicates, drop superseded entries, fix stale facts). Body is markdown bullets `- [YYYY-MM-DD] ...`; keep every 📌 pinned entry verbatim. Empty content deletes the topic. scope project is this repo; scope expert is a named expert's best practices.",
    parameters: Type.Object({
      scope: Type.Union([Type.Literal("project"), Type.Literal("expert")]),
      topic: Type.String({ description: "Kebab-case topic." }),
      content: Type.String({ description: "Full replacement body; empty string deletes the topic." }),
      summary: Type.Optional(Type.String({ description: "New one-line summary (≤140 chars); omitted summary is preserved." })),
      expert: Type.Optional(Type.String({ description: "Target expert for expert scope." })),
    }),
    // Appending/replacing memory has no caller idempotency key. Never replay a mutation after interruption.
    replay: "unsafe",
    execute: async (args, api, ctx) => {
      const projectKey = currentProjectKey((await api.agent(ctx)).cwd, keyFor);
      const identity = await memoryIdentity(api, ctx);
      const expert = targetExpert(args.scope, args.expert, identity.actor === "expert" ? identity.self : undefined);
      const result = await client.call<RewriteResult>("rewrite", {
        scope: args.scope,
        projectKey,
        ...(expert ? { expert } : {}),
        topic: args.topic,
        content: args.content,
        ...(args.summary === undefined ? {} : { summary: args.summary }),
        ...identity,
      }, ctx);
      return response(
        result.deleted
          ? `Deleted ${args.scope} memory topic "${args.topic}".`
          : `Rewrote ${args.scope} memory topic "${args.topic}" (${result.chars} chars).`,
      );
    },
  });

  const memoryRead = defineTool({
    name: "memory_read",
    description:
      "Read one markdown note or archive file from this project's memory index. Use a path relative to the memory directory, such as notes/conventions.md or archive/old-design.md; paths outside the project memory are rejected.",
    parameters: Type.Object({
      path: Type.String({ description: "Relative .md path from the project-memory directory." }),
    }),
    replay: "safe",
    execute: async (args, api, ctx) => {
      const projectKey = currentProjectKey((await api.agent(ctx)).cwd, keyFor);
      const result = await client.call<ReadResult>("read", { projectKey, path: args.path }, ctx);
      return response(result.text);
    },
  });

  const projectMemory = section(
    "project-memory",
    async (input, ctx: Context) => {
      let projectKey: string | undefined;
      try {
        projectKey = currentProjectKey(input.agent.cwd, keyFor);
        const result = await client.call<{ index: string }>("index", { projectKey }, ctx);
        return [`## Project memory — ${projectKey}`, result.index.trim() || "_(empty — no project memory yet)_"].join("\n\n");
      } catch {
        // Don't put a local checkout path, remote memory path, or raw subprocess error in the prompt.
        const heading = projectKey
          ? `## Project memory — ${projectKey}`
          : typeof input.agent.cwd === "string"
            ? "## Project memory"
            : "## Project memory (working directory unavailable)";
        return `${heading}\n\n_(memory index unavailable; memory tools can retry)_`;
      }
    },
    { tag: false },
  );

  const expertMemory = section(
    "expert-memory",
    async (input, ctx: Context) => {
      if (input.conversationId === ROOT_CONVERSATION_ID) return undefined;
      const identity = await input.read.snapshot(ExpertIdentity, input.conversationId, ctx);
      if (typeof identity?.expert !== "string" || !identity.expert) return undefined;
      try {
        const result = await client.call<{
          profile?: { skills?: unknown };
          bestPracticesIndex?: unknown;
        }>("expert", { name: identity.expert }, ctx);
        const skills = Array.isArray(result.profile?.skills)
          ? result.profile.skills.filter((skill): skill is string => typeof skill === "string")
              .map((skill) => skill.split(/[\\/]/).filter(Boolean).at(-1) ?? "")
              .filter(Boolean)
          : [];
        const index = typeof result.bestPracticesIndex === "string" ? result.bestPracticesIndex.trim() : "";
        return [
          `## Your best practices — ${identity.expert}`,
          index || "_(empty — no best practices recorded yet)_",
          ...(skills.length ? ["## Skills listed for this expert", skills.map((skill) => `- \`${skill}\``).join("\n"), "Load a listed skill with `load_skill(name)` when relevant."] : []),
        ].join("\n\n");
      } catch {
        return `## Your best practices — ${identity.expert}\n\n_(best-practices index unavailable; memory tools can retry)_`;
      }
    },
    { tag: false },
  );

  return defineExtension({
    name: "memory",
    sections: [projectMemory, expertMemory],
    tools: [memoryNote, memoryRewrite, memoryRead],
  });
}
