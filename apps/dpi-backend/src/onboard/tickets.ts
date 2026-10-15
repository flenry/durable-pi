import { Type } from "@earendil-works/pi-ai";
import type { Context, JsonValue } from "@earendil-works/chord";
import {
  AgentDoc,
  AssistantEntry,
  ROOT_CONVERSATION_ID,
  defineDocFamily,
  defineExtension,
  defineTask,
  defineTool,
  type ConversationId,
  type Extension,
  type TaskId,
  type TaskRuntime,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { messageText } from "../../../dpi-sdk/src/transcript.js";
import type { AppState } from "../../../dpi-sdk/src/app-state.js";
import { runBoundedProcess, type BoundedProcessResult } from "./bounded-process.js";
import { assertPristineWorktree, durableThinkingLevel, ExpertIdentity } from "./experts.js";
import { normalizeRemote } from "./project-key.js";
import type { MemoryClient } from "./memory-client.js";
import { createTicketSchedulerTask } from "./scheduler.js";

export const TICKETS_STATE_KEY = "dpi.tickets";
export const TICKET_RUN_TASK_NAME = "dpi.ticket.run";
export const TICKET_SCHEDULER_TASK_NAME = "dpi.ticket.scheduler";
export const STATUSES = ["draft", "ready", "in-progress", "blocked", "done"] as const;
export type TicketStatus = (typeof STATUSES)[number];
export type TicketTier = "fix" | "small" | "medium" | "large";

export interface TicketSlice {
  id: string;
  expert: string;
  task: string;
  dependsOn: string[];
  verify?: string;
}

export interface Ticket {
  id: string;
  title: string;
  goal: string;
  decisions: string[];
  acceptanceCriteria: string[];
  plan: TicketSlice[];
  tier: TicketTier;
  repo: string;
  device: string;
  status: TicketStatus;
  log: { at: string; text: string }[];
  createdAt: string;
  updatedAt: string;
  pr?: string;
  branch?: string;
  worktree?: string;
  worktreeReady?: boolean;
  worktreeBaseCommit?: string;
  blockedNote?: string;
  runTaskId?: number;
  runToken?: string;
}

export interface TicketPlan {
  title: string;
  goal: string;
  decisions: string[];
  acceptanceCriteria: string[];
  plan: TicketSlice[];
  tier: TicketTier;
  repo: string;
}
export type TicketPlanResult = TicketPlan | { question: string };

export type ProcessRunner = (
  command: string,
  args: readonly string[],
  options: { cwd?: string; signal?: AbortSignal },
) => Promise<BoundedProcessResult>;

const PROCESS_TIMEOUT_MS = 60_000;
const PROCESS_OUTPUT_LIMIT = 1_000_000;
const MAX_TICKETS = 200;
const MAX_LOG_LINES = 20;
const MAX_TICKET_STATE_CHARS = 85_000;
// Every ordinary write leaves room for an atomic blocked transition to record its note and clear the lease.
const TICKET_STATE_RECOVERY_HEADROOM = 5_000;
const MAX_TICKET_PR_URL_CHARS = 2_000;
const HOUR_HISTORY = 168;

export const boundedRunner: ProcessRunner = (command, args, options) =>
  runBoundedProcess(command, args, {
    cwd: options.cwd,
    signal: options.signal,
    timeoutMs: PROCESS_TIMEOUT_MS,
    maxOutputBytes: PROCESS_OUTPUT_LIMIT,
  });

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function ticketState(state: Record<string, unknown>) {
  let raw = state[TICKETS_STATE_KEY];
  if (raw === undefined) {
    raw = { version: 1, tickets: {}, processedHours: [] };
    state[TICKETS_STATE_KEY] = raw as JsonValue;
  }
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.tickets) || !Array.isArray(raw.processedHours))
    throw new Error("Device ticket state is invalid; refusing to overwrite it");
  return raw as { version: 1; tickets: Record<string, Ticket>; processedHours: string[] };
}

function appendLog(ticket: Ticket, text: string, now: number | Date) {
  const at = (now instanceof Date ? now : new Date(now)).toISOString();
  ticket.log.push({ at, text: text.replace(/[\r\n]+/g, " ").slice(0, 300) });
  if (ticket.log.length > MAX_LOG_LINES) ticket.log.splice(0, ticket.log.length - MAX_LOG_LINES);
  ticket.updatedAt = at;
}

/** Device-wide ticket persistence and queue invariants, backed by one atomic ticket-state transaction. */
export class TicketStore {
  constructor(private readonly apply: <T>(change: (state: Record<string, unknown>) => T) => Promise<T>) {}

