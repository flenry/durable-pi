import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import {
  AgentDoc,
  AssistantEntry,
  ROOT_CONVERSATION_ID,
  defineDoc,
  defineExtension,
  defineTool,
  section,
  type ConversationId,
  type Extension,
  type TaskId,
  type ToolExecutionApi,
  type Tx,
} from "@earendil-works/pi-durable";
import type { Context, JsonValue } from "@earendil-works/chord";
import { THINKING_LEVELS } from "../../../dpi-sdk/src/api.js";
import { messageText } from "../../../dpi-sdk/src/transcript.js";
import type { MemoryClient } from "./memory-client.js";

const execFileAsync = promisify(execFile);
const CHILD_EXTENSION_NAMES = new Set(["coding-tools", "memory", "skills", "web"]);

export interface ExpertWorktree {
  [key: string]: string;
  repoRoot: string;
  path: string;
  branch: string;
  baseCommit: string;
}

export interface ExpertIdentityState {
  [key: string]: JsonValue;
  expert: string;
  worktree: ExpertWorktree | null;
}

/** Trusted identity written only by delegate in the same transaction that creates an expert child. */
export const ExpertIdentity = defineDoc<ExpertIdentityState>({
  kind: "dpi.onboard-expert-identity",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ expert: "", worktree: null }),
  checkpointWhen: () => true,
});

type DelegateChildrenState = { [key: string]: JsonValue; children: Record<string, number> };

/** Session-wide live-child index; owner tasks determine whether each durable slot is still occupied. */
export const DelegateChildren = defineDoc<DelegateChildrenState>({
  kind: "dpi.onboard-delegate-children",
  version: 1,
  scope: "session",
  initial: () => ({ children: {} }),
  checkpointWhen: () => true,
});

interface ExpertProfile {
  name: string;
  description?: string;
  mode?: string;
  excludeTools: string[];
  skills: string[];
  body: string;
}

interface ExpertConfiguration {
  profile: ExpertProfile;
  model: { model: string; thinking: string };
  bestPracticesIndex?: string;
}

