import { SharedState } from "./shared-state.js";
import type { StateChange } from "../../dpi-sdk/src/app-state.js";
import type {
  AgentDetail,
  AgentExtensions,
  AgentRef,
  AgentSummary,
  CreateSessionBody,
  DeviceInfo,
  DeviceTree,
  DirListing,
  InboxItem,
  ModelInfo,
  Page,
  SendResult,
  SessionSummary,
  TaskNode,
  TaskOutcome,
  ThinkingLevel,
  UsageTotals,
  WhenBusy,
  WireEntry,
} from "../../dpi-sdk/src/api.js";
import {
  compactionFits,
  DEFAULT_COMPACTION,
  defaultCompaction,
  THINKING_LEVELS,
  type CompactionSettings,
} from "../../dpi-sdk/src/api.js";
import { lastAssistantText, messageText, toMarkdown, toTranscript } from "../../dpi-sdk/src/transcript.js";
import { ApiFault, invalid, notFound } from "./errors.js";
import { DatabaseSync } from "node:sqlite";
import { lstat, mkdir, readdir, realpath, rename as renamePath, stat } from "node:fs/promises";
import { mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { join, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { homedir, hostname, platform } from "node:os";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as ctx, withAbortSignal } from "@earendil-works/chord/context";
import { createModels, type MutableModels } from "@earendil-works/pi-ai/models";
import {
  fileCredentialStore,
  installSubscription,
  isSubscriptionProvider,
  subscriptionDefault,
  subscriptionModels,
} from "./subscription.js";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { curatedModels, defaultModelId } from "./model-catalog.js";
import { fauxModels, installFaux } from "./faux.js";
import {
  AgentDoc,
  defineDoc,
  Harness,
  ROOT_CONVERSATION_ID,
  createRegistry,
  InboxDoc,
  type Conversation,
  type ConversationId,
  type ConversationRecord,
  type AgentState,
  type EntryId,
  type TaskId,
  type SubmissionId,
  type ModelRef,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createPlayground, Workspace, type SpawnSession } from "./extensions.js";
import { createJobs, JobRuns, JOB_DEFS, jobDef, resolveJobInput, type Jobs } from "./jobs.js";
import { ADDON_INFO, createAddons, PROMPTS, PromptChecklist, type Addons } from "./addons.js";
import { JOB_RUNS_DOC } from "../../dpi-sdk/src/jobs.js";
import { onboardEnabledFromEnv, onboardOptionsFromEnv, type OnboardOptions } from "./onboard/config.js";
import { expandSkillCommand, listSkillCatalog, type SkillCatalogItem } from "./onboard/skills.js";
import { installOnboard } from "./onboard/index.js";
import { ExpertIdentity } from "./onboard/experts.js";
import { commandApprovalFromUserMessage, createGuardApprovalHost, createGuardsExtension, type GuardApprovalHost } from "./onboard/guards.js";
import { TICKET_RUN_TASK_NAME, TICKET_SCHEDULER_TASK_NAME } from "./onboard/tickets.js";

export const DURABLE_VERSION = "1.0.3";

/** Tools that create, update or delete: shell, files, App State, job runs, sessions, pages and subagents. */
export const WRITE_TOOLS = new Set([
  "bash",
  "write",
  "edit",
  "update_state",
  "run_durable_job",
  "ping_on_call_engineer",
  "subagent",
  "start_session",
  "memory_note",
  "memory_rewrite",
  "delegate",
  "add_ticket",
  "run_ticket",
  "update_ticket",
  "remind",
  "cancel_reminder",
]);

// Writer tools available before onboarding introduced memory mutations. Used only to recognize the legacy
// read-only representation during the one-time upgrade migration.
const LEGACY_WRITE_TOOLS = new Set([
  "bash",
  "write",
  "edit",
  "update_state",
  "run_durable_job",
  "ping_on_call_engineer",
  "subagent",
  "start_session",
]);

type SavedToolSelection =
  | { kind: "all" }
  | { kind: "allow"; names: string[] }
  | { kind: "remove"; names: string[] };
type ReadOnlyPolicyState = {
  mode: "unset" | "read-only" | "read-write";
  previousTools: SavedToolSelection;
};

const ReadOnlyPolicy = defineDoc<ReadOnlyPolicyState>({
  kind: "dpi.store-read-only-policy",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ mode: "unset", previousTools: { kind: "all" } }),
  checkpointWhen: () => true,
});

type AgentCloseState = { closed: boolean };
const AgentClose = defineDoc<AgentCloseState>({
  kind: "dpi.store-agent-close",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ closed: false }),
});

type GuardSelectionState = { migrationVersion: number; optedOut: boolean };
const GUARD_SELECTION_MIGRATION_VERSION = 1;
const GuardSelectionPolicy = defineDoc<GuardSelectionState>({
  kind: "dpi.store-guard-selection",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ migrationVersion: 0, optedOut: false }),
});

function saveToolSelection(tools: AgentState["tools"]): SavedToolSelection {
  if (tools === undefined) return { kind: "all" };
  if (Array.isArray(tools)) return { kind: "allow", names: [...tools] };
  return { kind: "remove", names: [...tools.remove] };
}

function restoreToolSelection(agent: AgentState, saved: SavedToolSelection) {
  if (saved.kind === "all") delete agent.tools;
  else if (saved.kind === "allow") agent.tools = [...saved.names];
  else agent.tools = { remove: [...saved.names] };
}

function cloneToolSelection(saved: SavedToolSelection): SavedToolSelection {
  return saved.kind === "all" ? { kind: "all" } : { kind: saved.kind, names: [...saved.names] };
}

function removeTools(tools: AgentState["tools"], names: string[]): AgentState["tools"] {
  if (names.length === 0) return tools;
  const removed = new Set(names);
  if (tools === undefined) return { remove: [...removed] };
  if (Array.isArray(tools)) return tools.filter((name) => !removed.has(name));
  return { remove: [...new Set([...tools.remove, ...removed])] };
}

function legacyReadOnlySelection(tools: AgentState["tools"], legacyWriters: string[]): boolean {
  return (
    tools !== undefined &&
    !Array.isArray(tools) &&
    legacyWriters.length > 0 &&
    legacyWriters.every((name) => tools.remove.includes(name))
  );
}

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertWithinDirectory(root: string, path: string) {
  const fromRoot = relative(root, path);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot))
    throw new Error("Session database path escapes the data directory");
}

export type SessionRow = {
  id: string;
  name: string;
  cwd: string;
  dbPath: string;
  createdAt: number;
  model: string;
  provider: string;
};

export interface StoreOptions {
  dataDir: string;
  startDirs: string[];
  name: string;
  provider: "openrouter" | "faux" | "subscription";
  /** pi auth.json for provider "subscription"; defaults to ~/.pi/agent/auth.json. */
  authFile?: string;
}

/** Agent documents a client may read or stream, by kind. */
/** apps/dpi-backend/src → the checkout root. */
const CODE_DIR = resolve(import.meta.dirname, "../../..");
const AGENT_DOCS = { [JOB_RUNS_DOC]: JobRuns, "demo.workspace": Workspace } as const;
export const AGENT_DOC_KINDS = Object.keys(AGENT_DOCS);
export const DEVICE_DOC_KINDS = ["app.shared-state"];

export function lockFile(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const take = () => writeFileSync(path, String(process.pid), { flag: "wx", mode: 0o600 });
  try {
    take();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const pid = Number(readFileSync(path, "utf8"));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") alive = true;
    }
    if (alive && pid !== process.pid) throw Error(`Database already owned by process ${pid}: ${path}`);
    unlinkSync(path);
    take();
  }
  return () => {
    try {
      if (readFileSync(path, "utf8") === String(process.pid)) unlinkSync(path);
    } catch {}
  };
}

type Opened = { harness: Harness; unlock: () => void; unsubscribe: () => void; jobs: Jobs; addons: Addons; guardApprovals?: GuardApprovalHost; ticketScheduler?: unknown };
type Resolved = { row: SessionRow; h: Harness; c: Conversation };

const encodeCursor = (cursor: unknown) =>
  cursor === undefined ? undefined : Buffer.from(JSON.stringify(cursor)).toString("base64url");
const decodeCursor = (cursor?: string) => {
  if (!cursor) return undefined;
  try {
    return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalid("Invalid cursor");
  }
};