  private transact<T>(change: (state: Record<string, unknown>) => T, recovery = false): Promise<T> {
    return this.apply((state) => {
      const before = JSON.stringify(state);
      const result = change(state);
      const raw = state[TICKETS_STATE_KEY];
      if (raw !== undefined) {
        const doc = ticketState(state);
        for (const ticket of Object.values(doc.tickets)) {
          if (ticket.log.length > MAX_LOG_LINES) ticket.log.splice(0, ticket.log.length - MAX_LOG_LINES);
        }
        let encoded = JSON.stringify(state);
        const limit = recovery ? MAX_TICKET_STATE_CHARS : MAX_TICKET_STATE_CHARS - TICKET_STATE_RECOVERY_HEADROOM;
        if (encoded !== before) {
          while (encoded.length > limit) {
            const oldestDone = Object.values(doc.tickets)
              .filter((ticket) => ticket.status === "done")
              .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))[0];
            if (oldestDone) delete doc.tickets[oldestDone.id];
            else {
              // History is expendable; retain queue state and its lease before rejecting a bounded write.
              const oldestLog = Object.values(doc.tickets)
                .filter((ticket) => ticket.log.length > 0)
                .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))[0];
              if (!oldestLog) throw new Error("Ticket queue reached its durable state limit; complete or prune a ticket first");
              oldestLog.log.shift();
            }
            encoded = JSON.stringify(state);
          }
          if (encoded.length > limit) throw new Error("Ticket queue reached its durable state limit; complete or prune a ticket first");
        }
      }
      return result;
    });
  }

  async list(): Promise<Ticket[]> {
    return this.transact((state) =>
      Object.values(ticketState(state).tickets)
        .map((ticket) => clone(ticket))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
    );
  }

  async get(id: string): Promise<Ticket | undefined> {
    return this.transact((state) => {
      const ticket = ticketState(state).tickets[id];
      return ticket ? clone(ticket) : undefined;
    });
  }

  async add(ticket: Ticket): Promise<void> {
    await this.transact((state) => {
      const doc = ticketState(state);
      if (doc.tickets[ticket.id]) throw new Error(`Ticket ${ticket.id} already exists`);
      if (Object.keys(doc.tickets).length >= MAX_TICKETS) throw new Error(`Ticket queue is full (maximum ${MAX_TICKETS})`);
      doc.tickets[ticket.id] = clone(ticket);
    });
  }

  async claim(id: string, device: string, runToken: string, runTaskId: number, now: number): Promise<{ claimed: boolean; reason?: string }> {
    return this.transact((state) => {
      const doc = ticketState(state);
      const ticket = doc.tickets[id];
      if (!ticket) return { claimed: false, reason: `No ticket ${id}` };
      if (ticket.device !== device) return { claimed: false, reason: `Ticket ${id} belongs to ${ticket.device}, not ${device}` };
      if (ticket.status === "in-progress" && ticket.runToken === runToken) return { claimed: true };
      const current = Object.values(doc.tickets).find((item) => item.device === device && item.status === "in-progress");
      if (current) return { claimed: false, reason: `Ticket ${current.id} is already in progress` };
      if (ticket.status !== "ready") return { claimed: false, reason: `Ticket ${id} is ${ticket.status}, not ready` };
      ticket.status = "in-progress";
      ticket.runTaskId = runTaskId;
      ticket.runToken = runToken;
      delete ticket.blockedNote;
      appendLog(ticket, "run started", now);
      return { claimed: true };
    });
  }

  async update(id: string, status: TicketStatus | undefined, note: string | undefined, now: number): Promise<Ticket> {
    return this.transact((state) => {
      const ticket = ticketState(state).tickets[id];
      if (!ticket) throw new Error(`No ticket ${id}`);
      if (status !== undefined && !(STATUSES as readonly string[]).includes(status)) throw new Error(`Invalid ticket status ${status}`);
      if (status === "in-progress" && ticket.status !== "in-progress")
        throw new Error(`Ticket ${id} can enter in-progress only through its durable run`);
      if (ticket.status === "in-progress" && status !== undefined && status !== "in-progress")
        throw new Error(`Ticket ${id} is in progress; let its durable run finish or block itself before changing status`);
      if (status !== undefined) ticket.status = status;
      if (status === "ready") {
        delete ticket.blockedNote;
        delete ticket.runTaskId;
        delete ticket.runToken;
      }
      if (note?.trim()) {
        if (status === "blocked") ticket.blockedNote = note.trim().slice(0, 1000);
        appendLog(ticket, note.trim(), now);
      } else ticket.updatedAt = new Date(now).toISOString();
      return clone(ticket);
    });
  }

  async block(id: string, note: string, now: number, runToken: string): Promise<boolean> {
    return this.transact((state) => {
      const ticket = ticketState(state).tickets[id];
      if (!ticket || ticket.status !== "in-progress" || ticket.runToken !== runToken) return false;
      ticket.status = "blocked";
      ticket.blockedNote = note.slice(0, 1000);
      delete ticket.runTaskId;
      delete ticket.runToken;
      appendLog(ticket, `blocked: ${note}`, now);
      return true;
    }, true);
  }

  async complete(id: string, pr: string, now: number, runToken: string): Promise<boolean> {
    return this.transact((state) => {
      const ticket = ticketState(state).tickets[id];
      if (!ticket) throw new Error(`No ticket ${id}`);
      if (ticket.status !== "in-progress" || ticket.runToken !== runToken) return false;
      if (pr.length > MAX_TICKET_PR_URL_CHARS) throw new Error("Pull request URL is too long");
      ticket.status = "done";
      ticket.pr = pr;
      delete ticket.blockedNote;
      delete ticket.runTaskId;
      delete ticket.runToken;
      appendLog(ticket, `PR opened: ${pr}`, now);
      return true;
    }, true);
  }

  async setWorktree(
    id: string,
    branch: string,
    worktree: string,
    now: number,
    runToken: string,
    ready: boolean,
    baseCommit: string,
  ): Promise<boolean> {
    return this.transact((state) => {
      const ticket = ticketState(state).tickets[id];
      if (!ticket || ticket.status !== "in-progress" || ticket.runToken !== runToken) return false;
      ticket.branch = branch;
      ticket.worktree = worktree;
      ticket.worktreeReady = ready;
      ticket.worktreeBaseCommit = baseCommit;
      if (ready) appendLog(ticket, `worktree ready: ${worktree} (${branch})`, now);
      else ticket.updatedAt = new Date(now).toISOString();
      return true;
    });
  }

  async log(id: string, message: string, now: number): Promise<void> {
    await this.transact((state) => {
      const ticket = ticketState(state).tickets[id];
      if (ticket && ticket.status !== "in-progress") appendLog(ticket, message, now);
    });
  }

  async runLog(id: string, message: string, now: number, runToken: string): Promise<boolean> {
    return this.transact((state) => {
      const ticket = ticketState(state).tickets[id];
      if (!ticket || ticket.status !== "in-progress" || ticket.runToken !== runToken) return false;
      appendLog(ticket, message, now);
      return true;
    });
  }

  async ownsRun(id: string, runToken: string): Promise<boolean> {
    return this.transact((state) => {
      const ticket = ticketState(state).tickets[id];
      return ticket?.status === "in-progress" && ticket.runToken === runToken;
    });
  }

  async wasHourProcessed(hour: string): Promise<boolean> {
    return this.transact((state) => ticketState(state).processedHours.includes(hour));
  }

  async recordHour(hour: string): Promise<boolean> {
    return this.transact((state) => {
      const hours = ticketState(state).processedHours;
      if (hours.includes(hour)) return false;
      hours.push(hour);
      hours.sort();
      if (hours.length > HOUR_HISTORY) hours.splice(0, hours.length - HOUR_HISTORY);
      return true;
    });
  }
}

export function isTicketWorkPath(value: string): boolean {
  return value.toLowerCase().split(/[\\/]+/).some((segment) => ["work", "work-laptop", "office"].includes(segment));
}

async function canonicalFuturePath(value: string): Promise<string> {
  const missing: string[] = [];
  let existing = resolve(value);
  for (;;) {
    try {
      const canonical = await realpath(existing);
      return resolve(canonical, ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error(`cannot validate ticket worktree path ${value}: ${shortError(error)}`);
      const parent = dirname(existing);
      if (parent === existing) throw new Error(`cannot find an existing ancestor for ticket worktree path ${value}`);
      missing.push(basename(existing));
      existing = parent;
    }
  }
}

export async function assertTicketWorktreePath(value: string): Promise<string> {
  if (!isAbsolute(value)) throw new Error(`ticket worktree path must be absolute: ${value}`);
  if (isTicketWorkPath(value)) throw new Error(`work repos are excluded from ticket worktrees: ${value}`);
  const canonical = await canonicalFuturePath(value);
  if (isTicketWorkPath(canonical)) throw new Error(`work repos are excluded from ticket worktrees: ${canonical}`);
  return canonical;
}

export function slugifyTicketTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "ticket";
}

