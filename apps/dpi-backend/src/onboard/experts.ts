import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
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
import { runBoundedProcess } from "./bounded-process.js";

const DEFAULT_GIT_TIMEOUT_MS = 60_000;
const DEFAULT_GIT_MAX_OUTPUT_BYTES = 1_000_000;
const CHILD_EXTENSION_NAMES = new Set(["coding-tools", "memory", "skills", "web"]);

export interface ExpertWorktree {
  [key: string]: string;
  repoRoot: string;
  path: string;
  branch: string;
  baseCommit: string;
  namespace: string;
}

export interface ExpertIdentityState {
  [key: string]: JsonValue;
  expert: string;
  excludedTools: string[];
  worktree: ExpertWorktree | null;
  /** Set only after worktree add succeeds or a pristine interrupted checkout is verified. */
  worktreeReady: boolean;
}

/** Trusted identity written only by delegate in the same transaction that creates an expert child. */
export const ExpertIdentity = defineDoc<ExpertIdentityState>({
  kind: "dpi.onboard-expert-identity",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ expert: "", excludedTools: [], worktree: null, worktreeReady: false }),
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
  gitTimeoutMs?: number;
  maxGitOutputBytes?: number;
  nameConversation?: (conversationId: number, name: string) => void;
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

/** Expert configs are shared with plain pi, whose top level `max` is durable's `xhigh`. */
export function durableThinkingLevel(level: string): (typeof THINKING_LEVELS)[number] | undefined {
  const mapped = level === "max" ? "xhigh" : level;
  return (THINKING_LEVELS as readonly string[]).includes(mapped) ? (mapped as (typeof THINKING_LEVELS)[number]) : undefined;
}