export class Store {
  readonly models: MutableModels;
  readonly opened = new Map<string, Opened>();
  readonly errors = new Map<string, string>();
  readonly catalog: DatabaseSync;
  readonly startedAt = Date.now();
  shared!: SharedState;
  uid!: string;
  modelList: ModelInfo[] = [];
  private unlockCatalog: () => void;
  private unlockShared?: () => void;
  private listeners = new Set<() => void>();
  /** Saved thresholds per session; null when the session uses the defaults for its model. */
  private compactions = new Map<string, Partial<CompactionSettings> | null>();
  /** Task labels never change once known: tool names of pi.tool tasks, job titles of job runs. */
  private taskLabels = new Map<string, { label?: string; callId?: string }>();
  /** Serializes all Store submission admissions by conversation and requestId before host approval side effects. */
  private submissionTails = new Map<string, Promise<void>>();

  get catalogPath() {
    return join(this.options.dataDir, "catalog.sqlite");
  }
  get sharedStatePath() {
    return join(this.options.dataDir, "app-state.sqlite");
  }
  get sessionsDir() {
    return join(this.options.dataDir, "sessions");
  }
  get archiveDir() {
    return join(this.options.dataDir, "archive");
  }
  get name() {
    return this.options.name;
  }
  get startDirs() {
    return this.options.startDirs;
  }