export function ticketIdFor(title: string, now: number | Date, suffix = ""): string {
  const date = now instanceof Date ? now : new Date(now);
  const p = (n: number) => String(n).padStart(2, "0");
  const prefix = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}`;
  return `${prefix}-${slugifyTicketTitle(title)}${suffix ? `-${suffix}` : ""}`;
}

export function normalizeTicketPlan(raw: unknown): TicketPlan {
  if (!isRecord(raw)) throw new Error("Planning child returned no ticket object");
  const strings = (key: string, min = 0): string[] => {
    const value = raw[key];
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim()) || value.length < min)
      throw new Error(`Ticket plan ${key} must be a list of non-empty strings`);
    return value.map((item) => (item as string).trim());
  };
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  const goal = typeof raw.goal === "string" ? raw.goal.trim() : "";
  const tier = raw.tier;
  if (!title || !goal) throw new Error("Ticket plan needs a title and goal");
  if (!(raw.repo && typeof raw.repo === "string" && isAbsolute(raw.repo))) throw new Error("Ticket plan repo must be an absolute path");
  if (!(tier === "fix" || tier === "small" || tier === "medium" || tier === "large")) throw new Error("Ticket plan tier must be fix, small, medium, or large");
  const criteria = strings("acceptanceCriteria", 1);
  const decisions = strings("decisions");
  if (!Array.isArray(raw.plan) || raw.plan.length === 0) throw new Error("Ticket plan must contain at least one expert slice");
  const plan: TicketSlice[] = raw.plan.map((value, index) => {
    if (!isRecord(value)) throw new Error(`Plan slice ${index + 1} must be an object`);
    const id = typeof value.id === "string" && value.id.trim() ? value.id.trim() : `slice-${index + 1}`;
    if (typeof value.expert !== "string" || !value.expert.trim()) throw new Error(`Plan slice ${id} needs an expert`);
    if (typeof value.task !== "string" || !value.task.trim()) throw new Error(`Plan slice ${id} needs a task`);
    const dependsOn = value.dependsOn === undefined ? [] : value.dependsOn;
    if (!Array.isArray(dependsOn) || dependsOn.some((item) => typeof item !== "string")) throw new Error(`Plan slice ${id} has invalid dependencies`);
    return {
      id,
      expert: value.expert.trim(),
      task: value.task.trim(),
      dependsOn: dependsOn as string[],
      ...(typeof value.verify === "string" && value.verify.trim() ? { verify: value.verify.trim() } : {}),
    };
  });
  if (new Set(plan.map((slice) => slice.id)).size !== plan.length) throw new Error("Plan slice ids must be unique");
  const position = new Map(plan.map((slice, index) => [slice.id, index]));
  const byId = new Map(plan.map((slice) => [slice.id, slice]));
  for (const [index, slice] of plan.entries()) {
    for (const dependency of slice.dependsOn) {
      const dependencyIndex = position.get(dependency);
      const dependencySlice = byId.get(dependency);
      if (dependencyIndex === undefined || dependency === slice.id) throw new Error(`Plan slice ${slice.id} has an unknown or self dependency: ${dependency}`);
      const phase = ticketSlicePhaseRank(slice);
      const dependencyPhase = ticketSlicePhaseRank(dependencySlice!);
      if (dependencyPhase > phase || (dependencyPhase === phase && dependencyIndex >= index))
        throw new Error(`Plan dependency ${dependency} must precede ${slice.id} in the execution order`);
    }
  }
  return {
    title,
    goal,
    decisions,
    acceptanceCriteria: criteria,
    plan,
    tier,
    repo: raw.repo,
  };
}

export async function validateTicketRepo(repo: string, run: ProcessRunner = boundedRunner, signal?: AbortSignal): Promise<string | undefined> {
  if (!isAbsolute(repo)) return `repo must be an absolute path: ${repo}`;
  if (isTicketWorkPath(repo)) return `work repos are excluded from tickets: ${repo}`;
  let root: string;
  try {
    root = await realpath(resolve(repo));
  } catch {
    return `repo does not exist: ${repo}`;
  }
  if (!existsSync(root)) return `repo does not exist: ${repo}`;
  if (isTicketWorkPath(root)) return `work repos are excluded from tickets: ${root}`;
  try {
    const found = (await run("git", ["rev-parse", "--show-toplevel"], { cwd: root, signal })).stdout.trim();
    if (resolve(found) !== root) return `not the root of a git repository: ${repo}`;
  } catch {
    return `not the root of a git repository: ${repo}`;
  }
  try {
    const origin = await run("git", ["remote", "get-url", "origin"], { cwd: root, signal });
    if (!origin.stdout.trim()) return `repo has no origin remote: ${repo}`;
  } catch {
    return `repo has no origin remote: ${repo}`;
  }
  return undefined;
}

export function buildPullRequestBody(ticket: Ticket, checks: string[]): string {
  const criteria = ticket.acceptanceCriteria.map((criterion) => `| ${criterion.replaceAll("|", "\\|")} |`).join("\n");
  const commands = checks.length ? checks.map((check) => `- \`${check}\``).join("\n") : "- Checks recorded in the ticket log.";
  return [
    `## Goal\n${ticket.goal}`,
    `## Acceptance criteria\n| Criterion |\n| --- |\n${criteria}`,
    `## Checks\n${commands}`,
    "\nAutomated ticket run. This pull request is intentionally left unmerged.",
  ].join("\n\n");
}

export interface TicketStateHost {
  transactTicketState<T>(change: (state: AppState) => T): Promise<T>;
}

export interface TicketExtensionOptions {
  device: string;
  childExtensionNames: readonly string[];
  memory: MemoryClient;
  process?: ProcessRunner;
  now?: () => number;
  timer?: (deadline: number, signal?: AbortSignal) => Promise<void>;
  schedulerEnabled?: boolean;
  nameConversation?: (conversationId: number, name: string) => void;
  plan?: (request: string, cwd: string, context: Context) => Promise<TicketPlanResult>;
}

const TicketReceipts = defineDocFamily<{ [key: string]: JsonValue; runs: Record<string, number> }, null>({
  kind: "dpi.onboard-ticket-receipts",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  family: true,
  initial: () => ({ runs: {} }),
});

export interface TicketRunInput {
  ticketId: string;
  device: string;
  runToken: string;
}

export type TicketCheckpoint = {
  sliceIndex: number;
  children: Record<string, number>;
  /** Per-slice worker submissions retried after a terminal empty/aborted response. */
  attempts?: Record<string, number>;
  worktree?: string;
  branch?: string;
  checks: string[];
  pr?: string;
} & (
  | { phase: "prepare" }
  | { phase: "build" }
  | { phase: "qa" }
  | { phase: "review" }
  | { phase: "pr" }
  | { phase: "done" }
);

export interface TicketRunResult {
  ticketId: string;
  status: "done" | "blocked" | "already-running";
  pr?: string;
  message?: string;
}

type TicketRuntime = TaskRuntime<TicketRunInput, TicketCheckpoint, TicketRunResult, object>;

function rootOnly(api: ToolExecutionApi): void {
  if (api.conversationId !== ROOT_CONVERSATION_ID) throw new Error("Ticket tools are available only to root conversations");
}