interface ExpertExtensionOptions {
  maxChildren: number;
  childExtensions: readonly Extension[];
  writeTools: ReadonlySet<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function profileOf(value: unknown, expectedName: string): ExpertConfiguration {
  if (!isRecord(value) || !isRecord(value.profile) || !isRecord(value.model))
    throw new Error(`Expert "${expectedName}" returned an invalid profile`);
  const profile = value.profile;
  const model = value.model;
  if (profile.name !== expectedName || typeof profile.body !== "string")
    throw new Error(`Expert "${expectedName}" returned an incomplete profile`);
  if (typeof model.model !== "string" || typeof model.thinking !== "string")
    throw new Error(`Expert "${expectedName}" has no configured model and thinking level`);
  const excludeTools = Array.isArray(profile.excludeTools)
    ? profile.excludeTools.filter((name): name is string => typeof name === "string")
    : [];
  const skills = Array.isArray(profile.skills)
    ? profile.skills.filter((skill): skill is string => typeof skill === "string")
    : [];
  return {
    profile: {
      name: expectedName,
      ...(typeof profile.description === "string" ? { description: profile.description } : {}),
      ...(typeof profile.mode === "string" ? { mode: profile.mode } : {}),
      excludeTools,
      skills,
      body: profile.body,
    },
    model: { model: model.model, thinking: model.thinking },
    ...(typeof value.bestPracticesIndex === "string" ? { bestPracticesIndex: value.bestPracticesIndex } : {}),
  };
}

function modelRef(config: ExpertConfiguration, name: string) {
  const slash = config.model.model.indexOf("/");
  if (slash < 1 || slash === config.model.model.length - 1)
    throw new Error(`Expert "${name}" has an invalid model id`);
  if (!(THINKING_LEVELS as readonly string[]).includes(config.model.thinking))
    throw new Error(`Expert "${name}" has an invalid thinking level`);
  return {
    model: { provider: config.model.model.slice(0, slash), modelId: config.model.model.slice(slash + 1) },
    thinkingLevel: config.model.thinking as (typeof THINKING_LEVELS)[number],
  };
}

function instructionsFor(profile: ExpertProfile): string {
  return [
    profile.body.trim(),
    [
      "## Durable expert memory",
      `These best practices belong to you (${profile.name}). Record concise cross-project learnings with ` +
        "`memory_note(scope: \"expert\", topic, entry)` and consolidate with `memory_rewrite(scope: \"expert\", topic, content)`.",
      "The host supplies your trusted identity; never pass or claim `actor` or `self`. You may write only your own expert store and may not pin. Use `scope: \"inbox\"` for suggestions to another expert.",
    ].join("\n\n"),
  ].filter(Boolean).join("\n\n");
}

function removedTools(current: string[] | { remove: string[] } | undefined, denied: readonly string[]) {
  if (!denied.length) return current;
  const removed = new Set(denied);
  if (current === undefined) return { remove: [...removed] };
  if (Array.isArray(current)) return current.filter((name) => !removed.has(name));
  return { remove: [...new Set([...current.remove, ...removed])] };
}

function worktreeFor(repoRoot: string, baseCommit: string, childId: number): ExpertWorktree {
  const branch = `durable/${childId}`;
  return { repoRoot, path: join(`${repoRoot}-durable`, String(childId)), branch, baseCommit };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", maxBuffer: 1_000_000 });
  return stdout.trim();
}

async function repositoryFor(cwd: string | undefined): Promise<{ root: string; head: string }> {
  if (!cwd) throw new Error("worktree mode requires an agent working directory on this device");
  let root: string;
  try {
    root = await realpath(resolve(await git(cwd, ["rev-parse", "--show-toplevel"])));
  } catch {
    throw new Error("worktree mode requires the agent working directory to be inside a local Git repository");
  }
  try {
    return { root, head: await git(root, ["rev-parse", "--verify", "HEAD^{commit}"]) };
  } catch {
    throw new Error("worktree mode requires a committed HEAD in the local Git repository");
  }
}

function listedWorktrees(output: string): { path: string; branch?: string }[] {
  return output.split(/\r?\n\r?\n/).map((block) => {
    const lines = block.split(/\r?\n/);
    const worktree = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
    const branch = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length);
    return worktree ? { path: resolve(worktree), ...(branch ? { branch } : {}) } : undefined;
  }).filter((entry): entry is { path: string; branch?: string } => entry !== undefined);
}

/** Ensure the same child id always resumes into its original local branch/worktree. */
async function ensureWorktree(worktree: ExpertWorktree): Promise<void> {
  const expectedPath = resolve(worktree.path);
  const expectedRef = `refs/heads/${worktree.branch}`;
  const listing = listedWorktrees(await git(worktree.repoRoot, ["worktree", "list", "--porcelain"]));
  const existing = listing.find((entry) => entry.path === expectedPath);
  if (existing) {
    if (existing.branch !== expectedRef) throw new Error(`delegate worktree ${expectedPath} is attached to a different branch`);
    return;
  }
  if (existsSync(expectedPath)) throw new Error(`delegate worktree path already exists but is not registered: ${expectedPath}`);
  if ((await git(worktree.repoRoot, ["branch", "--list", worktree.branch])).trim())
    throw new Error(`delegate branch ${worktree.branch} already exists without its expected worktree`);
  try {
    await git(worktree.repoRoot, ["worktree", "add", "-b", worktree.branch, expectedPath, worktree.baseCommit]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`could not create delegate worktree: ${detail}`);
  }
}

type DelegateDetails = { conversationId: number; expert: string; worktree?: string; branch?: string };

function response(text: string, details?: DelegateDetails) {
  return { content: [{ type: "text" as const, text }], ...(details ? { details } : {}) };
}

