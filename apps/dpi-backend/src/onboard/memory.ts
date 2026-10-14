// Durable memory tools and per-request project-memory context. Project paths are reduced to a
// stable key on this device; only that key crosses MemoryClient to pi-setup.
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { projectKeyFor } from "./project-key.js";
import type { MemoryClient } from "./memory-client.js";

type NoteResult = { file: string; chars: number; overCap: boolean; created: boolean };
type RewriteResult = NoteResult & { deleted: boolean };
type InboxResult = { inbox: { id: string } };
type ReadResult = { text: string };

// Phase 1 root agents only; expert identity enforcement remains a Phase 2 prerequisite.
const actor = "orchestrator" as const;

function response(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function currentProjectKey(cwd: string | undefined, keyFor: (cwd: string) => string): string {
  if (!cwd) throw new Error("This agent has no working directory; project memory is unavailable.");
  return keyFor(cwd);
}

function targetExpert(scope: string, expert: string | undefined): string | undefined {
  if (scope === "project") return expert;
  if (!expert?.trim()) throw new Error(`scope "${scope}" needs an expert name`);
  return expert;
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
      const expert = targetExpert(args.scope, args.expert);
      const result = await client.call<NoteResult | InboxResult>("note", {
        scope: args.scope,
        projectKey,
        ...(expert ? { expert } : {}),
        topic: args.topic,
        entry: args.entry,
        ...(args.summary === undefined ? {} : { summary: args.summary }),
        ...(args.pinned === undefined ? {} : { pinned: args.pinned }),
        // The CLI accepts this for its legacy policy check. It is self-asserted, not authenticated authorization.
        actor,
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
      const expert = targetExpert(args.scope, args.expert);
      const result = await client.call<RewriteResult>("rewrite", {
        scope: args.scope,
        projectKey,
        ...(expert ? { expert } : {}),
        topic: args.topic,
        content: args.content,
        ...(args.summary === undefined ? {} : { summary: args.summary }),
        actor,
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

  return defineExtension({
    name: "memory",
    sections: [projectMemory],
    tools: [memoryNote, memoryRewrite, memoryRead],
  });
}