function response(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function ticketTable(tickets: Ticket[]): string {
  if (!tickets.length) return "No tickets. Use add_ticket to plan work.";
  return [
    "| Status | ID | Title | Device | PR / blocker |",
    "| --- | --- | --- | --- | --- |",
    ...tickets.map((ticket) => `| ${ticket.status} | ${ticket.id} | ${ticket.title.replaceAll("|", "\\|")} | ${ticket.device} | ${ticket.pr ?? ticket.blockedNote ?? ""} |`),
  ].join("\n");
}

function jsonFromAnswer(text: string): unknown {
  const source = text.trim();
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) return JSON.parse(fenced);
  const first = source.indexOf("{");
  const last = source.lastIndexOf("}");
  if (first < 0 || last < first) throw new Error("Planning child did not return a JSON ticket plan");
  return JSON.parse(source.slice(first, last + 1));
}

function planningInstructions(request: string, cwd: string, repoProblem?: string): string {
  return `You are a planning child. Plan the user's request for a durable unattended ticket. Ask no more than one necessary clarification question; if a question is needed, answer only JSON {"question":"one focused question"}. Otherwise output only JSON with title, goal, decisions (string[]), acceptanceCriteria (string[]), plan (array of {id,expert,task,dependsOn,verify?}), tier (fix|small|medium|large), and repo (absolute repository root). Use this repo by default: ${cwd}. ${repoProblem ? `It is not usable: ${repoProblem}. Choose another repo only if the request names one; otherwise ask the user.` : "The repository must have an origin remote and must not be under a work/work-laptop/office path."} Ask one question at a time through the root orchestrator; do not guess scope, safety, or acceptance. Define 3–7 observable criteria. Use exact expert names from the roster. Plan small/fix work as one slice where possible; medium/large plans should end with QA when user-facing and reviewer last. Request: ${request}`;
}

async function planInChild(request: string, cwd: string, api: ToolExecutionApi, ctx: Context, options: TicketExtensionOptions): Promise<TicketPlanResult> {
  const repoProblem = await validateTicketRepo(cwd, options.process ?? boundedRunner, ctx.abortSignal);
  let childId: ConversationId | undefined;
  await api.commit(async (tx) => {
    const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 20)).items;
    const child = existing[0] ?? await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
    childId = child.id;
    const agent = await tx.doc(AgentDoc, child.id);
    agent.instructions = [agent.instructions, planningInstructions(request, cwd, repoProblem)].filter(Boolean).join("\n\n");
    if (agent.tools === undefined) agent.tools = { remove: ["bash", "write", "edit", "update_state", "add_ticket", "run_ticket", "update_ticket"] };
    else if (Array.isArray(agent.tools)) agent.tools = agent.tools.filter((name) => !["bash", "write", "edit", "update_state", "add_ticket", "run_ticket", "update_ticket"].includes(name));
    else agent.tools = { remove: [...new Set([...agent.tools.remove, "bash", "write", "edit", "update_state", "add_ticket", "run_ticket", "update_ticket"])] };
  }, ctx);
  if (!childId) throw new Error("Ticket planner child was not created");
  options.nameConversation?.(childId as number, "ticket planner");
  const child = await api.conversation(childId, ctx);
  if (!child) throw new Error("Ticket planner child is unavailable");
  const settled = await (await child.submit({
    type: "input",
    content: `Plan this ticket request. Return the specified JSON only.\n\n${request}`,
    requestId: `ticket-plan:${api.taskId}`,
  }, ctx)).wait(ctx);
  if (settled.status !== "done" || settled.type !== "input") throw new Error(`Ticket planner ended ${settled.status}`);
  const answer = await api.commit((tx) => tx.entry(AssistantEntry, settled.answer), ctx);
  const text = answer?.model?.filter((message) => message.role === "assistant").map((message) => messageText(message as never)).join("\n").trim();
  if (!text) throw new Error("Ticket planner returned no answer");
  const decoded = jsonFromAnswer(text);
  if (isRecord(decoded) && typeof decoded.question === "string" && decoded.question.trim()) return { question: decoded.question.trim() };
  return normalizeTicketPlan(decoded);
}