async function readOwnedChild(tx: Tx, taskId: TaskId) {
  const child = (await tx.scanConversations({ ownerTaskId: taskId }, 1)).items[0];
  if (!child) return undefined;
  const identity = await tx.doc(ExpertIdentity, child.id);
  const worktree = identity.worktree as ExpertWorktree | null;
  return {
    id: child.id,
    identity: {
      expert: identity.expert as string,
      worktree: worktree ? { repoRoot: worktree.repoRoot, path: worktree.path, branch: worktree.branch, baseCommit: worktree.baseCommit } : null,
    },
  };
}

async function liveDelegateCount(tx: Tx, state: DelegateChildrenState): Promise<number> {
  let live = 0;
  for (const owner of Object.keys(state.children)) {
    const task = await tx.task(Number(owner) as TaskId);
    if (!task || task.state.status === "terminal") delete state.children[owner];
    else live++;
  }
  return live;
}

async function childAnswer(api: ToolExecutionApi, answerId: number, ctx: Context): Promise<string | undefined> {
  const answer = await api.commit((tx) => tx.entry(AssistantEntry, answerId as never), ctx);
  if (!answer) return undefined;
  return (answer.model ?? []).filter((message) => message.role === "assistant").map((message) => messageText(message as never)).join("\n").trim() || undefined;
}

async function submitToChild(
  api: ToolExecutionApi,
  childId: ConversationId,
  expert: string,
  task: string,
  worktree: ExpertWorktree | undefined,
  ctx: Context,
) {
  if (worktree) await ensureWorktree(worktree);
  const child = await api.conversation(childId, ctx);
  if (!child) throw new Error(`Expert child ${childId} is unavailable`);
  const detail: DelegateDetails = {
    conversationId: childId as number,
    expert,
    ...(worktree ? { worktree: worktree.path, branch: worktree.branch } : {}),
  };
  await api.details(detail, ctx);
  const result = await (await child.submit(
    { type: "input", content: task, requestId: `child:${api.taskId}` },
    ctx,
  )).wait(ctx);
  const answer = result.status === "done" && result.type === "input"
    ? await childAnswer(api, result.answer as number, ctx)
    : undefined;
  return response(
    answer
      ? `Expert ${expert} completed${worktree ? ` in ${worktree.path} (${worktree.branch})` : ""}.\n\n${answer}`
      : `Expert ${expert} returned ${JSON.stringify(result)}${worktree ? `\nWorktree: ${worktree.path}\nBranch: ${worktree.branch}` : ""}`,
    detail,
  );
}