function modelRef(config: ExpertConfiguration, name: string) {
  const slash = config.model.model.indexOf("/");
  if (slash < 1 || slash === config.model.model.length - 1)
    throw new Error(`Expert "${name}" has an invalid model id`);
  const thinkingLevel = durableThinkingLevel(config.model.thinking);
  if (!thinkingLevel) throw new Error(`Expert "${name}" has an invalid thinking level "${config.model.thinking}"`);
  return {
    model: { provider: config.model.model.slice(0, slash), modelId: config.model.model.slice(slash + 1) },
    thinkingLevel,
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

function worktreeFor(repoRoot: string, baseCommit: string, childId: number, uniqueToken: string): ExpertWorktree {
  const namespace = `${childId}-${uniqueToken}`;
  const branch = `durable/${namespace}`;
  return { repoRoot, path: join(`${repoRoot}-durable`, namespace), branch, baseCommit, namespace };
}

function controlError(error: unknown): boolean {
  return error instanceof Error && ["AbortError", "TimeoutError", "OutputLimitError"].includes(error.name);
}

function createGitRunner(options: ExpertExtensionOptions) {
  const timeoutMs = options.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const maxOutputBytes = options.maxGitOutputBytes ?? DEFAULT_GIT_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new Error("gitTimeoutMs must be a positive safe integer");
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0)
    throw new Error("maxGitOutputBytes must be a positive safe integer");
  return async (cwd: string, args: string[], ctx: Context): Promise<string> => {
    const { stdout } = await runBoundedProcess("git", args, {
      cwd,
      signal: ctx.abortSignal,
      timeoutMs,
      maxOutputBytes,
    });
    return stdout.trim();
  };
}

async function repositoryFor(
  cwd: string | undefined,
  ctx: Context,
  git: (cwd: string, args: string[], ctx: Context) => Promise<string>,
): Promise<{ root: string; head: string }> {
  if (!cwd) throw new Error("worktree mode requires an agent working directory on this device");
  let root: string;
  try {
    root = await realpath(resolve(await git(cwd, ["rev-parse", "--show-toplevel"], ctx)));
  } catch (error) {
    if (controlError(error)) throw error;
    throw new Error("worktree mode requires the agent working directory to be inside a local Git repository");
  }
  try {
    return { root, head: await git(root, ["rev-parse", "--verify", "HEAD^{commit}"], ctx) };
  } catch (error) {
    if (controlError(error)) throw error;
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

export async function assertPristineWorktree(
  path: string,
  expectedHead: string,
  git: (cwd: string, args: string[]) => Promise<string>,
  label = "worktree",
): Promise<void> {
  const head = await git(path, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const status = await git(path, ["status", "--porcelain", "--untracked-files=all"]);
  if (head !== expectedHead || status)
    throw new Error(`${label} checkout is incomplete at ${path}; refusing to submit the child`);
}

/** Ensure only the namespace persisted with this delegation can be reused or repaired. */
async function ensureWorktree(
  worktree: ExpertWorktree,
  ready: boolean,
  ctx: Context,
  git: (cwd: string, args: string[], ctx: Context) => Promise<string>,
): Promise<void> {
  if (!worktree.namespace || worktree.branch !== `durable/${worktree.namespace}` ||
      resolve(worktree.path) !== resolve(join(`${worktree.repoRoot}-durable`, worktree.namespace)))
    throw new Error("delegate worktree identity has no valid persisted namespace; refusing unsafe reuse");
  const expectedPath = resolve(worktree.path);
  const expectedRef = `refs/heads/${worktree.branch}`;
  const listing = listedWorktrees(await git(worktree.repoRoot, ["worktree", "list", "--porcelain"], ctx));
  const existing = listing.find((entry) => entry.path === expectedPath);
  const verifyPreparedCheckout = () => assertPristineWorktree(
    expectedPath,
    worktree.baseCommit,
    (cwd, args) => git(cwd, args, ctx),
    "delegate worktree",
  );
  if (existing) {
    if (existing.branch !== expectedRef) throw new Error(`delegate worktree ${expectedPath} is attached to a different branch`);
    if (!ready) await verifyPreparedCheckout();
    return;
  }
  if (existsSync(expectedPath)) throw new Error(`delegate worktree path already exists but is not registered: ${expectedPath}`);
  const branchExists = Boolean((await git(worktree.repoRoot, ["branch", "--list", worktree.branch], ctx)).trim());
  try {
    if (branchExists) {
      // `worktree add -b` may have created our unique branch before interruption; attach it on replay.
      await git(worktree.repoRoot, ["worktree", "add", expectedPath, worktree.branch], ctx);
    } else {
      await git(worktree.repoRoot, ["worktree", "add", "-b", worktree.branch, expectedPath, worktree.baseCommit], ctx);
    }
    if (!ready) await verifyPreparedCheckout();
  } catch (error) {
    if (controlError(error)) throw error;
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
      excludedTools: Array.isArray(identity.excludedTools)
        ? identity.excludedTools.filter((name): name is string => typeof name === "string")
        : [],
      worktree: worktree ? {
        repoRoot: worktree.repoRoot,
        path: worktree.path,
        branch: worktree.branch,
        baseCommit: worktree.baseCommit,
        namespace: worktree.namespace,
      } : null,
      worktreeReady: identity.worktreeReady === true,
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
  worktreeReady: boolean,
  ctx: Context,
  git: (cwd: string, args: string[], ctx: Context) => Promise<string>,
) {
  if (worktree) {
    await ensureWorktree(worktree, worktreeReady, ctx, git);
    if (!worktreeReady) {
      await api.commit(async (tx) => {
        const identity = await tx.doc(ExpertIdentity, childId);
        const current = identity.worktree as ExpertWorktree | null;
        if (!current || current.namespace !== worktree.namespace || current.path !== worktree.path || current.branch !== worktree.branch)
          throw new Error("delegate worktree identity changed before checkout was marked ready");
        identity.worktreeReady = true;
      }, ctx);
    }
  }
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
  const git = createGitRunner(options);
  const childExtensions = options.childExtensions.filter((extension) => CHILD_EXTENSION_NAMES.has(extension.name));
  const extensionNames = childExtensions.map((extension) => extension.name);
  for (const required of ["coding-tools", "memory", "skills", "web"])
    if (!extensionNames.includes(required)) throw new Error(`delegate requires the ${required} extension`);

  const delegate = defineTool({
    name: "delegate",
    description:
      "Delegate a self-contained task to a configured durable expert. The child is owned by this call, resumes after restart, and is interrupted with its parent. Profile exclusions are exact: edit/write tools are unavailable (bash still runs) when excluded, though other tools may remain available; a parent read-only policy still removes all writing tools. At most DPI_MAX_CHILDREN live children are allowed per session; at capacity the tool reports that the caller should retry after a child completes.",
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
        options.nameConversation?.(existing.id as number, existing.identity.expert);
        return submitToChild(
          api,
          existing.id,
          existing.identity.expert,
          args.task,
          existing.identity.worktree as ExpertWorktree | undefined,
          existing.identity.worktreeReady,
          ctx,
          git,
        );
      }

      const parent = await api.agent(ctx);
      const repo = args.worktree ? await repositoryFor(parent.cwd, ctx, git) : undefined;
      const config = profileOf(await client.call<unknown>("expert", { name: args.expert }, ctx), args.expert);
      const resolvedModel = modelRef(config, args.expert);
      const excludedTools = [...new Set(config.profile.excludeTools)];
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
        agent.tools = removedTools(agent.tools, excludedTools);
        agent.instructions = instructions;
        const worktree = args.worktree && repo ? worktreeFor(repo.root, repo.head, child.id as number, randomUUID()) : null;
        if (worktree) agent.cwd = worktree.path;
        const identity = await tx.doc(ExpertIdentity, child.id);
        identity.expert = args.expert;
        identity.excludedTools = excludedTools;
        identity.worktree = worktree;
        identity.worktreeReady = false;
        index.children[String(api.taskId)] = child.id as number;
        return { id: child.id, identity: { expert: args.expert, worktree, worktreeReady: false } };
      }, ctx);

      if ("atCapacity" in created) {
        return response(`Delegate capacity is at capacity (${options.maxChildren} live children per session). Retry after a child completes.`);
      }
      if (created.identity.expert !== args.expert)
        throw new Error("this delegate tool call already owns a child for a different expert");
      if (Boolean(created.identity.worktree) !== (args.worktree === true))
        throw new Error("this delegate tool call already owns a child with a different worktree setting");
      options.nameConversation?.(created.id as number, created.identity.expert);
      return submitToChild(
        api,
        created.id,
        created.identity.expert,
        args.task,
        created.identity.worktree as ExpertWorktree | undefined,
        created.identity.worktreeReady,
        ctx,
        git,
      );
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
        return ["## Available experts", ...(lines.length ? lines : ["_(no experts are configured)_"]), "", "Use `delegate(expert, task, { worktree? })` for an owned, resumable child. Build first, use QA to verify, and ask reviewer last. Profile exclusions are exact: edit/write tools are unavailable (bash still runs) when excluded, while other tools such as memory may remain; a parent read-only policy removes all writers. At capacity, retry after a child completes."].join("\n");
      } catch {
        return "## Available experts\n\n_(expert roster unavailable; delegation can retry)_";
      }
    },
    { tag: false },
  );

  return defineExtension({ name: "experts", tools: [delegate], sections: [roster] });
}