function createTicketRunTask(store: TicketStore, options: TicketExtensionOptions) {
  const process = options.process ?? boundedRunner;
  const now = options.now ?? Date.now;
  const memory = options.memory;
  const childExtensionNames = [...options.childExtensionNames];

  const task = defineTask<TicketRunInput, TicketCheckpoint, TicketRunResult>({
    name: TICKET_RUN_TASK_NAME,
    version: 1,
    initial: () => ({ phase: "prepare", sliceIndex: 0, children: {}, attempts: {}, checks: [] }),
    phases: {
      prepare: async (task, runtime, ctx) => {
        if (runtime.signal.aborted) return;
        const claim = await store.claim(task.input.ticketId, task.input.device, task.input.runToken, task.id as number, now());
        if (runtime.signal.aborted) {
          if (claim.claimed)
            await store.block(task.input.ticketId, "run was aborted before preparation began", now(), task.input.runToken);
          return;
        }
        if (!claim.claimed) {
          await runtime.commit(() => ({
            status: "terminal",
            outcome: { status: "completed", result: { ticketId: task.input.ticketId, status: "already-running", message: claim.reason ?? "Ticket is not available" } },
          }), ctx);
          return;
        }
        try {
          if (runtime.signal.aborted) return;
          if (!(await store.ownsRun(task.input.ticketId, task.input.runToken)))
            return blockRun(task, runtime, ctx, store, "Ticket run no longer owns the queue", now());
          const ticket = await store.get(task.input.ticketId);
          if (!ticket) throw new Error(`No ticket ${task.input.ticketId}`);
          const problem = await validateTicketRepo(ticket.repo, process, runtime.signal);
          if (problem) throw new Error(problem);
          const worktree = await prepareTicketWorktree(ticket, process, runtime.signal, async (preparing) => {
            const recorded = await store.setWorktree(
              ticket.id, preparing.branch, preparing.worktree, now(), task.input.runToken, false, preparing.baseCommit,
            );
            if (!recorded) throw new Error("ticket run ownership was lost before worktree preparation");
          });
          const ready = await store.setWorktree(
            ticket.id,
            worktree.branch,
            worktree.worktree,
            now(),
            task.input.runToken,
            true,
            ticket.worktreeBaseCommit ?? worktree.baseCommit,
          );
          if (!ready) throw new Error("ticket run ownership was lost before worktree readiness was recorded");
          await runtime.commit(() => ({
            status: "running",
            checkpoint: { ...task.state.checkpoint, phase: "build", worktree: worktree.worktree, branch: worktree.branch },
          }), ctx);
        } catch (error) {
          if (runtime.signal.aborted) return;
          await blockRun(task, runtime, ctx, store, `prepare failed: ${shortError(error)}`, now());
        }
      },
      build: async (task, runtime, ctx) => {
        await runPlanPhase("build", (ticket) => ticket.plan.filter((slice) => !isQa(slice) && !isReviewer(slice)), task, runtime, ctx, store, options, process, now, childExtensionNames);
      },
      qa: async (task, runtime, ctx) => {
        await runPlanPhase("qa", (ticket) => ticket.plan.filter(isQa), task, runtime, ctx, store, options, process, now, childExtensionNames);
      },
      review: async (task, runtime, ctx) => {
        if (!(await store.ownsRun(task.input.ticketId, task.input.runToken)))
          return blockRun(task, runtime, ctx, store, "Ticket run no longer owns the queue", now());
        const ticket = await store.get(task.input.ticketId);
        if (!ticket) return blockRun(task, runtime, ctx, store, `Ticket ${task.input.ticketId} disappeared`, now());
        const planned = ticket.plan.filter(isReviewer);
        const needsReview = ticket.tier === "medium" || ticket.tier === "large" || /auth|security|money|payment|data/i.test(`${ticket.goal} ${ticket.title}`);
        if (!planned.length && !needsReview) {
          await advance(task, runtime, ctx, "pr", task.state.checkpoint);
          return;
        }
        if (!planned.length) {
          await blockRun(task, runtime, ctx, store, "Review is required but the ticket plan has no reviewer slice", now());
          return;
        }
        await runPlanPhase("review", () => planned, task, runtime, ctx, store, options, process, now, childExtensionNames);
      },
      pr: async (task, runtime, ctx) => {
        try {
          if (!(await store.ownsRun(task.input.ticketId, task.input.runToken)))
            return blockRun(task, runtime, ctx, store, "Ticket run no longer owns the queue", now());
          const ticket = await store.get(task.input.ticketId);
          if (!ticket || !ticket.worktreeReady || !task.state.checkpoint.worktree || !task.state.checkpoint.branch)
            throw new Error("Ticket worktree is missing or not ready");
          const wt = await assertTicketWorktreePath(task.state.checkpoint.worktree);
          const branch = task.state.checkpoint.branch;
          const pr = await openTicketPullRequest(ticket, wt, branch, task.state.checkpoint.checks, process, runtime.signal);
          if (!(await store.runLog(ticket.id, `pull request ready: ${pr}`, now(), task.input.runToken)))
            return blockRun(task, runtime, ctx, store, "Ticket run no longer owns the queue", now());
          await runtime.commit(() => ({
            status: "running",
            checkpoint: { ...task.state.checkpoint, phase: "done", pr },
          }), ctx);
        } catch (error) {
          if (runtime.signal.aborted) return;
          await blockRun(task, runtime, ctx, store, `PR phase failed: ${shortError(error)}`, now());
        }
      },
      done: async (task, runtime, ctx) => {
        if (!(await store.ownsRun(task.input.ticketId, task.input.runToken)))
          return blockRun(task, runtime, ctx, store, "Ticket run no longer owns the queue", now());
        const ticket = await store.get(task.input.ticketId);
        const pr = task.state.checkpoint.pr ?? ticket?.pr;
        if (!ticket || !pr) return blockRun(task, runtime, ctx, store, "Ticket PR URL is missing", now());
        try {
          await recordHistory(memory, ticket, pr, process, runtime.signal);
          const completed = await store.complete(ticket.id, pr, now(), task.input.runToken);
          if (!completed) return blockRun(task, runtime, ctx, store, "Ticket run no longer owns the queue", now());
          await runtime.commit(() => ({
            status: "terminal",
            outcome: { status: "completed", result: { ticketId: ticket.id, status: "done", pr } },
          }), ctx);
        } catch (error) {
          if (runtime.signal.aborted) return;
          await blockRun(task, runtime, ctx, store, `Project history note failed: ${shortError(error)}`, now());
        }
      },
    },
    abort: async (task, runtime, ctx) => {
      await store.block(task.input.ticketId, "run was aborted; inspect the log, then set the ticket ready to retry", now(), task.input.runToken);
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "Ticket run aborted" } }), ctx);
    },
  });
  return task;
}

function isQa(slice: TicketSlice): boolean {
  return slice.expert.trim().toLowerCase() === "qa";
}
function isReviewer(slice: TicketSlice): boolean {
  return slice.expert.trim().toLowerCase() === "reviewer";
}
function ticketSlicePhaseRank(slice: TicketSlice): number {
  return isReviewer(slice) ? 2 : isQa(slice) ? 1 : 0;
}
function shortError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 500);
}

export function ticketBlocker(result: string): string | undefined {
  return result.split(/\r?\n/).find((line) => /^(?:NEEDS HUMAN\s*:|BLOCKED\s*:|TICKET_STATUS\s*:\s*BLOCKED(?:\s*:|$))/i.test(line.trim()))?.trim();
}

export function ticketChecks(result: string): string[] {
  return [...new Set(result.split(/\r?\n/)
    .map((line) => /^\s*CHECK:\s*(.+?)\s*$/i.exec(line)?.[1])
    .filter((check): check is string => Boolean(check)))];
}

export function ticketCompleted(result: string): boolean {
  return /^\s*TICKET_STATUS:\s*COMPLETE\s*$/im.test(result);
}

export function completedTicketSlices(ticket: Ticket, phase: "build" | "qa" | "review", sliceIndex: number): Set<string> {
  const earlier = ticket.plan.filter((slice) => phase === "qa"
    ? !isQa(slice) && !isReviewer(slice)
    : phase === "review" ? !isReviewer(slice) : false);
  const current = ticket.plan.filter((slice) => phase === "build"
    ? !isQa(slice) && !isReviewer(slice)
    : phase === "qa" ? isQa(slice) : isReviewer(slice));
  return new Set([...earlier, ...current.slice(0, sliceIndex)].map((slice) => slice.id));
}

async function advance(
  task: { state: { checkpoint: TicketCheckpoint } },
  runtime: TicketRuntime,
  ctx: Context,
  phase: TicketCheckpoint["phase"],
  checkpoint: TicketCheckpoint,
) {
  await runtime.commit(() => ({ status: "running", checkpoint: { ...checkpoint, phase, sliceIndex: 0 } }), ctx);
}

async function blockRun(
  task: { input: TicketRunInput },
  runtime: TicketRuntime,
  ctx: Context,
  store: TicketStore,
  note: string,
  now: number,
) {
  const blocked = await store.block(task.input.ticketId, note, now, task.input.runToken);
  await runtime.commit(() => ({
    status: "terminal",
    outcome: { status: "completed", result: blocked
      ? { ticketId: task.input.ticketId, status: "blocked", message: note }
      : { ticketId: task.input.ticketId, status: "already-running", message: "Ticket run no longer owns the queue" } },
  }), ctx);
}

async function retryTicketSlice(
  task: { state: { checkpoint: TicketCheckpoint } },
  runtime: TicketRuntime,
  ctx: Context,
  sliceId: string,
): Promise<boolean> {
  const checkpoint = task.state.checkpoint;
  const attempts = checkpoint.attempts ?? {};
  const attempt = attempts[sliceId] ?? 0;
  if (attempt >= 1) return false;
  const nextCheckpoint = { ...checkpoint, attempts: { ...attempts, [sliceId]: attempt + 1 } };
  await runtime.commit(() => ({ status: "running", checkpoint: nextCheckpoint }), ctx);
  return true;
}