/** Durable expert delegation. Identity, capacity reservation, and ownership commit atomically. */
export function createExpertsExtension(client: MemoryClient, options: ExpertExtensionOptions) {
  if (!Number.isSafeInteger(options.maxChildren) || options.maxChildren < 1)
    throw new Error("maxChildren must be a positive safe integer");
  const childExtensions = options.childExtensions.filter((extension) => CHILD_EXTENSION_NAMES.has(extension.name));
  const extensionNames = childExtensions.map((extension) => extension.name);
  for (const required of ["coding-tools", "memory", "skills", "web"])
    if (!extensionNames.includes(required)) throw new Error(`delegate requires the ${required} extension`);

  const delegate = defineTool({
    name: "delegate",
    description:
      "Delegate a self-contained task to a configured durable expert. The child is owned by this call, resumes after restart, and is interrupted with its parent. At most DPI_MAX_CHILDREN live children are allowed per session; at capacity the tool reports that the caller should retry after a child completes.",
    parameters: Type.Object({
      expert: Type.String({ description: "Exact expert name from the available roster.", minLength: 1 }),
      task: Type.String({ description: "A self-contained task with context and observable expectations.", minLength: 1, maxLength: 100_000 }),
      worktree: Type.Optional(Type.Boolean({ description: "Create an isolated local Git worktree and branch for this child." })),
    }),
    replay: "safe",
    execute: async (args: { expert: string; task: string; worktree?: boolean }, api: ToolExecutionApi, ctx: Context) => {
      if (api.conversationId !== ROOT_CONVERSATION_ID) throw new Error("delegate is available only to root conversations");
      if (!args.expert.trim()) throw new Error("expert is required");
      if (!args.task.trim()) throw new Error("task must not be empty");

      const existing = await api.commit((tx) => readOwnedChild(tx, api.taskId), ctx);
      if (existing) {
        if (existing.identity.expert !== args.expert)
          throw new Error("this delegate tool call already owns a child for a different expert");
        if (Boolean(existing.identity.worktree) !== (args.worktree === true))
          throw new Error("this delegate tool call already owns a child with a different worktree setting");
        return submitToChild(api, existing.id, existing.identity.expert, args.task, existing.identity.worktree as ExpertWorktree | undefined, ctx);
      }

      const parent = await api.agent(ctx);
      const repo = args.worktree ? await repositoryFor(parent.cwd) : undefined;
      const config = profileOf(await client.call<unknown>("expert", { name: args.expert }, ctx), args.expert);
      const resolvedModel = modelRef(config, args.expert);
      const deniedTools = new Set(config.profile.excludeTools);
      const readOnly = deniedTools.has("edit") && deniedTools.has("write");
      if (readOnly) for (const name of options.writeTools) deniedTools.add(name);
      const instructions = instructionsFor(config.profile);

      const created = await api.commit(async (tx) => {
        const prior = await readOwnedChild(tx, api.taskId);
        if (prior) return { id: prior.id, identity: prior.identity };

        const index = await tx.doc(DelegateChildren);
        if (await liveDelegateCount(tx, index) >= options.maxChildren)
          return { atCapacity: true as const };

        const child = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
        const agent = await tx.doc(AgentDoc, child.id);
        agent.model = resolvedModel.model;
        agent.thinkingLevel = resolvedModel.thinkingLevel;
        agent.extensions = extensionNames;
        agent.tools = removedTools(agent.tools, [...deniedTools]);
        agent.instructions = instructions;
        const worktree = args.worktree && repo ? worktreeFor(repo.root, repo.head, child.id as number) : null;
        if (worktree) agent.cwd = worktree.path;
        const identity = await tx.doc(ExpertIdentity, child.id);
        identity.expert = args.expert;
        identity.worktree = worktree;
        index.children[String(api.taskId)] = child.id as number;
        return { id: child.id, identity: { expert: args.expert, worktree } };
      }, ctx);

      if ("atCapacity" in created) {
        return response(`Delegate capacity is at capacity (${options.maxChildren} live children per session). Retry after a child completes.`);
      }
      if (created.identity.expert !== args.expert)
        throw new Error("this delegate tool call already owns a child for a different expert");
      if (Boolean(created.identity.worktree) !== (args.worktree === true))
        throw new Error("this delegate tool call already owns a child with a different worktree setting");
      return submitToChild(api, created.id, created.identity.expert, args.task, created.identity.worktree as ExpertWorktree | undefined, ctx);
    },
  });

  const roster = section(
    "expert-roster",
    async (input, ctx: Context) => {
      if (input.conversationId !== ROOT_CONVERSATION_ID) return undefined;
      try {
        const entries = await client.call<unknown>("roster", {}, ctx);
        if (!Array.isArray(entries) || entries.length === 0) return "## Available experts\n\n_(no experts are configured)_";
        const lines = entries.flatMap((entry) => {
          if (!isRecord(entry) || typeof entry.name !== "string") return [];
          const description = typeof entry.description === "string" ? entry.description.replace(/\s+/g, " ").trim() : "";
          return [`- **${entry.name}**${description ? ` — ${description}` : ""}`];
        });
        return ["## Available experts", ...(lines.length ? lines : ["_(no experts are configured)_"]), "", "Use `delegate(expert, task, { worktree? })` for an owned, resumable child. Build first, use QA to verify, and ask reviewer last. At capacity, retry after a child completes."].join("\n");
      } catch {
        return "## Available experts\n\n_(expert roster unavailable; delegation can retry)_";
      }
    },
    { tag: false },
  );

  return defineExtension({ name: "experts", tools: [delegate], sections: [roster] });
}