  private constructor(readonly options: StoreOptions, private readonly onboardOptions?: OnboardOptions) {
    this.models = createModels(
      options.provider === "subscription" ? { credentials: fileCredentialStore(options.authFile) } : undefined,
    );
    if (options.provider === "faux") installFaux(this.models);
    else if (options.provider === "subscription") installSubscription(this.models);
    else {
      const provider = openrouterProvider();
      const catalog = provider.getModels();
      for (const model of curatedModels)
        if (!catalog.some((m) => m.id === model.id)) throw Error(`OpenRouter catalog missing ${model.id}`);
      this.models.setProvider({
        ...provider,
        getModels: () => catalog.filter((m) => curatedModels.some((c) => c.id === m.id)),
      });
    }
    mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
    this.unlockCatalog = lockFile(`${this.catalogPath}.lock`);
    this.catalog = new DatabaseSync(this.catalogPath);
    this.catalog.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,name TEXT NOT NULL,cwd TEXT NOT NULL,dbPath TEXT NOT NULL UNIQUE,createdAt INTEGER NOT NULL,model TEXT NOT NULL,provider TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation_names(sessionId TEXT NOT NULL,conversationId INTEGER NOT NULL,name TEXT NOT NULL,PRIMARY KEY(sessionId,conversationId));
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests(key TEXT PRIMARY KEY,route TEXT NOT NULL,status INTEGER NOT NULL,body TEXT NOT NULL,createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS session_spawns(key TEXT PRIMARY KEY,sessionId TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_compaction(sessionId TEXT PRIMARY KEY,settings TEXT NOT NULL);`);
    const uid = this.catalog.prepare("SELECT value FROM meta WHERE key='device_uid'").get() as
      | { value: string }
      | undefined;
    this.uid = uid?.value ?? randomUUID();
    if (!uid) this.catalog.prepare("INSERT INTO meta(key,value) VALUES('device_uid',?)").run(this.uid);
    this.catalog.prepare("DELETE FROM requests WHERE createdAt < ?").run(Date.now() - 24 * 3600_000);
  }

  static async open(options: StoreOptions) {
    const onboardOptions = onboardEnabledFromEnv() ? onboardOptionsFromEnv() : undefined;
    const store = new Store({ ...options, dataDir: resolve(options.dataDir) }, onboardOptions);
    // Start dirs are where new sessions begin; create any that do not exist yet.
    await Promise.all(options.startDirs.map((dir) => mkdir(dir, { recursive: true }).catch(() => {})));
    try {
      store.unlockShared = lockFile(`${store.sharedStatePath}.lock`);
      store.shared = await SharedState.open(store.sharedStatePath);
      store.shared.harness.subscribeCommits(() => store.notify());
      for (const row of store.list()) {
        try {
          await store.openAgent(row);
        } catch (e) {
          store.errors.set(row.id, String(e instanceof Error ? e.message : e));
        }
      }
      if (!(await store.shared.initialized()))
        await store.shared.initialize({ goal: "Explore durable agents", counter: 0, notes: [] });
      await store.ensureTicketScheduler();
      store.modelList = await store.loadModels();
      for (const { harness } of store.opened.values()) harness.resume();
      return store;
    } catch (e) {
      await store.close().catch(() => {});
      throw e;
    }
  }

  // ------------------------------------------------------------ change feed

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
  notify = () => {
    for (const fn of this.listeners) fn();
  };

  // ------------------------------------------------------------ device

  deviceInfo(): DeviceInfo {
    return {
      uid: this.uid,
      name: this.name,
      hostname: hostname(),
      platform: `${platform()}-${process.arch} node ${process.version}`,
      apiVersion: 1,
      durableVersion: DURABLE_VERSION,
      startedAt: this.startedAt,
      startDirs: this.startDirs,
      models: this.modelList,
      defaultModel: this.defaultModel(),
      storage: { dataDir: this.options.dataDir, catalogPath: this.catalogPath, appStatePath: this.sharedStatePath },
      codeDir: CODE_DIR,
      capabilities: ["events", "docs", "demo", "jobs"],
      jobs: JOB_DEFS,
    };
  }

  skillsCatalog(): SkillCatalogItem[] {
    return this.onboardOptions ? listSkillCatalog(this.onboardOptions) : [];
  }

  private defaultModel() {
    if (this.options.provider === "subscription") return subscriptionDefault().modelId;
    return this.options.provider === "faux" ? fauxModels[0].id : defaultModelId;
  }

  private async loadModels(): Promise<ModelInfo[]> {
    if (this.options.provider === "faux")
      return fauxModels.map((m) => ({
        id: m.id,
        provider: "faux",
        name: m.name,
        tier: "T",
        icon: "lab.png",
        contextWindow: 128000,
        reasoning: false,
        cost: { input: 0, output: 0 },
      }));
    if (this.options.provider === "subscription") return subscriptionModels(this.models);
    const available = await this.models.getAvailable("openrouter", { signal: AbortSignal.timeout(10000) });
    return curatedModels.flatMap((c) => {
      const m = available.find((m) => m.id === c.id);
      return m
        ? [
            {
              id: m.id,
              provider: "openrouter",
              name: c.name,
              tier: c.tier,
              icon: c.icon,
              contextWindow: m.contextWindow,
              reasoning: m.reasoning,
              cost: { input: m.cost.input, output: m.cost.output },
            },
          ]
        : [];
    });
  }

  routedModel(model?: ModelRef): ModelRef {
    if (this.options.provider === "faux") {
      const id = fauxModels.some((m) => m.id === model?.modelId) ? model!.modelId : fauxModels[0].id;
      return { provider: "faux", modelId: id };
    }
    if (this.options.provider === "subscription") {
      if (model && isSubscriptionProvider(model.provider) && this.models.getModel(model.provider, model.modelId))
        return { provider: model.provider, modelId: model.modelId };
      // A bare model id (e.g. the TUI passing info.defaultModel) resolves to whichever provider has it.
      const byId = model && this.modelList.find((m) => m.id === model.modelId);
      return byId ? { provider: byId.provider, modelId: byId.id } : subscriptionDefault();
    }
    const exact = model?.provider === "openrouter" ? model.modelId : `${model?.provider}/${model?.modelId}`;
    return {
      provider: "openrouter",
      modelId: curatedModels.some((m) => m.id === exact) ? exact : defaultModelId,
    };
  }

  validateModel(model: unknown): ModelRef {
    const m = model as ModelRef | undefined;
    if (!m || typeof m.provider !== "string" || typeof m.modelId !== "string")
      throw invalid("model must be { provider, modelId }");
    const known =
      this.options.provider === "subscription"
        ? isSubscriptionProvider(m.provider) && !!this.models.getModel(m.provider, m.modelId)
        : this.options.provider === "faux"
        ? m.provider === "faux" && fauxModels.some((f) => f.id === m.modelId)
        : m.provider === "openrouter" &&
          curatedModels.some((c) => c.id === m.modelId) &&
          !!this.models.getModel(m.provider, m.modelId);
    if (!known) throw invalid(`Unknown model ${m.provider}/${m.modelId}. Choose one from GET /v1/device models`);
    return { provider: m.provider, modelId: m.modelId };
  }

  // ------------------------------------------------------------ directories

  async directories(): Promise<DirListing> {
    const dirs: { name: string; path: string }[] = [];
    for (const root of this.startDirs) {
      try {
        dirs.push({ name: root, path: await realpath(root) });
      } catch {}
    }
    return { path: "", dirs };
  }

  async browse(path: string): Promise<DirListing> {
    if (!path) return this.directories();
    const expanded = path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
    let real: string;
    try {
      real = await realpath(resolve(expanded));
      if (!(await stat(real)).isDirectory()) throw Error();
    } catch {
      throw notFound(`Not a directory on ${this.name}: ${path}`);
    }
    const dirs: { name: string; path: string }[] = [];
    try {
      for (const entry of await readdir(real, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
        dirs.push({ name: entry.name, path: join(real, entry.name) });
      }
    } catch (e) {
      throw new ApiFault("unavailable", `Cannot list ${real}: ${(e as Error).message}`);
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    return { path: real, parent: dirname(real) !== real ? dirname(real) : undefined, dirs: dirs.slice(0, 500) };
  }

  // ------------------------------------------------------------ sessions

  private sessionDbPath(id: string) {
    if (typeof id !== "string" || !SESSION_ID_PATTERN.test(id)) throw new Error("Invalid session id");
    return join(this.sessionsDir, id, "agent.sqlite");
  }

  private sessionRow(row: SessionRow): SessionRow {
    return { ...row, dbPath: this.sessionDbPath(row.id) };
  }

  list(): SessionRow[] {
    return (this.catalog.prepare("SELECT * FROM sessions ORDER BY createdAt DESC").all() as SessionRow[])
      .map((row) => this.sessionRow(row));
  }

  row(id: string): SessionRow {
    const row = this.catalog.prepare("SELECT * FROM sessions WHERE id=?").get(id) as SessionRow | undefined;
    if (!row) throw notFound(`No session ${id}`);
    return this.sessionRow(row);
  }

  /** A session by UUID or unique case-insensitive name. */
  resolveSession(ref: string): SessionRow {
    const byId = this.catalog.prepare("SELECT * FROM sessions WHERE id=?").get(ref) as SessionRow | undefined;
    if (byId) return this.sessionRow(byId);
    const matches = this.catalog
      .prepare("SELECT * FROM sessions WHERE lower(name)=lower(?)")
      .all(ref) as SessionRow[];
    if (matches.length === 1) return this.sessionRow(matches[0]);
    if (matches.length > 1)
      throw new ApiFault("ambiguous", `${matches.length} sessions are named "${ref}"; use the session id`);
    throw notFound(`No session "${ref}" on ${this.name}`);
  }

  harness(row: SessionRow) {
    const h = this.opened.get(row.id)?.harness;
    if (!h) throw new ApiFault("unavailable", this.errors.get(row.id) ?? `Session ${row.name} is unavailable`);
    return h;
  }

  /** `spawnKey` records which tool call created the session, in the same transaction as the session row. */
  async create(body: CreateSessionBody, spawnKey?: string): Promise<SessionSummary> {
    if (typeof body?.name !== "string") throw invalid("name is required");
    if (typeof body.cwd !== "string" || !body.cwd.trim()) throw invalid("cwd is required");
    const path = body.cwd.trim();
    const expanded = path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
    let cwd: string;
    try {
      cwd = await realpath(resolve(this.startDirs[0] ?? homedir(), expanded));
      if (!(await stat(cwd)).isDirectory()) throw Error();
    } catch {
      throw invalid(`cwd must be an existing folder on ${this.name}`);
    }
    const model = this.validateModel(body.model);
    if (body.thinkingLevel !== undefined && !THINKING_LEVELS.includes(body.thinkingLevel))
      throw invalid("Invalid thinking level");
    const id = randomUUID();
    const row: SessionRow = {
      id,
      name: body.name.trim().slice(0, 100) || "Untitled session",
      cwd,
      dbPath: this.sessionDbPath(id),
      createdAt: Date.now(),
      model: model.modelId,
      provider: model.provider,
    };
    await this.openAgent(row, true, body.thinkingLevel ?? "low");
    this.catalog.exec("BEGIN");
    try {
      this.catalog
        .prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?,?)")
        .run(id, row.name, cwd, row.dbPath, row.createdAt, row.model, row.provider);
      if (spawnKey) this.catalog.prepare("INSERT OR REPLACE INTO session_spawns VALUES(?,?)").run(spawnKey, id);
      this.catalog.exec("COMMIT");
    } catch (e) {
      this.catalog.exec("ROLLBACK");
      throw e;
    }
    this.notify();
    await this.ensureTicketScheduler();
    return this.sessionSummary(row);
  }

  /**
   * The start_session tool. A replay of the same tool call (same `key`) finds the session it created, and the first
   * prompt reuses its requestId, so a crash never starts a second session or sends the prompt twice.
   */
  spawnSession: SpawnSession = async (input) => {
    const found = this.catalog.prepare("SELECT sessionId FROM session_spawns WHERE key=?").get(input.key) as
      | { sessionId: string }
      | undefined;
    const existing = found && this.list().find((r) => r.id === found.sessionId);
    const session = existing
      ? await this.sessionSummary(existing)
      : await this.create(
          { name: input.name, cwd: input.cwd, model: input.model, thinkingLevel: input.thinkingLevel },
          input.key,
        );
    if (!input.prompt) return { session };
    const { c } = await this.resolveAgent(session.id, "main");
    const submission = await this.send(session.id, c, { content: input.prompt, requestId: `${input.key}:prompt` });
    return { session, submissionId: submission.id as number };
  };

  rename(row: SessionRow, name: unknown) {
    if (typeof name !== "string" || !name.trim()) throw invalid("A name is required");
    this.catalog.prepare("UPDATE sessions SET name=? WHERE id=?").run(name.trim().slice(0, 100), row.id);
    this.notify();
    return this.sessionSummary(this.row(row.id));
  }

  /** Stop all work, close the harness and move its files to archive/. Nothing is deleted. */
  async archive(row: SessionRow) {
    row = this.sessionRow(row);
    const opened = this.opened.get(row.id);
    if (opened) {
      for (const record of await this.scanAll(opened.harness)) {
        const c = await opened.harness.conversation(record.id, ctx);
        if (c) await c.abort(ctx, { background: true }).catch(() => {});
      }
      opened.unsubscribe();
      try {
        await opened.harness.close(ctx);
      } finally {
        opened.unlock();
      }
      this.opened.delete(row.id);
    }
    await mkdir(this.archiveDir, { recursive: true });
    const target = join(this.archiveDir, `${row.id}-${Date.now()}`);
    try {
      await renamePath(dirname(row.dbPath), target);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    this.catalog.prepare("DELETE FROM conversation_names WHERE sessionId=?").run(row.id);
    this.catalog.prepare("DELETE FROM sessions WHERE id=?").run(row.id);
    this.errors.delete(row.id);
    this.notify();
    await this.ensureTicketScheduler();
    return { archived: target };
  }

  private async openSessionDbPath(id: string, create: boolean) {
    this.sessionDbPath(id);
    const dataRoot = await realpath(this.options.dataDir);
    try {
      const sessionsInfo = await lstat(this.sessionsDir);
      if (!sessionsInfo.isDirectory() && !sessionsInfo.isSymbolicLink())
        throw new Error("Sessions path must be a directory inside the data directory");
    } catch (error) {
      if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(this.sessionsDir, { recursive: true });
    }
    const sessionsRoot = await realpath(this.sessionsDir);
    assertWithinDirectory(dataRoot, sessionsRoot);

    const sessionDir = join(sessionsRoot, id);
    if (create) {
      try {
        await lstat(sessionDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await mkdir(sessionDir, { recursive: true });
      }
    }
    const sessionDirInfo = await lstat(sessionDir);
    if (sessionDirInfo.isSymbolicLink() || !sessionDirInfo.isDirectory())
      throw new Error("Session directory must be a directory inside the data directory");
    const realSessionDir = await realpath(sessionDir);
    assertWithinDirectory(dataRoot, realSessionDir);
    const dbPath = join(realSessionDir, "agent.sqlite");

    const checkFile = async (path: string) => {
      let info;
      try {
        info = await lstat(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
      if (info.isSymbolicLink()) throw new Error("Session database files must not be symbolic links");
      assertWithinDirectory(dataRoot, await realpath(path));
      return true;
    };

    const exists = await checkFile(dbPath);
    if (!create && !exists) await stat(dbPath);
    for (const suffix of ["-wal", "-shm", "-journal", ".lock"]) await checkFile(`${dbPath}${suffix}`);
    // Keep the computed path tied to this Store, never to the catalog's historical absolute dbPath.
    assertWithinDirectory(dataRoot, dbPath);
    return dbPath;
  }

  async openAgent(row: SessionRow, create = false, thinkingLevel: ThinkingLevel = "low") {
    row = this.sessionRow(row);
    const current = this.opened.get(row.id);
    if (current) return current.harness;
    const dbPath = await this.openSessionDbPath(row.id, create);
    const unlock = lockFile(`${dbPath}.lock`);
    try {
      const shellEnv = Object.fromEntries(
        ["PATH", "HOME", "USER", "SHELL", "TMPDIR", "LANG", "TERM"].flatMap((k) =>
          process.env[k] ? [[k, process.env[k]]] : [],
        ),
      );
      const registry = createRegistry();
      registry.install(CodingTools);
      const guardApprovals = this.onboardOptions ? createGuardApprovalHost() : undefined;
      const guards = guardApprovals ? createGuardsExtension(guardApprovals) : undefined;
      const jobs = createJobs({ shared: this.shared, sessionId: row.id, childExtensions: guards ? [guards] : [] });
      const compaction = () => this.compactionOf(row.id);
      const playground = createPlayground(this.shared, row.id, this.spawnSession, jobs);
      registry.install(playground);
      // Custom extensions are installed but not selected: an agent turns them on in its own selection.
      const addons = createAddons({ offline: this.options.provider === "faux", guards });
      for (const extension of addons.list) registry.install(extension);
      const onboardExtensions = this.onboardOptions
        ? installOnboard(registry, this.onboardOptions, {
            childBaseExtensions: [CodingTools],
            guards: guards!,
            shared: this.shared,
            device: this.name,
            nameConversation: (conversationId, name) => this.setAgentName(row, conversationId, name),
            abortTask: (taskId) => this.abortTask(this.harness(row), taskId),
          })
        : [];
      const ticketScheduler = onboardExtensions
        .find((extension) => extension.name === "tickets")
        ?.tasks?.find((task) => task.definition.name === TICKET_SCHEDULER_TASK_NAME);
      const harness = await Harness.open(
        await openNodeSqliteStorage(dbPath),
        {
          models: this.models,
          registry,
          env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? row.cwd, shellEnv }),
          conversationCreated: async (tx, c) => {
            await tx.doc(Workspace, c.id);
            await tx.doc(JobRuns, c.id);
            if (c.owner) {
              const inherited = await tx.doc(ReadOnlyPolicy, c.owner.conversationId);
              const policy = await tx.doc(ReadOnlyPolicy, c.id);
              policy.mode = inherited.mode;
              policy.previousTools = cloneToolSelection(inherited.previousTools);
              if (inherited.mode === "read-only") {
                const agent = await tx.doc(AgentDoc, c.id);
                agent.tools = removeTools(agent.tools, [...WRITE_TOOLS]);
              }
            }
          },
          settings: {
            extensions: [CodingTools, playground, ...onboardExtensions],
            // Read at every use, so a PATCH .../compaction applies from the next request.
            get compaction() {
              return compaction();
            },
            progress: { partialIntervalMs: 100, outputIntervalMs: 100 },
          },
          onReport: (e) => console.error("[durable]", String(e)),
        },
        ctx,
      );
      await harness.root(ctx, {
        agent: {
          cwd: row.cwd,
          model: { provider: row.provider, modelId: row.model },
          thinkingLevel,
        },
      });
      // Migrate and apply durable tool policies before recovery can issue any request.
      for (const record of await this.scanAll(harness)) {
        const conversation = (await harness.conversation(record.id, ctx))!;
        await this.reconcileGuardSelection(harness, conversation);
        await this.reconcileReadOnlyPolicy(harness, conversation, this.onboardOptions !== undefined);
        const previous = (await conversation.agent(ctx)).model;
        const routed = this.routedModel(previous);
        if (previous?.provider !== routed.provider || previous.modelId !== routed.modelId)
          await conversation.configure({ model: routed }, ctx);
      }
      const rootModel = (await (await harness.root(ctx)).agent(ctx)).model!;
      row.provider = rootModel.provider;
      row.model = rootModel.modelId;
      this.catalog.prepare("UPDATE sessions SET provider=?,model=? WHERE id=?").run(row.provider, row.model, row.id);
      const unsubscribe = harness.subscribeCommits(() => this.notify());
      this.opened.set(row.id, { harness, unlock, unsubscribe, jobs, addons, guardApprovals, ticketScheduler });
      this.errors.delete(row.id);
      if (create) harness.resume();
      return harness;
    } catch (e) {
      unlock();
      throw e;
    }
  }

  private async ensureTicketScheduler() {
    if (!this.onboardOptions?.ticketScheduler) return;
    const rows = this.list();
    for (const row of rows) {
      const opened = this.opened.get(row.id);
      if (!opened) continue;
      const root = await opened.harness.root(ctx);
      const active = await root.commit(async (tx) => {
        let page = await tx.scanTasks({ conversationId: root.id }, 500);
        const tasks = [...page.items];
        while (page.next) {
          page = await tx.scanTasks({ conversationId: root.id }, 500, page.next);
          tasks.push(...page.items);
        }
        return tasks.some((task) => task.kind === TICKET_SCHEDULER_TASK_NAME && task.state.status !== "terminal");
      }, ctx);
      if (active) return;
    }
    const host = rows.find((row) => this.opened.get(row.id)?.ticketScheduler);
    const opened = host ? this.opened.get(host.id) : undefined;
    if (!opened?.ticketScheduler) return;
    const root = await opened.harness.root(ctx);
    await root.commit(async (tx) => {
      let page = await tx.scanTasks({ conversationId: root.id }, 500);
      const tasks = [...page.items];
      while (page.next) {
        page = await tx.scanTasks({ conversationId: root.id }, 500, page.next);
        tasks.push(...page.items);
      }
      if (tasks.some((task) => task.kind === TICKET_SCHEDULER_TASK_NAME && task.state.status !== "terminal")) return;
      await tx.createTask(opened.ticketScheduler as never, { device: this.name }, {
        ownership: { kind: "conversation" },
        background: true,
      });
    }, ctx);
  }

  async scanAll(h: Harness): Promise<ConversationRecord[]> {
    return h.commit(async (tx) => {
      let page = await tx.scanConversations({}, 1000);
      const records = [...page.items];
      while (page.next) {
        page = await tx.scanConversations({}, 1000, page.next);
        records.push(...page.items);
      }
      return records;
    }, ctx);
  }

  // ------------------------------------------------------------ agents

  private names(sessionId: string) {
    return new Map(
      (
        this.catalog
          .prepare("SELECT conversationId,name FROM conversation_names WHERE sessionId=?")
          .all(sessionId) as { conversationId: number; name: string }[]
      ).map((r) => [r.conversationId, r.name]),
    );
  }

  private agentRef(record: ConversationRecord, names: Map<number, string>): AgentRef {
    const id = record.id as number;
    const kind = record.parent ? "fork" : record.owner ? "subagent" : "root";
    const custom = names.get(id);
    const derived =
      id === 1 ? "Main" : kind === "fork" ? `Fork #${id}` : kind === "subagent" ? `Subagent #${id}` : `Root #${id}`;
    return {
      id,
      name: custom ?? derived,
      named: custom !== undefined,
      kind,
      ...(record.parent ? { parentId: record.parent.conversationId as number, forkedAt: record.parent.at as number } : {}),
      ...(record.owner
        ? { ownerAgentId: record.owner.conversationId as number, ownerTaskId: record.owner.taskId as number }
        : {}),
    };
  }

  private visibleAgents(agents: AgentSummary[], includeClosed: boolean): AgentSummary[] {
    if (includeClosed) return agents;
    const hidden = new Set(agents.filter((agent) => agent.closed).map((agent) => agent.id));
    let changed = true;
    while (changed) {
      changed = false;
      for (const agent of agents) {
        const parent = agent.parentId ?? agent.ownerAgentId;
        if (parent !== undefined && hidden.has(parent) && !hidden.has(agent.id)) {
          hidden.add(agent.id);
          changed = true;
        }
      }
    }
    return agents.filter((agent) => !hidden.has(agent.id));
  }

  async agents(row: SessionRow, tasks?: TaskNode[], includeClosed = false): Promise<AgentSummary[]> {
    const h = this.harness(row);
    const names = this.names(row.id);
    const records = await this.scanAll(h);
    const live = tasks ?? (await this.liveTasks(h));
    const closeStates = await Promise.all(records.map((record) => h.snapshot(AgentClose, record.id, ctx)));
    const agents = records.map((record, index) => {
      const own = live.filter((t) => t.conversationId === (record.id as number));
      return {
        ...this.agentRef(record, names),
        busy: own.some((t) => !t.background),
        background: own.filter((t) => t.background).length,
        closed: closeStates[index]?.closed ?? false,
      };
    });
    return this.visibleAgents(agents, includeClosed);
  }

  async liveTasks(h: Harness): Promise<TaskNode[]> {
    const graph = await h.taskGraph(ctx);
    try {
      return await this.labelTasks(h, Object.values(graph.value.tasks).map((t) => this.taskNode(t)));
    } finally {
      graph.dispose();
    }
  }

  taskNode(t: unknown): TaskNode {
    const n = t as {
      id: number;
      kind: string;
      conversationId: number;
      owner?: number;
      background: boolean;
      abortRequested?: boolean;
      state: { status: string; phase?: string; on?: readonly number[]; policy?: string; outcome?: string };
      conversations?: readonly number[];
    };
    return {
      id: n.id,
      kind: n.kind,
      conversationId: n.conversationId,
      ...(n.owner !== undefined ? { owner: n.owner } : {}),
      background: !!n.background,
      ...(n.abortRequested ? { aborting: true } : {}),
      state: {
        status: n.state.status,
        ...(n.state.phase ? { phase: n.state.phase } : {}),
        ...(n.state.on ? { on: [...n.state.on] } : {}),
        ...(n.state.policy ? { policy: n.state.policy } : {}),
      },
      conversations: [...(n.conversations ?? [])],
    };
  }

  /** Agent by numeric id, `main`, or unique name (custom or derived, case-insensitive). */
  async resolveAgent(sessionRef: string, agentRef: string): Promise<Resolved> {
    const row = this.resolveSession(sessionRef);
    const h = this.harness(row);
    let id: number | undefined;
    if (/^\d+$/.test(agentRef)) id = Number(agentRef);
    else if (agentRef.toLowerCase() === "main") id = 1;
    else {
      const wanted = agentRef.toLowerCase();
      const names = this.names(row.id);
      const matches = (await this.scanAll(h))
        .map((r) => this.agentRef(r, names))
        .filter((a) => a.name.toLowerCase() === wanted);
      if (matches.length > 1) throw new ApiFault("ambiguous", `${matches.length} agents are named "${agentRef}"`);
      id = matches[0]?.id;
    }
    const c = id === undefined ? undefined : await h.conversation(id as ConversationId, ctx);
    if (!c) throw notFound(`No agent "${agentRef}" in session ${row.name}`);
    return { row, h, c };
  }

  async agentSummary(row: SessionRow, c: Conversation): Promise<AgentSummary> {
    const agents = await this.agents(row, undefined, true);
    return agents.find((a) => a.id === (c.id as number))!;
  }

  /** Every tool of the agent's selected extensions, first definition per name, and the names it is offered. */
  private async toolsOf(c: Conversation) {
    const agent = await c.agent(ctx);
    const all = new Map<string, ToolRegistration>();
    for (const extension of agent.extensions)
      for (const tool of extension.tools ?? []) if (!all.has(tool.name)) all.set(tool.name, tool as ToolRegistration);
    return { agent, all: [...all.values()], offered: new Set(agent.tools.map((t) => t.name)) };
  }

  /** One-time upgrade of pre-guard explicit selections; later opt-outs are recorded in GuardSelectionPolicy. */
  private async reconcileGuardSelection(h: Harness, c: Conversation) {
    if (!this.onboardOptions) return;
    const current = await h.snapshot(GuardSelectionPolicy, c.id, ctx);
    if ((current?.migrationVersion ?? 0) >= GUARD_SELECTION_MIGRATION_VERSION) return;
    await c.commit(async (tx) => {
      const policy = await tx.doc(GuardSelectionPolicy, c.id);
      if (policy.migrationVersion >= GUARD_SELECTION_MIGRATION_VERSION) return;
      const agent = await tx.doc(AgentDoc, c.id);
      if (Array.isArray(agent.extensions) && !agent.extensions.includes("durable-guards"))
        agent.extensions = [...agent.extensions, "durable-guards"];
      policy.migrationVersion = GUARD_SELECTION_MIGRATION_VERSION;
      policy.optedOut = false;
    }, ctx);
  }

  private async recordGuardSelection(c: Conversation, enabled: boolean) {
    await c.commit(async (tx) => {
      const policy = await tx.doc(GuardSelectionPolicy, c.id);
      policy.migrationVersion = GUARD_SELECTION_MIGRATION_VERSION;
      policy.optedOut = !enabled;
    }, ctx);
  }

  private submissionKey(sessionId: string, conversationId: ConversationId, requestId: string) {
    return JSON.stringify([sessionId, conversationId, requestId]);
  }

  private async serializeSubmission<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.submissionTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.submissionTails.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.submissionTails.get(key) === current) this.submissionTails.delete(key);
    }
  }

  private async reconcileReadOnlyPolicy(h: Harness, c: Conversation, migrateLegacy: boolean) {
    const existing = await h.snapshot(ReadOnlyPolicy, c.id, ctx);
    const identity = await h.snapshot(ExpertIdentity, c.id, ctx);
    const excludedTools = Array.isArray(identity?.excludedTools)
      ? identity.excludedTools.filter((name): name is string => typeof name === "string")
      : [];
    if (existing?.mode === "read-write" && excludedTools.length === 0) return;

    const { all } = await this.toolsOf(c);
    const writerNames = all.filter((tool) => WRITE_TOOLS.has(tool.name)).map((tool) => tool.name);
    let previousTools = existing?.mode === "read-only" ? existing.previousTools : undefined;
    let shouldApply = existing?.mode === "read-only";

    if (!shouldApply && migrateLegacy) {
      const agent = await h.snapshot(AgentDoc, c.id, ctx);
      const tools = agent?.tools;
      const legacyWriters = all.filter((tool) => LEGACY_WRITE_TOOLS.has(tool.name)).map((tool) => tool.name);
      if (tools !== undefined && !Array.isArray(tools) && legacyReadOnlySelection(tools, legacyWriters)) {
        shouldApply = true;
        previousTools = {
          kind: "remove",
          names: tools.remove.filter((name) => !LEGACY_WRITE_TOOLS.has(name)),
        };
      }
    }
    if (!shouldApply && excludedTools.length === 0) return;

    await c.commit(async (tx) => {
      const agent = await tx.doc(AgentDoc, c.id);
      const policy = await tx.doc(ReadOnlyPolicy, c.id);
      if (shouldApply && policy.mode !== "read-only") {
        policy.mode = "read-only";
        policy.previousTools = previousTools ?? saveToolSelection(agent.tools);
      }
      const denied = policy.mode === "read-only" ? [...excludedTools, ...writerNames] : excludedTools;
      agent.tools = removeTools(agent.tools, denied);
    }, ctx);
  }

  private async setReadOnlyPolicy(h: Harness, c: Conversation, enabled: boolean) {
    const { all } = await this.toolsOf(c);
    const writerNames = all.filter((tool) => WRITE_TOOLS.has(tool.name)).map((tool) => tool.name);
    const identity = await h.snapshot(ExpertIdentity, c.id, ctx);
    const excludedTools = Array.isArray(identity?.excludedTools)
      ? identity.excludedTools.filter((name): name is string => typeof name === "string")
      : [];
    await c.commit(async (tx) => {
      const agent = await tx.doc(AgentDoc, c.id);
      const policy = await tx.doc(ReadOnlyPolicy, c.id);
      if (enabled) {
        if (policy.mode !== "read-only") policy.previousTools = saveToolSelection(agent.tools);
        policy.mode = "read-only";
        agent.tools = removeTools(agent.tools, writerNames);
      } else if (policy.mode === "read-only") {
        restoreToolSelection(agent, policy.previousTools);
        policy.mode = "read-write";
        policy.previousTools = { kind: "all" };
      } else if (policy.mode === "unset") {
        // Preserve the legacy first-disable behavior when no durable policy exists yet.
        delete agent.tools;
        policy.mode = "read-write";
        policy.previousTools = { kind: "all" };
      }
      agent.tools = removeTools(agent.tools, excludedTools);
    }, ctx);
  }

  async agentDetail(row: SessionRow, c: Conversation): Promise<AgentDetail> {
    const { agent, all, offered } = await this.toolsOf(c);
    const writers = all.filter((t) => WRITE_TOOLS.has(t.name));
    return {
      ...(await this.agentSummary(row, c)),
      sessionId: row.id,
      config: {
        model: agent.model,
        thinkingLevel: agent.thinkingLevel as ThinkingLevel | undefined,
        instructions: agent.instructions,
        cwd: agent.cwd,
        readOnly: writers.length > 0 && writers.every((t) => !offered.has(t.name)),
      },
      tools: all.map((t) => ({
        name: t.name,
        description: t.description,
        replay: (t.replay ?? "unsafe") as "safe" | "unsafe",
        parameters: JSON.parse(JSON.stringify(t.parameters ?? {})),
        writes: WRITE_TOOLS.has(t.name),
        offered: offered.has(t.name),
      })),
      extensions: agent.extensions.map((e) => e.name),
    };
  }

  private validateAgentName(agentId: number, name: unknown): string {
    if (typeof name !== "string" || !name.trim()) throw invalid("A name is required");
    const clean = name.trim().slice(0, 100);
    if (/^\d+$/.test(clean) || clean.toLowerCase() === "main" && agentId !== 1)
      throw invalid("Agent names cannot be numbers or 'main'");
    return clean;
  }

  setAgentName(row: SessionRow, agentId: number, name: unknown) {
    const clean = this.validateAgentName(agentId, name);
    this.catalog
      .prepare(
        "INSERT INTO conversation_names VALUES(?,?,?) ON CONFLICT(sessionId,conversationId) DO UPDATE SET name=excluded.name",
      )
      .run(row.id, agentId, clean);
    this.notify();
  }

  private ownedConversationIds(records: ConversationRecord[], rootId: number): Set<number> {
    const ids = new Set([rootId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const record of records) {
        const id = record.id as number;
        const ownerId = record.owner?.conversationId as number | undefined;
        if (ownerId !== undefined && ids.has(ownerId) && !ids.has(id)) {
          ids.add(id);
          changed = true;
        }
      }
    }
    return ids;
  }

  async setAgentClosed(row: SessionRow, c: Conversation, closed: unknown, abort?: unknown) {
    if (typeof closed !== "boolean") throw invalid("closed must be a boolean");
    if (abort !== undefined && typeof abort !== "boolean") throw invalid("abort must be a boolean");
    if (!closed && abort === true) throw invalid("abort can only be used when closing an agent");
    if (closed && c.id === ROOT_CONVERSATION_ID) throw invalid("The root conversation cannot be closed");

    const h = this.harness(row);
    if (closed) {
      const records = await this.scanAll(h);
      const subtree = this.ownedConversationIds(records, c.id as number);
      const live = await this.liveTasks(h);
      const active = live.filter((task) => subtree.has(task.conversationId));
      if (active.length && abort !== true)
        throw new ApiFault("busy", `Agent ${c.id} has active work; pass { closed: true, abort: true } to stop it before closing`);
      if (abort === true) {
        const ids = [c.id as number, ...[...subtree].filter((id) => id !== (c.id as number)).reverse()];
        for (const id of ids) {
          const conversation = id === (c.id as number) ? c : await h.conversation(id as ConversationId, ctx);
          if (conversation) await conversation.abort(ctx, { background: true });
        }
      }
    }

    await c.commit(async (tx) => {
      const state = await tx.doc(AgentClose, c.id);
      state.closed = closed;
    }, ctx);
    this.notify();
  }

  async patchAgent(row: SessionRow, c: Conversation, body: Record<string, unknown>): Promise<AgentSummary> {
    const name = body.name === undefined ? undefined : this.validateAgentName(c.id as number, body.name);
    if (body.closed === undefined) {
      if (body.abort !== undefined) throw invalid("abort requires closed:true");
      if (name === undefined) throw invalid("A name or closed value is required");
      this.setAgentName(row, c.id as number, name);
    } else {
      await this.setAgentClosed(row, c, body.closed, body.abort);
      if (name !== undefined) this.setAgentName(row, c.id as number, name);
    }
    return this.agentSummary(row, c);
  }

  async createAgent(row: SessionRow, body: { from?: unknown; name?: unknown }) {
    const h = this.harness(row);
    const source = await this.resolveAgent(row.id, String(body.from ?? 1));
    const agent = await source.c.agent(ctx);
    const other = await h.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          model: agent.model,
          cwd: agent.cwd,
          thinkingLevel: agent.thinkingLevel,
          instructions: agent.instructions,
        },
      },
      ctx,
    );
    if (typeof body.name === "string" && body.name.trim()) this.setAgentName(row, other.id as number, body.name);
    this.notify();
    return this.agentSummary(row, other);
  }

  async fork(row: SessionRow, c: Conversation, body: { entryId?: unknown; name?: unknown }) {
    const h = this.harness(row);
    const at = Number(body.entryId);
    if (!Number.isSafeInteger(at)) throw invalid("entryId is required");
    if (body.name !== undefined && typeof body.name !== "string") throw invalid("Invalid fork name");
    const fork = await c.fork(at as EntryId, { ownership: { kind: "ownerless" } }, ctx);
    await this.reconcileReadOnlyPolicy(h, fork, this.onboardOptions !== undefined);
    const agent = await fork.agent(ctx);
    const guard = this.opened.get(row.id)?.addons.all["durable-guards"];
    const extensions = guard && !agent.extensions.some((extension) => extension.name === guard.name)
      ? [...agent.extensions, guard]
      : undefined;
    await fork.configure({ model: this.routedModel(agent.model), ...(extensions ? { extensions } : {}) }, ctx);
    if (guard) await this.recordGuardSelection(fork, true);
    if (typeof body.name === "string" && body.name.trim()) this.setAgentName(row, fork.id as number, body.name);
    this.notify();
    return this.agentSummary(row, fork);
  }

  async configure(row: SessionRow, c: Conversation, body: Record<string, unknown>) {
    const model = body.model === undefined ? undefined : this.validateModel(body.model);
    if (body.thinkingLevel !== undefined && !THINKING_LEVELS.includes(body.thinkingLevel as ThinkingLevel))
      throw invalid("Invalid thinking level");
    if (body.instructions !== undefined && typeof body.instructions !== "string")
      throw invalid("instructions must be a string");
    let cwd: string | undefined;
    if (body.cwd !== undefined) {
      if (typeof body.cwd !== "string") throw invalid("cwd must be a string");
      cwd = (await this.browse(body.cwd)).path;
    }
    if (body.readOnly !== undefined && typeof body.readOnly !== "boolean") throw invalid("readOnly must be a boolean");
    await c.configure(
      {
        ...(model ? { model } : {}),
        ...(body.thinkingLevel ? { thinkingLevel: body.thinkingLevel as ThinkingLevel } : {}),
        ...(typeof body.instructions === "string" ? { instructions: body.instructions.slice(0, 12000) } : {}),
        ...(cwd ? { cwd } : {}),
      },
      ctx,
    );
    if (body.readOnly !== undefined) await this.setReadOnlyPolicy(this.harness(row), c, body.readOnly);
    if (model && (c.id as number) === 1)
      this.catalog.prepare("UPDATE sessions SET model=?,provider=? WHERE id=?").run(model.modelId, model.provider, row.id);
    // Thresholds are shared by the session's agents; refit them when this model's window is too small for them.
    const window = model ? this.windowOf(model.modelId) : 0;
    if (window && !compactionFits(window, this.compactionOf(row.id))) {
      const fitted = defaultCompaction(window);
      this.setCompaction(row, { reserveTokens: fitted.reserveTokens, backgroundTokens: fitted.backgroundTokens });
    }
    this.notify();
    return (await this.agentDetail(row, c)).config;
  }

  private inputSubmission(body: Record<string, unknown>) {
    if (typeof body.content !== "string" || !body.content.trim() || body.content.length > 100000)
      throw invalid("content must be a message under 100,000 characters");
    const whenBusy = (body.whenBusy ?? "followUp") as WhenBusy;
    if (!["steer", "followUp", "reject"].includes(whenBusy)) throw invalid("whenBusy must be followUp, steer or reject");
    if (typeof body.requestId !== "string" || !body.requestId || body.requestId.length > 128)
      throw invalid("requestId is required (≤128 chars) so retries never submit twice");
    return { content: body.content, requestId: body.requestId, whenBusy };
  }

  /** Internal/model-origin sends have no approval capability. */
  async send(sessionId: string, c: Conversation, body: Record<string, unknown>) {
    const input = this.inputSubmission(body);
    const key = this.submissionKey(sessionId, c.id, input.requestId);
    return this.serializeSubmission(key, () => c.submit({ type: "input", ...input }, ctx));
  }

  /** The authenticated HTTP user-message route is the only caller allowed to grant a root-chat approval. */
  async submitAuthenticatedUserMessage(row: SessionRow, c: Conversation, body: Record<string, unknown>) {
    const input = this.inputSubmission(body);
    const approvalHash = c.id === ROOT_CONVERSATION_ID ? commandApprovalFromUserMessage(input.content) : undefined;
    const h = this.harness(row);
    const key = this.submissionKey(row.id, c.id, input.requestId);
    return this.serializeSubmission(key, async () => {
      const existing = await h.commit((tx) => tx.submissionByRequest(c.id, input.requestId), ctx);
      const content = existing || approvalHash || !this.onboardOptions
        ? input.content
        : expandSkillCommand(this.onboardOptions, input.content);
      const submission = await c.submit({ type: "input", ...input, content }, ctx);
      if (!existing && approvalHash) this.opened.get(row.id)?.guardApprovals?.approve(approvalHash, c.id);
      return submission;
    });
  }

  async settled(h: Harness, submissionId: number, waitMs = 0, signal?: AbortSignal): Promise<SendResult> {
    const submission = await h.submission(submissionId as SubmissionId, ctx);
    if (!submission) throw notFound(`No submission ${submissionId}`);
    let record = await submission.status(ctx);
    if (waitMs > 0 && record.status !== "done" && record.status !== "unanswered") {
      const timeout = AbortSignal.timeout(Math.min(waitMs, 300_000));
      const stop = signal ? AbortSignal.any([timeout, signal]) : timeout;
      try {
        record = await submission.wait(withAbortSignal(stop, ctx));
      } catch (e) {
        if (!stop.aborted) throw e;
      }
    }
    if (record.status === "done" && record.answer !== undefined) {
      const entry = await h.commit((tx) => tx.entry(record.answer as EntryId), ctx);
      const text = (entry?.model ?? []).map((m) => messageText(m as never)).join("").trim();
      return { submissionId, status: "done", answer: { entryId: record.answer as number, text } };
    }
    if (record.status === "unanswered") return { submissionId, status: "unanswered", reason: record.reason };
    return { submissionId, status: record.status === "queued" ? "queued" : "pending" };
  }

  async abort(c: Conversation, background: boolean) {
    await c.abort(ctx, { background });
    return { ok: true as const };
  }

  async withdraw(h: Harness, c: Conversation, submissionId: number) {
    return { status: await h.abortSubmission(submissionId as SubmissionId, ctx, c.id) };
  }

  async compact(c: Conversation, instructions?: unknown) {
    return { taskId: (await c.compact(typeof instructions === "string" && instructions.trim() ? instructions : undefined, ctx)) as number };
  }

  async reset(c: Conversation, note?: unknown) {
    await c.reset(typeof note === "string" && note.trim() ? note : undefined, ctx);
    return { ok: true as const };
  }

  async tasks(h: Harness, status: string, limit: number): Promise<TaskOutcome[]> {
    const items = await h.commit(async (tx) => {
      let page = await tx.scanTasks({}, 500);
      let all = [...page.items];
      while (page.next) {
        page = await tx.scanTasks({}, 500, page.next);
        all = [...all, ...page.items].slice(-2000);
      }
      return all;
    }, ctx);
    const wanted = items.filter((t) =>
      status === "terminal" ? t.state.status === "terminal" : t.state.status !== "terminal",
    );
    return wanted.slice(-Math.min(Math.max(limit, 1), 200)).reverse().map((t) => ({
      id: t.id as number,
      kind: (t as { kind?: string }).kind ?? (t as { definition?: string }).definition ?? "task",
      conversationId: (t as { conversationId?: number }).conversationId,
      state: JSON.parse(JSON.stringify(t.state)),
    }));
  }

  async abortTask(h: Harness, taskId: number) {
    const task = await h.getTask(taskId as TaskId, ctx);
    if (!task) throw notFound(`No task ${taskId}`);
    return { status: await h.abortTask(task.id, ctx) };
  }

  async inspect(h: Harness) {
    return h.inspect(ctx);
  }

  async entries(c: Conversation, cursor: string | undefined, limit: number): Promise<Page<WireEntry>> {
    const page = await c.entries({}, Math.min(Math.max(limit, 1), 2000), decodeCursor(cursor), ctx);
    return { items: page.items as unknown as WireEntry[], next: encodeCursor(page.next) };
  }

  async activeEntries(c: Conversation): Promise<WireEntry[]> {
    const view = await c.viewState(ctx);
    try {
      return JSON.parse(JSON.stringify(view.value.entries)) as WireEntry[];
    } finally {
      view.dispose();
    }
  }

  async transcript(c: Conversation, format: string) {
    const items = toTranscript(await this.activeEntries(c));
    return format === "markdown" ? { format: "markdown", text: toMarkdown(items) } : { format: "json", items };
  }

  async preview(row: SessionRow, agentId: number) {
    const h = this.opened.get(row.id)?.harness;
    const c = h ? await h.conversation(agentId as ConversationId, ctx) : undefined;
    if (!c) return undefined;
    return lastAssistantText(await this.activeEntries(c))?.slice(0, 200);
  }

  async inbox(h: Harness, c: Conversation): Promise<InboxItem[]> {
    const doc = await h.snapshot(InboxDoc, c.id, ctx);
    return (doc?.items ?? []).map((item) => {
      if (item.mode === "write") return { id: item.id as number, mode: "write" as const, content: "Context update" };
      const content = item.content as unknown;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.map((b: { type?: string; text?: string }) => (b.type === "text" ? b.text : "")).join("")
            : undefined;
      return { id: item.id as number, mode: item.mode, content: text };
    });
  }

  async agentDoc(h: Harness, c: Conversation, kind: string) {
    const token = AGENT_DOCS[kind as keyof typeof AGENT_DOCS];
    if (!token) throw notFound(`Unknown agent document ${kind}. Known: ${AGENT_DOC_KINDS.join(", ")}`);
    const value = await h.snapshot(token as typeof JobRuns, c.id, ctx);
    return JSON.parse(JSON.stringify(value ?? (kind === JOB_RUNS_DOC ? { counts: {}, items: {} } : {}))) as unknown;
  }

  async deviceDoc(kind: string) {
    if (kind !== "app.shared-state") throw notFound(`Unknown device document ${kind}`);
    const { value, revision } = await this.shared.snapshot();
    return { value, revision };
  }

  async usage(h: Harness): Promise<UsageTotals> {
    return JSON.parse(JSON.stringify(await h.usage(ctx))) as UsageTotals;
  }

  // ------------------------------------------------------------ custom extensions (per agent)

  async extensionsOf(row: SessionRow, c: Conversation): Promise<AgentExtensions> {
    const active = new Set((await c.agent(ctx)).extensions.map((e) => e.name));
    const available = this.opened.get(row.id)?.addons.all ?? {};
    const checked = (await this.harness(row).snapshot(PromptChecklist, c.id, ctx))?.enabled ?? [PROMPTS[0].id];
    return {
      builtIn: [...active].filter((name) => !ADDON_INFO.some((a) => a.name === name)),
      extensions: ADDON_INFO.filter((info) => Object.hasOwn(available, info.name)).map((info) => ({
        ...info,
        enabled: active.has(info.name),
        ...(info.name === "system-prompts"
          ? { prompts: PROMPTS.map(({ id, title, description, text }) => ({ id, title, description, text, enabled: checked.includes(id) })) }
          : {}),
      })),
    };
  }

  /** `{name, enabled}` edits the agent's extension selection; `{prompt, enabled}` edits its prompt checklist. */
  async setExtension(row: SessionRow, c: Conversation, body: Record<string, unknown>) {
    if (typeof body.enabled !== "boolean") throw invalid("enabled must be a boolean");
    const enabled = body.enabled;
    if (typeof body.name === "string") {
      const extension = this.opened.get(row.id)?.addons.all[body.name];
      if (!extension) throw invalid(`Unknown extension ${body.name}. Known: ${ADDON_INFO.map((a) => a.name).join(", ")}`);
      // An array is the agent's whole selection. An { add | remove } object would edit the host default instead and
      // replace the previous edit, so turning one extension on would turn the other off.
      const rank = (name: string) => ADDON_INFO.findIndex((a) => a.name === name);
      const others = (await c.agent(ctx)).extensions.filter((e) => e.name !== extension.name);
      const next = (enabled ? [...others, extension] : others).sort((a, b) => rank(a.name) - rank(b.name));
      await c.configure({ extensions: next }, ctx);
      if (body.name === "durable-guards" && this.onboardOptions)
        await this.recordGuardSelection(c, enabled);
    } else if (typeof body.prompt === "string") {
      const prompt = body.prompt;
      if (!PROMPTS.some((p) => p.id === prompt)) throw invalid(`Unknown prompt ${prompt}. Known: ${PROMPTS.map((p) => p.id).join(", ")}`);
      await c.commit(async (tx) => {
        const doc = await tx.doc(PromptChecklist, c.id);
        const next = new Set(doc.enabled);
        if (enabled) next.add(prompt);
        else next.delete(prompt);
        doc.enabled = PROMPTS.map((p) => p.id).filter((id) => next.has(id));
      }, ctx);
    } else throw invalid("name or prompt is required");
    this.notify();
    return this.extensionsOf(row, c);
  }

  // ------------------------------------------------------------ compaction settings (per session)

  private windowOf(modelId: string) {
    return this.modelList.find((m) => m.id === modelId)?.contextWindow ?? 0;
  }

  /** Saved thresholds, or the defaults for the session model's window (200k background, 250k wait when it fits). */
  compactionOf(sessionId: string): CompactionSettings {
    if (!this.compactions.has(sessionId)) {
      const row = this.catalog.prepare("SELECT settings FROM session_compaction WHERE sessionId=?").get(sessionId) as
        | { settings: string }
        | undefined;
      this.compactions.set(sessionId, row ? (JSON.parse(row.settings) as Partial<CompactionSettings>) : null);
    }
    const saved = this.compactions.get(sessionId);
    if (saved) return { ...DEFAULT_COMPACTION, ...saved };
    const session = this.catalog.prepare("SELECT model FROM sessions WHERE id=?").get(sessionId) as { model: string } | undefined;
    return defaultCompaction(this.windowOf(session?.model ?? ""));
  }

  /** Validate and store new thresholds; pi-durable reads them at its next use, so they apply from the next request. */
  setCompaction(row: SessionRow, body: Record<string, unknown>): CompactionSettings {
    const next = this.compactionOf(row.id);
    const int = (key: "reserveTokens" | "backgroundTokens" | "keepRecentTokens", min: number, max: number) => {
      if (body[key] === undefined) return;
      const n = Number(body[key]);
      if (!Number.isInteger(n) || n < min || n > max) throw invalid(`${key} must be an integer from ${min} to ${max}`);
      next[key] = n;
    };
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") throw invalid("enabled must be a boolean");
      next.enabled = body.enabled;
    }
    int("reserveTokens", 1024, 1_000_000);
    int("backgroundTokens", 0, 1_000_000);
    int("keepRecentTokens", 500, 200_000);
    this.catalog
      .prepare("INSERT INTO session_compaction VALUES(?,?) ON CONFLICT(sessionId) DO UPDATE SET settings=excluded.settings")
      .run(row.id, JSON.stringify(next));
    this.compactions.set(row.id, next);
    this.notify();
    return { ...next };
  }

  /** Name every pi.tool task by its tool and every job run by its title, so a task list reads like the transcript. */
  async labelTasks(h: Harness, nodes: TaskNode[]): Promise<TaskNode[]> {
    return Promise.all(
      nodes.map(async (node) => {
        const key = `${node.conversationId}:${node.id}`;
        let known = this.taskLabels.get(key);
        if (!known) {
          known = await this.taskLabel(h, node).catch(() => undefined);
          if (!known) return node;
          this.taskLabels.set(key, known);
          if (this.taskLabels.size > 5000) this.taskLabels.delete(this.taskLabels.keys().next().value!);
        }
        return { ...node, ...known };
      }),
    );
  }

  private async taskLabel(h: Harness, node: TaskNode): Promise<{ label?: string; callId?: string } | undefined> {
    if (node.kind === TICKET_RUN_TASK_NAME) {
      const task = await h.getTask(node.id as TaskId, ctx);
      const input = task?.input as { ticketId?: string } | undefined;
      return input?.ticketId ? { label: `ticket ${input.ticketId}` } : { label: "ticket" };
    }
    if (node.kind === TICKET_SCHEDULER_TASK_NAME) return { label: "ticket scheduler" };
    if (node.kind === "dpi.reminder") {
      const task = await h.getTask(node.id as TaskId, ctx);
      const input = task?.input as { id?: string } | undefined;
      return { label: input?.id ? `reminder ${input.id}` : "reminder" };
    }
    if (node.kind.startsWith("demo.job.")) {
      const run = (await h.snapshot(JobRuns, node.conversationId as ConversationId, ctx))?.items[String(node.id)];
      const def = jobDef(node.kind.slice("demo.job.".length));
      return def ? { label: run ? `${def.title} #${run.run}` : def.title } : undefined;
    }
    if (node.kind !== "pi.tool") return undefined;
    const task = await h.getTask(node.id as TaskId, ctx);
    const input = task?.input as { assistant?: number; callId?: string } | undefined;
    if (!input?.callId || input.assistant === undefined) return undefined;
    const entry = await h.commit((tx) => tx.entry(input.assistant as EntryId), ctx);
    for (const m of (entry?.model ?? []) as unknown as { role: string; content?: { type: string; id?: string; name?: string }[] }[])
      for (const b of m.role === "assistant" ? (m.content ?? []) : [])
        if (b.type === "toolCall" && b.id === input.callId) return { label: b.name, callId: input.callId };
    return { callId: input.callId };
  }

  // ------------------------------------------------------------ tree

  sessionSummaryBase(row: SessionRow) {
    row = this.sessionRow(row);
    return {
      id: row.id,
      name: row.name,
      cwd: row.cwd,
      model: row.model,
      createdAt: row.createdAt,
      dbPath: row.dbPath,
      compaction: this.compactionOf(row.id),
    };
  }

  async sessionSummary(row: SessionRow, includeClosed = false): Promise<SessionSummary> {
    if (!this.opened.has(row.id))
      return { ...this.sessionSummaryBase(row), busy: false, agents: [], error: this.errors.get(row.id) ?? "Session unavailable" };
    const allAgents = await this.agents(row, undefined, true);
    return {
      ...this.sessionSummaryBase(row),
      busy: allAgents.some((agent) => agent.busy),
      agents: this.visibleAgents(allAgents, includeClosed),
    };
  }

  async tree(includeClosed = false): Promise<DeviceTree> {
    const sessions = await Promise.all(this.list().map((row) => this.sessionSummary(row, includeClosed)));
    return { uid: this.uid, name: this.name, sessions, at: Date.now() };
  }

  // ------------------------------------------------------------ demo extension

  async demoState(c: Conversation, body: Record<string, unknown>) {
    let change = body as unknown as StateChange;
    if (body.operation === undefined) {
      const { value } = await this.shared.snapshot();
      if (typeof body.goal === "string")
        change = { operation: Object.hasOwn(value, "goal") ? "update" : "create", path: "/goal", value: body.goal };
      else if (body.increment === true) change = { operation: "increment", path: "/counter", value: 1 };
      else if (typeof body.note === "string") change = { operation: "create", path: "/notes/-", value: body.note };
      else throw invalid("A state operation is required");
    }
    await this.shared.change(
      change,
      undefined,
      typeof body.expectedRevision === "number" ? body.expectedRevision : undefined,
    );
    await c.commit(
      (tx) =>
        tx.appendEntry(c.id, {
          kind: "demo.state-change",
          data: { text: `Shared App State: ${change.operation} ${change.path || "/"}` },
        }),
      ctx,
    );
    return { ok: true as const, ...(await this.deviceDoc("app.shared-state")) };
  }

  /** Start a durable job from a client: the conversation owns the run, and a transcript entry anchors its card. */
  async startJob(row: SessionRow, h: Harness, c: Conversation, body: Record<string, unknown>) {
    const def = typeof body.job === "string" ? jobDef(body.job) : undefined;
    if (!def) throw invalid(`job must be one of ${JOB_DEFS.map((d) => d.id).join(", ")}`);
    let input;
    try {
      input = resolveJobInput(def, body.input ?? {});
    } catch (e) {
      throw invalid((e as Error).message);
    }
    const jobs = this.opened.get(row.id)?.jobs;
    if (!jobs) throw new ApiFault("unavailable", "Session is not open");
    const taskId = await c.commit(async (tx) => {
      const id = await jobs.start(tx, c.id, { def, input, startedBy: "you", now: Date.now() });
      await tx.appendEntry(c.id, { kind: "demo.job", data: { taskId: id as number, job: def.id, text: `Started ${def.title}` } });
      return id;
    }, ctx);
    h.resume();
    return { taskId: taskId as number };
  }

  async approveJob(c: Conversation, taskId: number, approved: unknown) {
    if (typeof approved !== "boolean") throw invalid("approved must be a boolean");
    await c.commit(async (tx) => {
      const run = (await tx.doc(JobRuns, c.id)).items[String(taskId)];
      if (!run || run.approval !== "pending") throw new ApiFault("conflict", "No pending approval for that run");
      run.approval = approved ? "approved" : "declined";
    }, ctx);
    return { ok: true as const };
  }

  // ------------------------------------------------------------ idempotency

  replay(key: string, route: string) {
    const row = this.catalog.prepare("SELECT * FROM requests WHERE key=?").get(key) as
      | { route: string; status: number; body: string }
      | undefined;
    if (!row) return undefined;
    if (row.route !== route) throw invalid("Idempotency-Key was already used for a different request");
    return { status: row.status, body: JSON.parse(row.body) as unknown };
  }

  remember(key: string, route: string, status: number, body: unknown) {
    this.catalog
      .prepare("INSERT OR IGNORE INTO requests VALUES(?,?,?,?,?)")
      .run(key, route, status, JSON.stringify(body), Date.now());
  }

  // ------------------------------------------------------------ lifecycle

  async close() {
    for (const { harness, unlock, unsubscribe } of this.opened.values()) {
      unsubscribe();
      try {
        await harness.close(ctx);
      } finally {
        unlock();
      }
    }
    this.opened.clear();
    await this.shared?.close();
    this.unlockShared?.();
    this.catalog.close();
    this.unlockCatalog();
  }
}

export type { Resolved };