async function runPlanPhase(
  phase: "build" | "qa" | "review",
  slicesFor: (ticket: Ticket) => TicketSlice[],
  task: { id: TaskId<TicketRunResult>; input: TicketRunInput; state: { checkpoint: TicketCheckpoint } },
  runtime: TicketRuntime,
  ctx: Context,
  store: TicketStore,
  options: TicketExtensionOptions,
  process: ProcessRunner,
  now: () => number,
  childExtensionNames: string[],
) {
  if (!(await store.ownsRun(task.input.ticketId, task.input.runToken)))
    return blockRun(task, runtime, ctx, store, "Ticket run no longer owns the queue", now());
  const ticket = await store.get(task.input.ticketId);
  if (!ticket) return blockRun(task, runtime, ctx, store, `Ticket ${task.input.ticketId} disappeared`, now());
  const checkpoint = task.state.checkpoint;
  if (!ticket.worktreeReady || !checkpoint.worktree || ticket.worktree !== checkpoint.worktree)
    return blockRun(task, runtime, ctx, store, "Ticket worktree readiness was not persisted; refusing worker submission", now());
  try {
    await assertTicketWorktreePath(checkpoint.worktree);
  } catch (error) {
    return blockRun(task, runtime, ctx, store, `Ticket worktree path refused: ${shortError(error)}`, now());
  }
  const slices = slicesFor(ticket);
  const cp = checkpoint;
  if (cp.sliceIndex >= slices.length) {
    const next: TicketCheckpoint["phase"] = phase === "build" ? "qa" : phase === "qa" ? "review" : "pr";
    await advance(task, runtime, ctx, next, cp);
    return;
  }
  const slice = slices[cp.sliceIndex];
  const completedSlices = completedTicketSlices(ticket, phase, cp.sliceIndex);
  for (const dependency of slice.dependsOn) {
    if (!completedSlices.has(dependency)) {
      await blockRun(task, runtime, ctx, store, `Plan dependency ${dependency} is not complete before ${slice.id}`, now());
      return;
    }
  }
  try {
    const profile = await options.memory.call<unknown>("expert", { name: slice.expert }, ctx);
    const childId = await ensureTicketChild(task, slice, profile, runtime, ctx, cp, childExtensionNames, options);
    options.nameConversation?.(childId, slice.expert);
    const handle = await runtime.conversation(childId as ConversationId, ctx);
    if (!handle) throw new Error(`Ticket worker ${slice.expert} is unavailable`);
    if (!(await store.ownsRun(ticket.id, task.input.runToken)))
      return blockRun(task, runtime, ctx, store, "Ticket run no longer owns the queue", now());
    await assertTicketWorktreePath(checkpoint.worktree);
    const prompt = ticketSlicePrompt(ticket, slice, phase, checkpoint.worktree, cp.branch ?? ticket.branch ?? "");
    const attempt = cp.attempts?.[slice.id] ?? 0;
    const requestId = `ticket:${ticket.id}:${phase}:${slice.id}${attempt ? `:retry-${attempt}` : ""}`;
    const settled = await (await handle.submit({ type: "input", content: prompt, requestId }, ctx)).wait(ctx);
    if (settled.status !== "done" || settled.type !== "input") {
      if (await retryTicketSlice(task, runtime, ctx, slice.id)) return;
      throw new Error(`Worker ${slice.expert} ended ${settled.status}`);
    }
    // `runtime.entry` reads the ticket task's conversation; worker answers live in the child conversation.
    const childContext = await runtime.context(childId as ConversationId, ctx, settled.answer);
    const answer = childContext.entries.find((entry) => entry.id === settled.answer);
    const result = answer?.model?.filter((message) => message.role === "assistant").map((message) => messageText(message as never)).join("\n").trim();
    if (!result) {
      if (await retryTicketSlice(task, runtime, ctx, slice.id)) return;
      throw new Error(`Worker ${slice.expert} returned no result`);
    }
    const blocked = ticketBlocker(result);
    if (blocked) throw new Error(blocked);
    if (!ticketCompleted(result)) throw new Error(`Worker ${slice.expert} did not confirm completion with TICKET_STATUS: COMPLETE`);
    if (!(await store.ownsRun(ticket.id, task.input.runToken)))
      return blockRun(task, runtime, ctx, store, "Ticket run no longer owns the queue", now());
    if (!(await store.runLog(ticket.id, `${phase} slice ${slice.id} (${slice.expert}) completed`, now(), task.input.runToken)))
      return blockRun(task, runtime, ctx, store, "Ticket run no longer owns the queue", now());
    const checks = ticketChecks(result);
    for (const check of checks) {
      if (!(await store.runLog(ticket.id, `${phase} check: ${check}`, now(), task.input.runToken)))
        return blockRun(task, runtime, ctx, store, "Ticket run no longer owns the queue", now());
    }
    const nextCheckpoint: TicketCheckpoint = { ...cp, sliceIndex: cp.sliceIndex + 1, checks: [...new Set([...cp.checks, ...checks])] };
    await runtime.commit(() => ({ status: "running", checkpoint: nextCheckpoint }), ctx);
  } catch (error) {
    if (runtime.signal.aborted) return;
    await blockRun(task, runtime, ctx, store, `${phase} slice ${slice.id} failed: ${shortError(error)}`, now());
  }
}

async function ensureTicketChild(
  task: { id: TaskId<TicketRunResult>; input: TicketRunInput },
  slice: TicketSlice,
  value: unknown,
  runtime: TicketRuntime,
  ctx: Context,
  checkpoint: TicketCheckpoint,
  childExtensionNames: string[],
  options: TicketExtensionOptions,
): Promise<number> {
  const existingId = checkpoint.children[slice.id];
  if (existingId !== undefined) return existingId;
  if (!isRecord(value) || !isRecord(value.profile) || !isRecord(value.model)) throw new Error(`Expert ${slice.expert} returned an invalid profile`);
  const profile = value.profile;
  const model = value.model;
  const profileBody = typeof profile.body === "string" ? profile.body : undefined;
  const modelId = typeof model.model === "string" ? model.model : undefined;
  const thinking = typeof model.thinking === "string" ? model.thinking : undefined;
  if (profile.name !== slice.expert || profileBody === undefined) throw new Error(`Expert ${slice.expert} profile is incomplete`);
  if (modelId === undefined || thinking === undefined) throw new Error(`Expert ${slice.expert} has no model`);
  const slash = modelId.indexOf("/");
  if (slash < 1 || slash === modelId.length - 1) throw new Error(`Expert ${slice.expert} has an invalid model id`);
  const thinkingLevel = durableThinkingLevel(thinking);
  if (!thinkingLevel) throw new Error(`Expert ${slice.expert} has invalid thinking level ${thinking}`);
  const denied = Array.isArray(profile.excludeTools) ? profile.excludeTools.filter((name): name is string => typeof name === "string") : [];
  let childId = 0;
  await runtime.commit(async (tx, current) => {
    const already = current.state.checkpoint.children[slice.id];
    if (already !== undefined) {
      childId = already;
      return undefined;
    }
    const conversation = await tx.createConversation({ ownership: { kind: "task", taskId: task.id } });
    childId = conversation.id as number;
    const agent = await tx.doc(AgentDoc, conversation.id);
    agent.model = { provider: modelId.slice(0, slash), modelId: modelId.slice(slash + 1) };
    agent.thinkingLevel = thinkingLevel;
    agent.cwd = current.state.checkpoint.worktree ?? "";
    agent.extensions = childExtensionNames;
    agent.instructions = [profileBody.trim(), `## Ticket ${task.input.ticketId}`, `Implement only slice ${slice.id}. Work only in the ticket worktree. Do not push or merge.`, "Return exact verification commands one per line as CHECK: <command>, criteria verified, and any unresolved blocker. Limit attempts to two per acceptance criterion. End with TICKET_STATUS: COMPLETE only when assigned criteria pass, or TICKET_STATUS: BLOCKED: <exact need> when they do not."].join("\n\n");
    if (denied.length) {
      const tools = agent.tools;
      if (tools === undefined) agent.tools = { remove: denied };
      else if (Array.isArray(tools)) agent.tools = tools.filter((name) => !denied.includes(name));
      else agent.tools = { remove: [...new Set([...tools.remove, ...denied])] };
    }
    const identity = await tx.doc(ExpertIdentity, conversation.id);
    identity.expert = slice.expert;
    identity.excludedTools = denied;
    identity.worktree = null;
    identity.worktreeReady = true;
    identity.ticketSliceId = slice.id;
    const next = { ...current.state.checkpoint, children: { ...current.state.checkpoint.children, [slice.id]: childId } };
    return { status: "running", checkpoint: next };
  }, ctx);
  if (!childId) throw new Error(`Could not create worker for ${slice.id}`);
  return childId;
}

function ticketSlicePrompt(ticket: Ticket, slice: TicketSlice, phase: string, worktree: string, branch: string): string {
  return [
    `Ticket ${ticket.id}: ${ticket.title} (${ticket.tier} tier)`,
    `Goal: ${ticket.goal}`,
    `Worktree: ${worktree}${branch ? ` on branch ${branch}` : ""}. Never edit the user's checkout or push/merge.`,
    `Phase: ${phase}. Slice ${slice.id}: ${slice.task}`,
    `Dependencies integrated: ${slice.dependsOn.join(", ") || "none"}.`,
    `Acceptance criteria:\n${ticket.acceptanceCriteria.map((item, i) => `${i + 1}. ${item}`).join("\n")}`,
    slice.verify ? `Verification: ${slice.verify}` : "Run the most relevant checks and report each exact command on a separate `CHECK: <command>` line.",
    "Work in the provided ticket worktree only. Fix failures with no more than two attempts per acceptance criterion. Do not finish until you report criteria status and remaining risks. Return each exact verification command on a `CHECK: <command>` line. End with `TICKET_STATUS: COMPLETE` only when the criteria pass, or `TICKET_STATUS: BLOCKED: <exact need>` when they do not.",
  ].join("\n\n");
}

export async function prepareTicketWorktree(
  ticket: Ticket,
  process: ProcessRunner = boundedRunner,
  signal?: AbortSignal,
  onPreparing?: (worktree: { worktree: string; branch: string; base: string; baseCommit: string }) => Promise<void>,
): Promise<{ worktree: string; branch: string; base: string; baseCommit: string }> {
  const branch = ticket.branch ?? `ticket/${ticket.id}`;
  let repoParent = dirname(ticket.repo);
  try { repoParent = await realpath(repoParent); } catch {}
  const requestedPath = ticket.worktree ?? join(repoParent, `${basename(ticket.repo)}-tickets`, ticket.id);
  const worktree = await assertTicketWorktreePath(requestedPath);
  await process("git", ["fetch", "--quiet", "origin"], { cwd: ticket.repo, signal });
  const defaultBranch = (await process("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: ticket.repo, signal })).stdout.trim();
  if (!defaultBranch.startsWith("origin/")) throw new Error("origin/HEAD does not identify the origin default branch");
  const baseCommit = (await process("git", ["rev-parse", "--verify", `${defaultBranch}^{commit}`], { cwd: ticket.repo, signal })).stdout.trim();
  const listing = (await process("git", ["worktree", "list", "--porcelain"], { cwd: ticket.repo, signal })).stdout;
  const registered: { path: string; ref: string | undefined }[] = [];
  for (const entry of listing.split(/\r?\n\r?\n/)) {
    const path = entry.split(/\r?\n/).find((line) => line.startsWith("worktree "))?.slice(9);
    const ref = entry.split(/\r?\n/).find((line) => line.startsWith("branch "))?.slice(7);
    if (path) registered.push({ path: await canonicalFuturePath(path), ref });
  }
  const existing = registered.find((entry) => entry.path === worktree);
  // Older runs persisted worktree/branch only after checkout completed, so keep their already-started workers resumable.
  const legacyReady = ticket.worktreeReady === undefined && Boolean(ticket.worktree && ticket.branch);
  const ready = ticket.worktreeReady === true || legacyReady;
  const readGit = async (cwd: string, args: string[]) =>
    (await process("git", args, { cwd, signal })).stdout.trim();
  const prep = { worktree, branch, base: defaultBranch, baseCommit };
  if (existing) {
    await assertTicketWorktreePath(existing.path);
    if (existing.ref !== `refs/heads/${branch}`) throw new Error(`Ticket worktree ${worktree} is attached to a different branch`);
    if (!ready) {
      await onPreparing?.(prep);
      await assertPristineWorktree(worktree, ticket.worktreeBaseCommit ?? baseCommit, readGit, "ticket worktree");
    }
    return { ...prep, base: "(existing worktree)" };
  }
  if (ready) throw new Error(`Ticket worktree ${worktree} was marked ready but is no longer registered`);
  if (existsSync(worktree)) throw new Error(`Ticket worktree path exists but is not registered: ${worktree}`);
  await onPreparing?.(prep);
  const branchList = (await process("git", ["branch", "--list", branch], { cwd: ticket.repo, signal })).stdout.trim();
  await import("node:fs/promises").then(({ mkdir }) => mkdir(dirname(worktree), { recursive: true }));
  await assertTicketWorktreePath(worktree);
  if (existsSync(worktree)) throw new Error(`Ticket worktree path exists but is not registered: ${worktree}`);
  if (branchList) await process("git", ["worktree", "add", worktree, branch], { cwd: ticket.repo, signal });
  else await process("git", ["worktree", "add", "-b", branch, worktree, baseCommit], { cwd: ticket.repo, signal });
  await assertPristineWorktree(worktree, ticket.worktreeBaseCommit ?? baseCommit, readGit, "ticket worktree");
  return prep;
}

export async function openTicketPullRequest(
  ticket: Ticket,
  worktree: string,
  branch: string,
  checks: string[],
  process: ProcessRunner = boundedRunner,
  signal?: AbortSignal,
): Promise<string> {
  const status = (await process("git", ["status", "--porcelain"], { cwd: worktree, signal })).stdout.trim();
  if (status) {
    await process("git", ["add", "--all"], { cwd: worktree, signal });
    await process("git", ["commit", "-m", `ticket: ${ticket.title}`], { cwd: worktree, signal });
  }
  await process("git", ["push", "--set-upstream", "origin", branch], { cwd: worktree, signal });
  const existing = (await process("gh", ["pr", "list", "--head", branch, "--json", "url", "--jq", ".[0].url // empty"], {
    cwd: worktree,
    signal,
  })).stdout.trim();
  const pr = existing || (await process("gh", [
    "pr", "create", "--head", branch, "--title", ticket.title, "--body", buildPullRequestBody(ticket, checks),
  ], { cwd: worktree, signal })).stdout.trim();
  if (!/^https:\/\//.test(pr)) throw new Error(`gh did not return a pull request URL: ${pr || "empty output"}`);
  return pr;
}

async function recordHistory(memory: MemoryClient, ticket: Ticket, pr: string, process: ProcessRunner, signal?: AbortSignal) {
  let projectKey: string;
  try {
    const url = (await process("git", ["remote", "get-url", "origin"], { cwd: ticket.repo, signal })).stdout.trim();
    projectKey = normalizeRemote(url) ?? `local/${slugifyTicketTitle(basename(ticket.repo))}`;
  } catch {
    projectKey = `local/${slugifyTicketTitle(basename(ticket.repo))}`;
  }
  const entry = `Ticket ${ticket.id}: ${ticket.title}. PR ${pr}. Goal: ${ticket.goal}`;
  try {
    const existing = await memory.call<{ text: string }>("read", { projectKey, path: "notes/history.md" }, undefined);
    if (existing.text.includes(entry)) return;
  } catch {
    // A missing history note is the ordinary first-run case. The id check below also makes crash replay safe.
  }
  await memory.call("note", {
    scope: "project",
    projectKey,
    topic: "history",
    summary: "Durable ticket execution history",
    entry,
    actor: "orchestrator",
  }, undefined);
}

export function createTicketsExtension(host: TicketStateHost, options: TicketExtensionOptions): Extension {
  const now = options.now ?? Date.now;
  const process = options.process ?? boundedRunner;
  const store = new TicketStore((mutate) => host.transactTicketState((state) => mutate(state as Record<string, unknown>)));
  const runTask = createTicketRunTask(store, options);
  const schedulerTask = createTicketSchedulerTask({
    store,
    runTask,
    device: options.device,
    enabled: options.schedulerEnabled === true,
    process,
    now,
    timer: options.timer,
  });

  const addTicket = defineTool({
    name: "add_ticket",
    description: "Plan durable repository work with the user. Clarify one question at a time; when the plan is complete, save a ready ticket with goal, decisions, acceptance criteria, expert slices, tier, repo, and device.",
    parameters: Type.Object({ request: Type.String({ minLength: 1, maxLength: 20_000 }) }),
    replay: "safe",
    execute: async (args: { request: string }, api: ToolExecutionApi, ctx: Context) => {
      rootOnly(api);
      const cwd = (await api.agent(ctx)).cwd;
      if (!cwd) throw new Error("add_ticket requires a working directory");
      const decision = options.plan
        ? await options.plan(args.request, cwd, ctx)
        : await planInChild(args.request, cwd, api, ctx, options);
      if ("question" in decision) return response(`Ask the user this one question, then call add_ticket again with the answer included: ${decision.question}`);
      const normalized = normalizeTicketPlan(decision);
      const problem = await validateTicketRepo(normalized.repo, process, ctx.abortSignal);
      if (problem) throw new Error(`Cannot create ticket: ${problem}`);
      const createdAt = new Date(now()).toISOString();
      const candidate = ticketIdFor(normalized.title, now(), randomUUID().slice(0, 8));
      const id = await api.memo<string>("ticket-add-id", ctx) ?? await api.memo("ticket-add-id", candidate, ctx);
      const ticket: Ticket = {
        ...normalized,
        id,
        device: options.device,
        status: "ready",
        log: [{ at: createdAt, text: "planned and queued" }],
        createdAt,
        updatedAt: createdAt,
      };
      // The tool task ID and memoized ticket ID are stable across replay.
      const existing = await store.get(id);
      if (!existing) await store.add(ticket);
      return response(`Ticket ${id} — ${ticket.title} is ready on ${ticket.device} with ${ticket.plan.length} plan slice(s).`);
    },
  });

  const listTicketsTool = defineTool({
    name: "list_tickets",
    description: "List durable tickets on this device, optionally filtered by status.",
    parameters: Type.Object({ status: Type.Optional(Type.Union(STATUSES.map((status) => Type.Literal(status)) as [ReturnType<typeof Type.Literal>, ...ReturnType<typeof Type.Literal>[]])) }),
    replay: "safe",
    execute: async (args: { status?: TicketStatus }, api: ToolExecutionApi) => {
      rootOnly(api);
      const tickets = await store.list();
      return response(ticketTable(args.status ? tickets.filter((ticket) => ticket.status === args.status) : tickets));
    },
  });

  const runTicket = defineTool({
    name: "run_ticket",
    description: "Start a ready ticket now. Only one ticket may run at a time on this device; the run is a durable checkpointed task and opens a PR but never merges it.",
    parameters: Type.Object({ id: Type.String({ minLength: 1 }) }),
    replay: "safe",
    execute: async (args: { id: string }, api: ToolExecutionApi, ctx: Context) => {
      rootOnly(api);
      let id = 0;
      await api.commit(async (tx) => {
        const receipt = await tx.doc(TicketReceipts, api.conversationId, String(api.taskId), null);
        if (receipt.runs[String(api.taskId)]) {
          id = receipt.runs[String(api.taskId)];
          return;
        }
        id = await tx.createTask(runTask, { ticketId: args.id, device: options.device, runToken: randomUUID() }, {
          ownership: { kind: "conversation" },
          background: true,
        }) as number;
        receipt.runs[String(api.taskId)] = id;
      }, ctx);
      await api.details({ ticketId: args.id, taskId: id }, ctx);
      return response(`Started ticket ${args.id} as durable task #${id}. It will report a PR or the exact action needed if blocked.`);
    },
  });

  const updateTicket = defineTool({
    name: "update_ticket",
    description: "Update a ticket's status or add a note. Set a blocked ticket back to ready to unblock it; set status done with a note to cancel it.",
    parameters: Type.Object({ id: Type.String({ minLength: 1 }), status: Type.Optional(Type.Union(STATUSES.map((status) => Type.Literal(status)) as [ReturnType<typeof Type.Literal>, ...ReturnType<typeof Type.Literal>[]])), note: Type.Optional(Type.String({ maxLength: 1000 })) }),
    replay: "unsafe",
    execute: async (args: { id: string; status?: TicketStatus; note?: string }, api: ToolExecutionApi) => {
      rootOnly(api);
      const ticket = await store.update(args.id, args.status, args.note, now());
      return response(`Ticket ${ticket.id} updated: ${ticket.status}${ticket.blockedNote ? ` — ${ticket.blockedNote}` : ""}`);
    },
  });

  const extension = defineExtension({
    name: "tickets",
    tasks: [runTask, schedulerTask],
    tools: [addTicket, listTicketsTool, runTicket, updateTicket],
  });
  return extension;
}
